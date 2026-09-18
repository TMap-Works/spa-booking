import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import type { AccountPresence } from '@/lib/account-presence';
import { emptyBookingDraft, type ContactDraft } from '@/lib/booking/draft';

afterEach(cleanup);

/**
 * Ce qui distingue un rendu d'un autre — tout est facultatif, et chaque défaut
 * est l'état sous lequel les assertions antérieures ont été écrites. Les cas qui
 * s'en écartent le nomment.
 */
interface RenderOptions {
  /**
   * `null` par défaut — l'établissement qui n'a pas publié son adresse (#1028).
   * Un numéro national y reste refusé, et l'aide y annonce le format
   * international.
   */
  readonly countryCode?: string | null;
  /**
   * La cliente connectée, telle que la page l'a lue du cookie de présence
   * (#1050). `null` par défaut : la visiteuse sans compte est l'état sous lequel
   * toutes les assertions antérieures ont été écrites, et le chemin par défaut
   * du CDC §1.4.
   */
  readonly presence?: AccountPresence | null;
  /** Le brouillon déjà posé — vierge sauf mention contraire. */
  readonly contact?: ContactDraft;
}

function renderContactStep({
  countryCode = null,
  presence = null,
  contact = emptyBookingDraft().contact,
}: RenderOptions = {}) {
  const onSubmit = vi.fn();
  const onSave = vi.fn();
  const onBack = vi.fn();

  render(
    <ContactStep
      contact={contact}
      tenantSlug="salon-zen"
      countryCode={countryCode}
      // Le rappel de la barre basse (#1047) : cette suite éprouve la saisie, et
      // rien à rappeler est un état que l'étape sait rendre.
      summary={null}
      presence={presence}
      loginHref="/salon-zen/compte/connexion"
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

/**
 * #1050 — l'étape s'ouvrait sur cinq champs vides à une cliente connectée, dont
 * trois que le compte connaît. `BM-COMPTE-01` demande l'inverse : la cliente
 * connectée doit le savoir, et ne pas retaper ce qu'elle a déjà donné.
 *
 * Ce que cette suite tient, et ce qu'elle laisse dehors :
 *
 * - l'identité du compte est **résumée** et non redemandée — c'est le défaut ;
 * - elle reste **corrigible** : « Modifier » rouvre les deux champs, préremplis,
 *   et le focus les suit ;
 * - la saisie de la cliente **l'emporte** sur le compte : revenir du créneau ne
 *   fait pas repartir un nom corrigé ;
 * - rien ne change pour qui n'est pas connectée, troisième critère du ticket ;
 * - l'adresse e-mail reste à saisir : le cookie de présence ne la porte pas
 *   (`lib/account-presence.ts`), et l'élargir sort de l'empreinte du ticket.
 */
describe('la cliente connectée ne retape pas son nom (#1050)', () => {
  const alice: AccountPresence = { firstName: 'Alice', lastName: 'Marchand' };

  it('résume l’identité du compte au lieu d’en redemander les champs', () => {
    renderContactStep({ presence: alice });

    expect(screen.getByText('Alice Marchand')).toBeDefined();
    // Les champs existent toujours — ils portent la valeur qui sera soumise —
    // mais `hidden` les retire de l'arbre d'accessibilité comme de l'ordre de
    // tabulation : un champ requis invisible et focalisable serait un piège.
    // D'où la recherche par rôle, la seule qui tienne compte de l'accessibilité
    // — `getByLabelText` trouverait un champ que personne ne peut atteindre.
    expect(screen.queryByRole('textbox', { name: /Prénom/ })).toBeNull();
    expect(document.querySelector<HTMLInputElement>('#firstName')?.value).toBe('Alice');
    expect(document.querySelector<HTMLInputElement>('#lastName')?.value).toBe('Marchand');
  });

  it('soumet l’identité du compte sans qu’un seul champ de nom soit touché', async () => {
    const { onSubmit, user } = renderContactStep({ presence: alice });

    await user.type(screen.getByLabelText(/Adresse e-mail/), 'alice@example.test');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      firstName: 'Alice',
      lastName: 'Marchand',
      email: 'alice@example.test',
    });
  });

  it('rouvre les champs préremplis sur « Modifier », et y pose le focus', async () => {
    const { user } = renderContactStep({ presence: alice });

    await user.click(screen.getByRole('button', { name: /Modifier/ }));

    const prenom = screen.getByLabelText<HTMLInputElement>(/Prénom/);

    expect(prenom.value).toBe('Alice');
    expect(screen.getByLabelText<HTMLInputElement>(/^Nom/).value).toBe('Marchand');
    // Le bouton cliqué disparaît avec l'encart : sans ce rattrapage, le focus
    // retomberait sur `<body>` et la tabulation repartirait du haut du document
    // (skill web-frontend §7).
    expect(document.activeElement).toBe(prenom);
    // Et le résumé s'efface : deux réponses à la même question sur un écran en
    // seraient une de trop.
    expect(screen.queryByText('Alice Marchand')).toBeNull();
  });

  it('laisse la saisie de la cliente l’emporter sur le nom du compte', () => {
    // Le brouillon d'une cliente qui a corrigé son nom, puis est repartie
    // changer de créneau : au retour, c'est le sien qu'elle doit retrouver.
    renderContactStep({
      presence: alice,
      contact: { ...emptyBookingDraft().contact, firstName: 'Alix', lastName: 'Marchand' },
    });

    expect(document.querySelector<HTMLInputElement>('#firstName')?.value).toBe('Alix');
    // Et l'encart dit ce qui sera réservé, pas ce que le compte connaît :
    // afficher « Alice Marchand » au-dessus d'un formulaire qui porte « Alix »
    // annoncerait une réservation à un autre nom que celui qui partira.
    expect(screen.getByText('Alix Marchand')).toBeDefined();
    expect(screen.queryByText('Alice Marchand')).toBeNull();
  });

  it('ouvre les champs quand le compte n’a pas de nom de famille', () => {
    // `account-presence.ts` accepte un nom vide là où `nameSchema` l'exige :
    // résumer « Réservé au nom de Alice » cacherait un champ requis derrière un
    // encart qui prétend le remplir, et la soumission échouerait sans rien dire.
    renderContactStep({ presence: { firstName: 'Alice', lastName: '' } });

    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe('Alice');
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
  });

  it('ne change rien pour la réservation sans compte', () => {
    renderContactStep();

    // Deuxième critère du ticket : les cinq champs, et aucun encart d'identité.
    expect(screen.getByLabelText<HTMLInputElement>(/Prénom/).value).toBe('');
    expect(screen.queryByRole('button', { name: /Modifier/ })).toBeNull();
    // À la place, l'entrée de celle qui a déjà un compte (BM-COMPTE-01) — en
    // tête d'étape, avant le premier champ qu'elle évite de remplir.
    expect(
      screen.getByRole('link', { name: /Se connecter/ }).getAttribute('href'),
    ).toBe('/salon-zen/compte/connexion');
  });

  it('ne propose pas de se connecter à qui l’est déjà', () => {
    renderContactStep({ presence: alice });

    expect(screen.queryByRole('link', { name: /Se connecter/ })).toBeNull();
  });
});

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
    const { onSubmit, user } = renderContactStep({ countryCode: 'FR' });

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
    renderContactStep({ countryCode: 'FR' });

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
