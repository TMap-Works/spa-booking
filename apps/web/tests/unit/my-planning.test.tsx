import type { MyStaffAppointment, MyStaffSchedule } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MyAppointmentActions } from '@/app/(admin)/[tenantSlug]/admin/components/my-planning-client';
import {
  agendaDate,
  appointmentsByDay,
  bookedCount,
  clientLabel,
  dayBoundsInTimeZone,
  daysOf,
  mondayOfDate,
  nextAppointment,
  parseMyPlanningView,
  planningRange,
  shiftPlanningAnchor,
  showsToday,
  upcomingOnly,
  workingDay,
} from '@/lib/admin/my-planning';

/**
 * « Mon planning » (#813) — les fenêtres demandées à l'API, les horaires d'une
 * journée, les rendez-vous rangés, et les gestes offerts à la praticienne.
 */

const markStatus = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  markDeskAppointmentStatusAction: (...args: unknown[]) => markStatus(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh, replace: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  markStatus.mockReset();
  refresh.mockReset();
});

const TZ = 'Europe/Paris';

function appointment(overrides: Partial<MyStaffAppointment> = {}): MyStaffAppointment {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    reference: 'RDV-JJH5-96',
    status: 'confirmed',
    startsAt: '2026-09-18T08:00:00.000Z',
    endsAt: '2026-09-18T09:00:00.000Z',
    utcOffsetMinutes: 120,
    service: { id: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Massage suédois', durationMinutes: 60 },
    client: { firstName: 'Rina', lastInitial: 'A' },
    ...overrides,
  };
}

const SCHEDULE: MyStaffSchedule = {
  staffId: 'cccccccc-0000-4000-8000-000000000003',
  timezone: TZ,
  from: '2026-09-14',
  to: '2026-09-20',
  entries: [
    { weekday: 5, startsAt: '14:00', endsAt: '19:00' },
    { weekday: 5, startsAt: '09:00', endsAt: '12:00' },
  ],
  timeOff: [
    {
      id: 'dddddddd-0000-4000-8000-000000000004',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      startsAt: '2026-09-18T14:00:00.000Z',
      endsAt: '2026-09-18T15:00:00.000Z',
      reason: 'Formation',
    },
    {
      id: 'eeeeeeee-0000-4000-8000-000000000005',
      staffId: 'cccccccc-0000-4000-8000-000000000003',
      startsAt: '2026-09-15T10:00:00.000Z',
      endsAt: '2026-09-25T10:00:00.000Z',
      reason: null,
    },
  ],
  closedWeekdays: [7],
};

describe('les vues et leurs fenêtres', () => {
  it('ouvre sur la journée, et ignore une vue inconnue', () => {
    expect(parseMyPlanningView(undefined)).toBe('jour');
    expect(parseMyPlanningView('mois')).toBe('jour');
    expect(parseMyPlanningView('a-venir')).toBe('a-venir');
  });

  it('demande un jour, une semaine du lundi au dimanche, ou 31 jours à venir', () => {
    expect(planningRange('jour', '2026-09-18', '2026-09-18')).toEqual({
      from: '2026-09-18',
      to: '2026-09-18',
    });
    expect(planningRange('semaine', '2026-09-18', '2026-09-18')).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
    });
    expect(planningRange('a-venir', '2026-09-01', '2026-09-18')).toEqual({
      from: '2026-09-18',
      to: '2026-10-18',
    });
  });

  it('avance d’un jour ou d’une semaine', () => {
    expect(shiftPlanningAnchor('jour', '2026-09-18', 1)).toBe('2026-09-19');
    expect(shiftPlanningAnchor('semaine', '2026-09-18', -1)).toBe('2026-09-11');
    expect(mondayOfDate('2026-09-20')).toBe('2026-09-14');
    expect(daysOf('2026-09-14', '2026-09-16')).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
  });
});

describe('les rendez-vous', () => {
  it('se rangent par journée du salon, dans l’ordre de l’heure', () => {
    const late = appointment({ id: 'aaaaaaaa-0000-4000-8000-000000000009', startsAt: '2026-09-18T15:00:00.000Z', endsAt: '2026-09-18T16:00:00.000Z' });
    // 23:30 UTC le 18 est déjà le 19 à Paris.
    const night = appointment({ id: 'aaaaaaaa-0000-4000-8000-000000000010', startsAt: '2026-09-18T23:30:00.000Z', endsAt: '2026-09-19T00:30:00.000Z' });
    const byDay = appointmentsByDay([late, appointment(), night], TZ);

    expect(byDay.get('2026-09-18')?.map((item) => item.startsAt)).toEqual([
      '2026-09-18T08:00:00.000Z',
      '2026-09-18T15:00:00.000Z',
    ]);
    expect(byDay.get('2026-09-19')).toHaveLength(1);
  });

  it('« À venir » écarte les annulés et ce qui est déjà terminé', () => {
    const now = new Date('2026-09-18T10:00:00.000Z');
    const kept = upcomingOnly(
      [
        appointment(),
        appointment({ id: 'x2', startsAt: '2026-09-19T08:00:00.000Z', endsAt: '2026-09-19T09:00:00.000Z' }),
        appointment({ id: 'x3', status: 'cancelled', startsAt: '2026-09-20T08:00:00.000Z', endsAt: '2026-09-20T09:00:00.000Z' }),
      ],
      now,
    );

    expect(kept.map((item) => item.id)).toEqual(['x2']);
  });

  it('nomme la cliente par son prénom et son initiale', () => {
    expect(clientLabel(appointment())).toBe('Rina A.');
  });

  it('désigne le prochain encore attendu, et non le premier de la liste', () => {
    const now = new Date('2026-09-18T10:00:00.000Z');
    // Le 8 h est terminé, le 20 est annulé : c'est le 19 que la praticienne
    // doit voir marqué, même si la liste s'ouvre sur un rendez-vous plus ancien.
    const soonest = nextAppointment(
      [
        appointment(),
        appointment({
          id: 'x3',
          status: 'cancelled',
          startsAt: '2026-09-20T08:00:00.000Z',
          endsAt: '2026-09-20T09:00:00.000Z',
        }),
        appointment({
          id: 'x2',
          startsAt: '2026-09-19T08:00:00.000Z',
          endsAt: '2026-09-19T09:00:00.000Z',
        }),
      ],
      now,
    );

    expect(soonest?.id).toBe('x2');
    expect(nextAppointment([appointment()], new Date('2026-09-30T00:00:00.000Z'))).toBeNull();
  });

  it('ne compte pas les annulés dans la charge d’une période', () => {
    expect(bookedCount([])).toBe(0);
    expect(
      bookedCount([
        appointment(),
        appointment({ id: 'x2', status: 'no_show' }),
        appointment({ id: 'x3', status: 'cancelled' }),
      ]),
    ).toBe(2);
  });
});

