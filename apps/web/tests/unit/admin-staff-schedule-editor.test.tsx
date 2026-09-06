import type { StaffSchedule } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaffScheduleEditor } from '@/app/(admin)/[tenantSlug]/admin/personnel/components/staff-schedule-editor';

const setStaffScheduleAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/personnel/actions', () => ({
  setStaffScheduleAction: (...args: unknown[]) => setStaffScheduleAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const STAFF_ID = '22222222-2222-4222-8222-222222222222';

const schedule: StaffSchedule = {
  staffId: STAFF_ID,
  timezone: 'Indian/Antananarivo',
  entries: [
    { weekday: 1, startsAt: '09:00', endsAt: '12:30' },
    { weekday: 1, startsAt: '13:30', endsAt: '18:00' },
  ],
};

afterEach(() => {
  cleanup();
  setStaffScheduleAction.mockReset();
  refresh.mockReset();
});

function renderEditor(entries: StaffSchedule['entries'] = schedule.entries): void {
  render(
    <StaffScheduleEditor
      schedule={{ ...schedule, entries }}
      staffId={STAFF_ID}
      tenantSlug="salon-des-lilas"
    />,
  );
}

describe('la grille hebdomadaire — ce qu’elle montre', () => {
  it('dit qu’une journée fermée ne produit aucun créneau', () => {
    // « Fermé le mercredi » et « mercredi pas encore saisi » se ressembleraient
    // sans cette phrase — et c'est la lecture optimiste du silence qui fait
    // proposer un créneau un jour de fermeture.
    renderEditor();

    expect(screen.getAllByText('Fermé — aucun créneau proposé')).toHaveLength(6);
  });

  it('rappelle le fuseau dans lequel les heures se lisent', () => {
    renderEditor();

    expect(screen.getByText(/Indian\/Antananarivo/)).toBeDefined();
  });

  it('affiche le total de la semaine, le repère qui trahit l’oubli', () => {
    renderEditor();

    // 3 h 30 le matin, 4 h 30 l'après-midi.
    expect(screen.getByText(/8 h/)).toBeDefined();
  });
});

describe('la grille hebdomadaire — les gestes', () => {
  it('ouvre un jour fermé en y posant une plage', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText('Ouvert', { selector: '#jour-3' }));

    expect(screen.getAllByText('Fermé — aucun créneau proposé')).toHaveLength(5);
  });

  it('ferme un jour en retirant toutes ses plages', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByLabelText('Ouvert', { selector: '#jour-1' }));

    expect(screen.getAllByText('Fermé — aucun créneau proposé')).toHaveLength(7);
  });

  it('enregistre la semaine entière, y compris les jours vides', async () => {
    // L'API remplace l'ensemble : la seule invariante qui compte — aucune plage
    // ne se recouvre — porte sur la semaine, pas sur une ligne.
    setStaffScheduleAction.mockResolvedValue({ ok: true, data: schedule });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /Enregistrer la semaine/ }));

    expect(setStaffScheduleAction).toHaveBeenCalledWith('salon-des-lilas', STAFF_ID, {
      entries: [
        { weekday: 1, startsAt: '09:00', endsAt: '12:30' },
        { weekday: 1, startsAt: '13:30', endsAt: '18:00' },
      ],
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('refuse un chevauchement sans appeler l’API', async () => {
    // Le verdict est celui du contrat partagé, rejoué côté écran : inutile
    // d'aller chercher un 422 pour l'apprendre.
    const user = userEvent.setup();
    renderEditor([
      { weekday: 1, startsAt: '09:00', endsAt: '13:00' },
      { weekday: 1, startsAt: '12:00', endsAt: '18:00' },
    ]);

    await user.click(screen.getByRole('button', { name: /Enregistrer la semaine/ }));

    expect(setStaffScheduleAction).not.toHaveBeenCalled();
    expect(await screen.findByText(/recouvrent/i)).toBeDefined();
  });

  it('n’enregistre qu’une fois sur un double clic', async () => {
    // web-frontend §3 : un double clic ne produit jamais deux écritures.
    let resolve: ((value: unknown) => void) | undefined;
    setStaffScheduleAction.mockImplementation(
      () =>
        new Promise((settle) => {
          resolve = settle;
        }),
    );
    const user = userEvent.setup();
    renderEditor();

    const button = screen.getByRole('button', { name: /Enregistrer la semaine/ });
    await user.click(button);
    await user.click(button);

    expect(setStaffScheduleAction).toHaveBeenCalledTimes(1);
    resolve?.({ ok: true, data: schedule });
  });

  it('annonce que les créneaux tiennent compte de la semaine enregistrée', async () => {
    setStaffScheduleAction.mockResolvedValue({ ok: true, data: schedule });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /Enregistrer la semaine/ }));

    expect(await screen.findByText(/tiennent compte de cette semaine/i)).toBeDefined();
  });

  it('remonte le refus de l’API sans le faire passer pour une saisie fautive', async () => {
    setStaffScheduleAction.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Deux plages du même jour se recouvrent.',
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: /Enregistrer la semaine/ }));

    expect(await screen.findByText('Semaine non enregistrée')).toBeDefined();
  });

  it('pose minuit de fin de journée là où « 23:59 » perdrait un créneau', async () => {
    setStaffScheduleAction.mockResolvedValue({ ok: true, data: schedule });
    const user = userEvent.setup();
    renderEditor([{ weekday: 5, startsAt: '20:00', endsAt: '22:00' }]);

    await user.click(screen.getAllByLabelText(/minuit/)[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /Enregistrer la semaine/ }));

    expect(setStaffScheduleAction).toHaveBeenCalledWith('salon-des-lilas', STAFF_ID, {
      entries: [{ weekday: 5, startsAt: '20:00', endsAt: '24:00' }],
    });
  });
});
