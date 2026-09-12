import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContactStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/contact-step';
import { emptyBookingDraft } from '@/lib/booking/draft';

afterEach(cleanup);

function renderContactStep() {
  const onSubmit = vi.fn();
  const onSave = vi.fn();
  const onBack = vi.fn();

  render(
    <ContactStep
      contact={emptyBookingDraft().contact}
      onSave={onSave}
      onBack={onBack}
      onSubmit={onSubmit}
    />,
  );

  return { onSubmit, onSave, onBack, user: userEvent.setup() };
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Prénom/), 'Camille');
  await user.type(screen.getByLabelText(/^Nom/), 'Rakoto');
  await user.type(screen.getByLabelText(/Adresse e-mail/), 'camille@example.test');
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

  it('refuse un numéro national et affiche le message sur le champ', async () => {
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
    await user.click(screen.getByRole('button', { name: /Vérifier ma réservation/ }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('e-mail');
  });
});
