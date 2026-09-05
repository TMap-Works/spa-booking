import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SummaryStep } from '@/app/(booking)/[tenantSlug]/reservation/steps/summary-step';

import { contact, service, tenant } from './fixtures';

const bookAppointmentAction = vi.fn();

// Le composant appelle une action serveur ; sous test, c'est un module Next qui
// n'existe pas hors du serveur. On le remplace entièrement — ce qu'on éprouve
// ici est le comportement du bouton, pas le transport.
vi.mock('@/app/(booking)/[tenantSlug]/reservation/actions', () => ({
  bookAppointmentAction: (...args: unknown[]) => bookAppointmentAction(...args),
}));

afterEach(() => {
  cleanup();
  bookAppointmentAction.mockReset();
});

function renderSummary() {
  const onBooked = vi.fn();
  const onSlotLost = vi.fn();

  render(
    <SummaryStep
      tenant={tenant}
      service={service}
      staffId={null}
      startsAt="2026-09-01T06:00:00.000Z"
      contact={contact}
      onBack={vi.fn()}
      onBooked={onBooked}
      onSlotLost={onSlotLost}
    />,
  );

  return { onBooked, onSlotLost };
}

describe('récapitulatif', () => {
  it('affiche l’heure dans le fuseau du salon et le prix de la prestation', () => {
    renderSummary();

    expect(screen.getByText(/09:00/)).toBeDefined();
    expect(screen.getByText(/35,00/)).toBeDefined();
    expect(screen.getByText('camille@example.test')).toBeDefined();
  });

  it('nomme « Premier disponible » quand aucun praticien n’a été choisi', () => {
    renderSummary();

    expect(screen.getByText('Premier disponible')).toBeDefined();
  });
});

describe('le bouton de soumission se désactive dès le premier clic', () => {
  it('ne produit qu’une réservation sur un double clic', async () => {
    // L'action ne se résout jamais : c'est exactement la fenêtre pendant
    // laquelle un visiteur impatient clique une seconde fois.
    bookAppointmentAction.mockReturnValue(new Promise(() => undefined));

    const user = userEvent.setup();
    renderSummary();

    const submit = screen.getByRole('button', { name: /Confirmer la réservation/ });

    await user.click(submit);
    await user.click(submit);

    expect(bookAppointmentAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Réservation en cours/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('remonte le créneau perdu à l’orchestrateur plutôt que d’afficher une panne', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Slot lock 7f3a is already held by another transaction.',
    });

    const user = userEvent.setup();
    const { onSlotLost } = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(onSlotLost).toHaveBeenCalledTimes(1);
    // Sans argument : le message du serveur ne franchit pas cette frontière,
    // c'est le tunnel qui écrit l'explication (#46).
    expect(onSlotLost).toHaveBeenCalledWith();
    // Et rien n'est affiché ici — l'écran de panne dirait le contraire de ce
    // qui se passe : la réservation est reprenable au créneau suivant.
    expect(screen.queryByText('La réservation n’a pas abouti')).toBeNull();
  });

  it('traite un 409 sans message, que l’API a le droit de ne pas remplir', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: '',
    });

    const user = userEvent.setup();
    const { onSlotLost } = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(onSlotLost).toHaveBeenCalledTimes(1);
  });

  it('réarme le bouton après une erreur passagère', async () => {
    bookAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service injoignable.',
    });

    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    expect(screen.getByRole('alert').textContent).toContain('Service injoignable.');
    expect(
      screen.getByRole('button', { name: /Confirmer la réservation/ }),
    ).toHaveProperty('disabled', false);
  });

  it('transmet la réservation sans staffId quand c’est « premier disponible »', async () => {
    bookAppointmentAction.mockResolvedValue({ ok: true, data: { id: 'x' } });

    const user = userEvent.setup();
    renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    const [slug, request] = bookAppointmentAction.mock.calls[0] as [string, Record<string, unknown>];

    expect(slug).toBe('maison-lotus');
    expect(request).not.toHaveProperty('staffId');
    expect(request['client']).toEqual({
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '+261341234567',
    });
  });
});

/**
 * Le second 409 du parcours (#452).
 *
 * `CLIENT_EMAIL_NOT_BOOKABLE` partage son statut avec `SLOT_NO_LONGER_AVAILABLE`
 * et rien d'autre : le créneau perdu se rattrape à l'horaire suivant, celui-ci ne
 * se rattrape qu'en changeant d'adresse. Ce qui se garde ici est donc la
 * **distinction** — et le fait que le message n'apprenne rien de l'annuaire du
 * personnel, la route qui le rend étant publique et non authentifiée.
 */
describe('adresse refusée par la réservation en ligne', () => {
  const refusal = {
    ok: false,
    code: 'CLIENT_EMAIL_NOT_BOOKABLE',
    // Le message du serveur : il ne doit **pas** se retrouver à l'écran, seul le
    // `code` engage l'API (skill web-frontend §2).
    message: 'Cette adresse e-mail ne peut pas être utilisée pour une réservation en ligne.',
  };

  async function refuse() {
    bookAppointmentAction.mockResolvedValue(refusal);

    const user = userEvent.setup();
    const handles = renderSummary();

    await user.click(screen.getByRole('button', { name: /Confirmer la réservation/ }));

    return handles;
  }

  it('ne renvoie pas au calendrier — aucun créneau ne lève ce refus', async () => {
    const { onSlotLost, onBooked } = await refuse();

    expect(onSlotLost).not.toHaveBeenCalled();
    expect(onBooked).not.toHaveBeenCalled();
    // L'étape reste montée : la correction est ici, pas cinq écrans plus loin.
    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toBeDefined();
  });

  it('invite à saisir une autre adresse, sans proposer un autre horaire', async () => {
    await refuse();

    const alert = screen.getByRole('alert').textContent ?? '';

    expect(alert).toMatch(/adresse/i);
    // Ce qui débloque : reprendre ses coordonnées, et le bouton qui y mène est là.
    expect(alert).toMatch(/coordonnées/i);
    expect(screen.getByRole('button', { name: /Corriger mes coordonnées/ })).toHaveProperty(
      'disabled',
      false,
    );
    // Ce qui ne débloque rien, et que le message ne doit donc pas suggérer.
    expect(alert).not.toMatch(/autre (créneau|horaire)/i);
    expect(alert).not.toMatch(/choisir un (créneau|horaire)/i);
  });

  it('n’est pas un oracle sur l’annuaire du personnel', async () => {
    await refuse();

    const alert = screen.getByRole('alert').textContent ?? '';

    // Le refus ne dit jamais *pourquoi* : le nommer ferait de ce formulaire
    // public un moyen de tester, adresse par adresse, qui travaille au salon.
    for (const oracle of [
      /personnel/i,
      /équipe/i,
      /salarié/i,
      /collaborat/i,
      /praticien/i,
      /compte/i,
      /membre/i,
      /déjà (utilisée|prise|enregistrée)/i,
    ]) {
      expect(alert).not.toMatch(oracle);
    }

    // Et il ne recopie pas non plus l'adresse saisie, ni le message du serveur.
    expect(alert).not.toContain('camille@example.test');
    expect(alert).not.toContain(refusal.message);
  });

  it('réarme le bouton, faute de quoi rien ne serait cliquable', async () => {
    await refuse();

    expect(screen.getByRole('button', { name: /Confirmer la réservation/ })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
