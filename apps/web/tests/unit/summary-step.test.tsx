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
      message: 'Ce créneau vient d’être pris.',
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
