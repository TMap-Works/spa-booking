import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { emptyBookingDraft } from '@/lib/booking/draft';

afterEach(cleanup);

/**
 * `countryCode` vaut `null` par défaut — l'établissement qui n'a pas publié son
 * adresse (#1028). C'est l'état sous lequel toutes les assertions antérieures
 * ont été écrites : un numéro national y reste refusé, et l'aide y exige
 * l'indicatif. Les cas qui parlent du pays le nomment.
 */
function renderContactStep(countryCode: string | null = null) {
  const onSubmit = vi.fn();
  const onSave = vi.fn();
  const onBack = vi.fn();

  render(
    <ContactStep
      contact={emptyBookingDraft().contact}
      tenantSlug="salon-zen"
      countryCode={countryCode}
      onSave={onSave}
      onBack={onBack}
      onSubmit={onSubmit}
    />,
  );

  return { onSubmit, onSave, onBack, user: userEvent.setup() };
}

/**
 * Ce qu'il faut poser pour que l'étape accepte la soumission.
 *
 * La case de consentement en fait partie depuis #734 : elle est bloquante, et
 * une saisie « valide » qui l'oublierait ne l'est pas. Ce que cette case refuse
 * et ce qu'elle annonce est éprouvé à part, par `booking-consent.test.tsx` —
 * ici elle n'est qu'un préalable, comme le nom et l'adresse.
 */
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
  await user.click(screen.getByRole('checkbox'));
}

describe('la saisie part au brouillon avant la soumission', () => {
  it('verse ce qui a été tapé dès qu’un champ est quitté', async () => {
    const { onSave, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    // Passer au champ suivant suffit : sans ce report, le formulaire étant non
    // contrôlé, la saisie ne vivrait que dans le DOM et un rafraîchissement
    // l'emporterait — le troisième critère de #45 tomberait sur cette étape.
    await user.tab();

    expect(onSave).toHaveBeenCalled();
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ firstName: 'Camille' });
  });

  it('le retour au créneau n’abandonne pas la saisie', async () => {
    const { onSave, onBack, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.click(screen.getByRole('button', { name: /Changer de créneau/ }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls.at(-1)?.[0]).toMatchObject({ firstName: 'Camille' });
  });
});

describe('formulaire de coordonnées', () => {
  it('accepte une saisie valide sans téléphone — l’e-mail est le canal obligatoire', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '',
    });
  });

  it('refuse un numéro national sans pays d’établissement, sur le champ', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '0341234567');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();

    const message = screen.getByRole('alert');

    expect(message.textContent).toContain('format international');
    // #626 — et sans l'indicatif d'aucun pays : un indicatif s'écrit toujours
    // `+` suivi d'un chiffre, et ce motif-là ne doit pas reparaître ici, pas
    // plus le « +261 » d'origine qu'un « +33 » écrit en dur à sa place.
    expect(message.textContent).not.toMatch(/\+\s?\d/);
    // Le message est rattaché au champ, pas posé en bloc en haut de page.
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-describedby')).toContain(
      message.id,
    );
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-invalid')).toBe('true');
  });

  /**
   * #626 — l'aide donnait « Format international, +261… », l'indicatif de
   * Madagascar, à la cliente de n'importe quel salon, y compris lyonnais.
   *
   * Le test porte sur l'**absence d'indicatif**, pas sur la formule retenue :
   * un indicatif de pays s'écrit toujours `+` suivi d'un chiffre, et c'est ce
   * motif-là qui ne doit pas reparaître. Formulé ainsi, il refuserait tout
   * autant un « +33 » écrit en dur — l'autre façon de mal corriger ce ticket.
   *
   * L'autre surface du ticket, le message d'erreur, est gardée par le test
   * ci-dessus, qui la fait déjà apparaître : la redemander ici rejouerait le
   * même formulaire pour la même assertion.
   */
  it('ne donne l’indicatif d’aucun pays dans l’aide du champ', () => {
    renderContactStep();

    const hint = document.getElementById('phone-hint');

    expect(hint?.textContent).toMatch(/format international/);
    expect(hint?.textContent).not.toMatch(/\+\s?\d/);
  });

  /**
   * Le défaut de #1028, vu du formulaire : le tunnel refusait dans le navigateur
   * un numéro que `POST /public/{slug}/appointments` accepte sur le même salon,
   * depuis que la frontière serveur le complète avec `tenants.country_code`.
   *
   * Le test porte sur les deux moitiés de la correction — la soumission passe
   * **et** aucun message n'apparaît —, parce qu'un formulaire qui laisserait
   * soumettre en affichant tout de même son refus serait aussi faux.
   */
  it('accepte un numéro national quand l’établissement a un pays', async () => {
    const { onSubmit, user } = renderContactStep('FR');

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '06 12 34 56 78');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    // Le brouillon conserve la saisie telle qu'elle a été tapée, ici comme
    // ailleurs : la forme E.164 est produite au moment de composer la requête.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ phone: '06 12 34 56 78' });
  });

  /**
   * Le pendant du test de #626 juste au-dessus, sous un pays connu : l'aide
   * cesse d'**exiger** l'indicatif — l'exiger serait devenu faux — sans pour
   * autant donner d'exemple de numéro national, que le contrat refuse d'inventer
   * (en-tête d'`e164PhoneSchemaFor`).
   */
  it('cesse d’exiger l’indicatif dans l’aide quand l’établissement a un pays', () => {
    renderContactStep('FR');

    const hint = document.getElementById('phone-hint');

    expect(hint?.textContent).not.toMatch(/format international, indicatif/);
    expect(hint?.textContent).toMatch(/pays de l’établissement/);
    expect(hint?.textContent).not.toMatch(/\+\s?\d/);
  });

  it('accepte un numéro international écrit avec des espaces', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/Téléphone/), '+261 34 12 345 67');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Le brouillon conserve la saisie telle qu'elle a été tapée : c'est ce que
    // la cliente doit retrouver en revenant en arrière. La normalisation E.164
    // a lieu à la frontière, au moment de composer la requête.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ phone: '+261 34 12 345 67' });
  });

  it('refuse une adresse e-mail mal formée', async () => {
    const { onSubmit, user } = renderContactStep();

    await user.type(screen.getByLabelText(/Prénom/), 'Camille');
    await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
    await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille');
    // Cochée pour que le seul message attendu ci-dessous soit celui de l'adresse.
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('e-mail');
  });
});

