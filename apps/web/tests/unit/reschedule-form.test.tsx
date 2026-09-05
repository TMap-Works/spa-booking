import type { AvailabilityResponse } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RescheduleForm } from '@/app/(account)/[tenantSlug]/compte/components/reschedule-form';

/**
 * L'écran de report, une fois que le calendrier écarte le rendez-vous déplacé —
 * #442, deuxième critère.
 *
 * Ce que la page serveur envoie à l'API (`excludeAppointmentId`) se prouve à
 * l'intégration, côté API. Ce qui se prouve **ici** est ce que la liste ainsi
 * élargie devient sous les doigts : les créneaux qui chevauchent le rendez-vous
 * apparaissent, **son heure actuelle comprise** — et cette heure-là ne doit pas
 * pouvoir être choisie, faute de quoi l'écran proposerait de déplacer un
 * rendez-vous là où il est déjà.
 */

const rescheduleOwnAppointmentAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  rescheduleOwnAppointmentAction: (...args: unknown[]) => rescheduleOwnAppointmentAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
}));

const APPOINTMENT_ID = '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60';
const STAFF_ID = '8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const SERVICE_ID = 'b2d5e8a1-9c3f-4d7e-8a2b-6f1c0d3e4a59';

/** L'heure actuelle du rendez-vous — 14:00 UTC, un soin d'une heure. */
const CURRENT_STARTS_AT = '2026-09-01T14:00:00.000Z';

/**
 * La journée telle que l'API la rend **avec** l'exclusion : le créneau actuel,
 * et les deux quarts d'heure qui le chevauchent de part et d'autre.
 *
 * Sans l'exclusion, aucun des trois n'y figurerait — c'est tout le propos du
 * ticket, et c'est ce qui rend ce jeu d'essai représentatif.
 */
const availability: AvailabilityResponse = {
  serviceId: SERVICE_ID,
  timezone: 'UTC',
  days: [
    {
      date: '2026-09-01',
      slots: [
        { startsAt: '2026-09-01T13:45:00.000Z', endsAt: '2026-09-01T14:45:00.000Z', staffId: STAFF_ID },
        { startsAt: CURRENT_STARTS_AT, endsAt: '2026-09-01T15:00:00.000Z', staffId: STAFF_ID },
        { startsAt: '2026-09-01T14:15:00.000Z', endsAt: '2026-09-01T15:15:00.000Z', staffId: STAFF_ID },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  rescheduleOwnAppointmentAction.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

function renderForm(): void {
  render(
    <RescheduleForm
      tenantSlug="salon-des-lilas"
      appointmentId={APPOINTMENT_ID}
      currentStartsAt={CURRENT_STARTS_AT}
      serviceName="Massage suédois"
      availability={availability}
      timeZone="UTC"
    />,
  );
}

describe('report — les créneaux qui chevauchent le rendez-vous déplacé', () => {
  it('propose les quarts d’heure qui chevauchent le rendez-vous', () => {
    renderForm();

    // Le geste que #442 rend atteignable : décaler d'un quart d'heure un soin
    // d'une heure, ce que le calendrier refusait tant qu'il comptait le
    // rendez-vous comme occupant.
    expect(screen.getByRole('button', { name: '13:45' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: '14:15' })).toHaveProperty('disabled', false);
  });

  it('montre l’heure actuelle, la nomme, et ne la laisse pas choisir', () => {
    renderForm();

    const current = screen.getByRole('button', { name: /14:00 \(actuel\)/ });

    // Rendu — le retirer ferait un trou inexplicable dans la journée — mais
    // inerte : « déplacer au 1er septembre 14:00 » un rendez-vous déjà fixé au
    // 1er septembre 14:00 est une phrase qui se contredit.
    expect(current).toHaveProperty('disabled', true);
  });

  it('n’envoie rien tant qu’aucun créneau n’est retenu', () => {
    renderForm();

    expect(screen.getByRole('button', { name: /Choisissez un créneau/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(rescheduleOwnAppointmentAction).not.toHaveBeenCalled();
  });

  it('reporte sur le créneau chevauchant retenu', async () => {
    rescheduleOwnAppointmentAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: '14:15' }));

    const confirm = screen.getByRole('button', { name: /Déplacer au/ });
    await user.click(confirm);

    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledTimes(1);
    expect(rescheduleOwnAppointmentAction).toHaveBeenCalledWith(
      'salon-des-lilas',
      APPOINTMENT_ID,
      { startsAt: '2026-09-01T14:15:00.000Z' },
    );
  });
});
