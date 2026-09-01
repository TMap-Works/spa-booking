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
    // Le message est rattaché au champ, pas posé en bloc en haut de page.
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-describedby')).toContain(
      message.id,
    );
    expect(screen.getByLabelText(/Téléphone/).getAttribute('aria-invalid')).toBe('true');
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