/**
 * #748 — « Un mot pour le salon » se saisissait dans un `<input>` d'une ligne,
 * alors que son contrat est `longTextSchema` et que le design system fournit
 * `components/ui/textarea.tsx` pour exactement cet usage. À 360 px, une phrase
 * d'allergie défilait dans le champ : la cliente ne pouvait plus relire le début
 * de ce qu'elle venait d'écrire.
 *
 * Ce qui est éprouvé ici est la **nature du contrôle**, pas sa mise en forme :
 * c'est elle qui décide si la saisie tient sur plusieurs lignes, et c'est la
 * seule chose qu'un `<input>` ne saura jamais faire.
 */
describe('« Un mot pour le salon »', () => {
  function champDuMot(): HTMLTextAreaElement {
    return screen.getByLabelText<HTMLTextAreaElement>(/Un mot pour le salon/);
  }

  it('se saisit dans un champ multiligne du design system', () => {
    renderContactStep();

    const champ = champDuMot();

    expect(champ.tagName).toBe('TEXTAREA');
    // Plus d'une ligne visible : sans cela, le `<textarea>` ferait défiler la
    // saisie tout comme l'`<input>` qu'il remplace, et le ticket ne serait pas
    // traité.
    expect(champ.rows).toBeGreaterThan(1);
    // `TextArea` ne déclare aucun style propre : il porte les classes de
    // `.spa-field`, donc le même cadre et le même contraste que les quatre
    // champs d'une ligne au-dessus de lui.
    expect(champ.className).toContain('spa-field__control');
  });

  it('conserve un mot écrit sur plusieurs lignes jusqu’à la soumission', async () => {
    const { onSubmit, user } = renderContactStep();

    await fillRequiredFields(user);
    await user.type(champDuMot(), 'Allergie aux huiles essentielles.{enter}Je serai peut-être en retard.');
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Le saut de ligne fait foi : un `<input>` l'aurait avalé, et la touche
    // « Entrée » y aurait soumis le formulaire au lieu d'aérer la note.
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      clientNote: 'Allergie aux huiles essentielles.\nJe serai peut-être en retard.',
    });
  });
});