describe('la colonne de date de l’agenda', () => {
  it('découpe la journée en jour, quantième et mois, sans l’année', () => {
    // Trois morceaux pour que le quantième se peigne plus gros que le reste, et
    // pour tenir une colonne de neuf rem : « mercredi 23 septembre 2026 » y
    // prenait trois lignes. L'année est portée par la barre de période.
    expect(agendaDate('2026-09-23', { locale: 'fr', countryCode: 'FR' })).toEqual({
      weekday: 'mer.',
      number: '23',
      month: 'sept.',
    });
    expect(agendaDate('2026-09-23', { locale: 'en', countryCode: 'US' })).toEqual({
      weekday: 'Wed',
      number: '23',
      month: 'Sep',
    });
  });

  it('lit la date civile en UTC, pour qu’aucun fuseau ne la décale d’un jour', () => {
    // Le piège de `formatCalendarDate`, repris ici : une date civile est déjà
    // celle de l'établissement. Reprojetée, le 1er septembre lu à Auckland
    // serait déjà le 2, et la colonne annoncerait un jour de plus que les
    // rendez-vous qu'elle coiffe.
    expect(agendaDate('2026-09-01', { locale: 'fr' }).number).toBe('1');
    expect(agendaDate('2026-12-31', { locale: 'fr' })).toEqual({
      weekday: 'jeu.',
      number: '31',
      month: 'déc.',
    });
  });
});

describe('le retour au jour courant', () => {
  it('ne s’offre que si la période affichée ne contient pas déjà aujourd’hui', () => {
    // Le défaut relevé en prenant l'écran en main : ouvert sur aujourd'hui — son
    // état par défaut —, le bouton « Aujourd'hui » pointait la page où l'on
    // était déjà, et le premier clic ne produisait rien.
    expect(showsToday('2026-09-18', '2026-09-18', '2026-09-18')).toBe(true);
    expect(showsToday('2026-09-14', '2026-09-20', '2026-09-18')).toBe(true);
    expect(showsToday('2026-09-14', '2026-09-20', '2026-09-21')).toBe(false);
    expect(showsToday('2026-09-19', '2026-09-19', '2026-09-18')).toBe(false);
  });
});

describe('la journée de travail', () => {
  it('dit ses plages dans l’ordre, et ses absences bornées à la journée', () => {
    const bounds = dayBoundsInTimeZone('2026-09-18', TZ);
    const day = workingDay(SCHEDULE, '2026-09-18', bounds.start, bounds.end);

    expect(day.closed).toBe(false);
    expect(day.hours).toEqual(['09:00 – 12:00', '14:00 – 19:00']);
    expect(day.absences).toEqual(['16:00 – 17:00 · Formation', 'Toute la journée']);
  });

  it('dit le salon fermé un dimanche', () => {
    const bounds = dayBoundsInTimeZone('2026-09-20', TZ);

    expect(workingDay(SCHEDULE, '2026-09-20', bounds.start, bounds.end).closed).toBe(true);
  });

  it('borne la journée de minuit à minuit dans le fuseau du salon', () => {
    const bounds = dayBoundsInTimeZone('2026-09-18', TZ);

    expect(bounds.start.toISOString()).toBe('2026-09-17T22:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-09-18T22:00:00.000Z');
  });
});

describe('les gestes de la praticienne sur son rendez-vous', () => {
  it('ne propose « honoré » qu’une fois le rendez-vous commencé', () => {
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started={false}
        status="confirmed"
        tenantSlug="maison-lotus"
      />,
    );

    expect(screen.queryByRole('button', { name: /honoré/ })).toBeNull();
  });

  it('marque le rendez-vous honoré, puis relit l’écran', async () => {
    markStatus.mockResolvedValue({ ok: true, data: {} });
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started
        status="confirmed"
        tenantSlug="maison-lotus"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(markStatus).toHaveBeenCalledWith('maison-lotus', 'aaaaaaaa-0000-4000-8000-000000000001', {
      status: 'completed',
    });
  });

  it('dit le refus de l’API sans rien relire', async () => {
    markStatus.mockResolvedValue({ ok: false, code: 'FORBIDDEN', message: 'Ce rendez-vous n’est pas le vôtre.' });
    render(
      <MyAppointmentActions
        appointmentId="aaaaaaaa-0000-4000-8000-000000000001"
        started
        status="confirmed"
        tenantSlug="maison-lotus"
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Marquer honoré' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Ce rendez-vous n’est pas le vôtre.');
    expect(refresh).not.toHaveBeenCalled();
  });
});
