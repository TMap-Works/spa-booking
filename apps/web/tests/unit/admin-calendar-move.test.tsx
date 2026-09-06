import type { Appointment, AppointmentStatus, Service } from '@spa/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarBoard } from '@/app/(admin)/[tenantSlug]/admin/components/calendar-board';

/**
 * Le report par glisser-déposer, tel qu'il se manipule (#51).
 *
 * Les quatre critères du ticket sont exercés ici, et l'ordre dans lequel ils
 * s'enchaînent avec : le geste déclenche un **report** et non une mise à jour,
 * l'écran bouge sans attendre, un 409 replace le bloc en le disant, et un
 * changement de praticien se confirme.
 *
 * Le chemin clavier est exercé à égalité du chemin souris — c'est le même
 * `onDrop`, et c'est justement ce qu'il faut prouver : la poignée n'est pas une
 * seconde implémentation qui dériverait à la première correction.
 */

const loadCalendarRangeAction = vi.fn();
const loadDeskServiceStaffAction = vi.fn();
const createDeskAppointmentAction = vi.fn();
const rescheduleDeskAppointmentAction = vi.fn();
const markDeskAppointmentStatusAction = vi.fn();
const searchDeskClientsAction = vi.fn();
const createDeskClientAction = vi.fn();
const replace = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  loadCalendarRangeAction: (...args: unknown[]) => loadCalendarRangeAction(...args),
  loadDeskServiceStaffAction: (...args: unknown[]) => loadDeskServiceStaffAction(...args),
  createDeskAppointmentAction: (...args: unknown[]) => createDeskAppointmentAction(...args),
  rescheduleDeskAppointmentAction: (...args: unknown[]) =>
    rescheduleDeskAppointmentAction(...args),
  markDeskAppointmentStatusAction: (...args: unknown[]) =>
    markDeskAppointmentStatusAction(...args),
  searchDeskClientsAction: (...args: unknown[]) => searchDeskClientsAction(...args),
  createDeskClientAction: (...args: unknown[]) => createDeskClientAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace }),
}));

const TIMEZONE = 'Indian/Antananarivo';
const SLUG = 'maison-lotus';
const HASINA = { id: 'staff-hasina', displayName: 'Hasina' };
const TIANA = { id: 'staff-tiana', displayName: 'Tiana' };

const CATALOGUE: readonly Service[] = [
  {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
  },
];

function appointment(overrides: {
  readonly id?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly staff?: { readonly id: string; readonly displayName: string };
  readonly client?: { readonly firstName: string; readonly lastName: string };
  readonly status?: AppointmentStatus;
}): Appointment {
  const id = overrides.id ?? 'aaaaaaaa-0000-4000-8000-000000000001';
  const client = overrides.client ?? { firstName: 'Rina', lastName: 'Andriamana' };

  return {
    id,
    status: overrides.status ?? 'confirmed',
    client: { id: `client-${id}`, ...client },
    staff: overrides.staff ?? HASINA,
    service: {
      id: 'service-1',
      name: 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-08-01T08:00:00.000Z',
  };
}

/** 09:00 – 10:00 au salon, le mercredi 26 août 2026, chez Hasina. */
const matin = appointment({
  startsAt: '2026-08-26T06:00:00.000Z',
  endsAt: '2026-08-26T07:00:00.000Z',
});

/** La même journée, chez Tiana : de quoi ouvrir une seconde colonne. */
const chezTiana = appointment({
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  startsAt: '2026-08-26T08:00:00.000Z',
  endsAt: '2026-08-26T09:00:00.000Z',
  staff: TIANA,
  client: { firstName: 'Lova', lastName: 'Andrian' },
});

beforeEach(() => {
  loadCalendarRangeAction.mockResolvedValue({ ok: true, data: { appointments: [] } });
});

afterEach(() => {
  cleanup();
  loadCalendarRangeAction.mockReset();
  loadDeskServiceStaffAction.mockReset();
  rescheduleDeskAppointmentAction.mockReset();
  replace.mockReset();
});

function renderBoard(periods: Readonly<Record<string, readonly Appointment[]>>): void {
  render(
    <CalendarBoard
      date="2026-08-26"
      initialPeriods={periods}
      loadError={null}
      services={CATALOGUE}
      tenantSlug={SLUG}
      timeZone={TIMEZONE}
      view="jour"
    />,
  );
}

/** La poignée d'un bloc — le chemin clavier du glissement. */
function grip(client: string): HTMLElement {
  return screen.getByRole('button', { name: `Déplacer ${client}` });
}

/** Un créneau libre, désigné par l'heure civile du salon qu'il porte. */
function slot(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) });
}

describe('le geste déclenche un report — premier critère', () => {
  it('appelle la route de report, jamais une mise à jour des dates', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    await waitFor(() => {
      expect(rescheduleDeskAppointmentAction).toHaveBeenCalledTimes(1);
    });

    // Le corps porte l'heure civile visée avec l'offset du salon, et le
    // praticien de la colonne d'arrivée. C'est `POST /:id/reschedule` que
    // l'action serveur sert — une annulation suivie d'une création liée, côté
    // serveur (booking-engine §5).
    expect(rescheduleDeskAppointmentAction).toHaveBeenCalledWith(SLUG, matin.id, {
      startsAt: '2026-08-26T08:00:00+03:00',
      staffId: HASINA.id,
    });
  });

  it('remplace le bloc par le rendez-vous neuf que le report rend', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    // Le report rend un identifiant neuf : c'est celui-là que l'écran garde, et
    // il s'affiche bien à sa nouvelle heure.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /08:00 – 09:00/ })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /09:00 – 10:00/ })).toBeNull();
  });

  it('ne propose aucune poignée sur un rendez-vous soldé', () => {
    // Le serveur refuserait en `INVALID_STATE_TRANSITION` : une poignée qui mène
    // à un refus est une poignée qui ment.
    renderBoard({
      'jour:2026-08-26': [
        appointment({
          startsAt: '2026-08-26T06:00:00.000Z',
          endsAt: '2026-08-26T07:00:00.000Z',
          status: 'completed',
        }),
      ],
    });

    expect(screen.queryByRole('button', { name: 'Déplacer Rina Andriamana' })).toBeNull();
  });
});

describe('l’état optimiste — deuxième critère', () => {
  it('déplace le bloc avant que le serveur ait répondu', async () => {
    const user = userEvent.setup();
    const attente: { readonly settle?: (value: unknown) => void } = {};

    rescheduleDeskAppointmentAction.mockReturnValue(
      new Promise((settle) => {
        Object.assign(attente, { settle });
      }),
    );
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    // Rien n'a encore été résolu : le bloc est déjà à 08:00, et il annonce son
    // attente.
    const bloc = screen.getByRole('button', { name: /08:00 – 09:00/ });

    expect(bloc.getAttribute('aria-busy')).toBe('true');
    expect(bloc.className).toContain('spa-admin-calendar__event--moving');

    attente.settle?.({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /08:00 – 09:00/ }).getAttribute('aria-busy'),
      ).toBe('false');
    });
  });

  it('ne laisse pas saisir un second rendez-vous pendant que le report est en vol', async () => {
    const user = userEvent.setup();
    const attente: { readonly settle?: (value: unknown) => void } = {};

    rescheduleDeskAppointmentAction.mockReturnValue(
      new Promise((settle) => {
        Object.assign(attente, { settle });
      }),
    );
    renderBoard({ 'jour:2026-08-26': [matin, chezTiana] });

    await user.click(grip('Rina Andriamana'));
    await user.click(screen.getAllByRole('button', { name: /^08 h 00/ })[0] as HTMLElement);

    // `dropOn` refuserait ce second report — un état optimiste de plus sur la
    // même période ne se démêlerait pas au retour arrière. La saisie se ferme
    // donc aussi : sans cela les créneaux s'annonceraient comme des cibles pour
    // un lâcher dont on sait déjà qu'il ne fera rien.
    await user.click(grip('Lova Andrian'));

    expect(grip('Lova Andrian').getAttribute('aria-pressed')).toBe('false');
    expect(
      (screen.getAllByRole('button', { name: /^10 h 00/ })[0] as HTMLElement).textContent,
    ).toContain('poser un rendez-vous');

    attente.settle?.({ ok: false, code: 'CONFLICT', message: 'Créneau pris.' });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
  });

  it('accepte le lâcher de la souris, par le même chemin', async () => {
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    const bloc = screen.getByRole('button', { name: /09:00 – 10:00/ });

    expect(bloc.getAttribute('draggable')).toBe('true');

    // `dataTransfer` est fourni à la main : jsdom n'en construit pas. Ce n'est
    // de toute façon pas lui qui désigne la source — l'état React le fait —,
    // mais `setData` est appelé pour les navigateurs qui l'exigent.
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };

    fireEvent.dragStart(bloc, { dataTransfer });
    fireEvent.drop(slot('08 h 00'), { dataTransfer });

    await waitFor(() => {
      expect(rescheduleDeskAppointmentAction).toHaveBeenCalledTimes(1);
    });
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', matin.id);
  });
});

describe('le retour arrière sur 409 — troisième critère', () => {
  it('replace le rendez-vous à son heure d’origine et dit pourquoi', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_NO_LONGER_AVAILABLE',
      message: 'Créneau pris.',
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    // Le bloc est revenu à 09:00 — et il n'est plus à 08:00.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /09:00 – 10:00/ })).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /08:00 – 09:00/ })).toBeNull();

    // Le retour arrière se **voit** : le bloc le signale, et la bannière dit où
    // il est revenu et pourquoi il n'a pas pu aller ailleurs.
    expect(screen.getByRole('button', { name: /09:00 – 10:00/ }).className).toContain(
      'spa-admin-calendar__event--reverted',
    );

    const alerte = screen.getByRole('alert');

    expect(alerte.textContent).toContain('Créneau déjà pris');
    expect(alerte.textContent).toContain(
      'Le rendez-vous de Rina Andriamana est resté le mercredi 26 août à 09:00',
    );
    expect(alerte.textContent).toContain('chez Hasina');
  });

  it('replace aussi sur un refus qui n’est pas un conflit, avec le motif de l’API', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'SLOT_OUTSIDE_WORKING_HOURS',
      message: 'Hasina ne travaille pas à cette heure-là.',
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Hasina ne travaille pas à cette heure-là.',
      );
    });
    expect(screen.getByRole('button', { name: /09:00 – 10:00/ })).toBeDefined();
  });

  it('renouvelle la session quand le report tombe sur un jeton refusé', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'Votre session a expiré.',
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    await waitFor(() => {
      expect(replace).toHaveBeenCalled();
    });
    // Et le bloc est quand même revenu : la session se renouvelle, le report,
    // non.
    expect(screen.getByRole('button', { name: /09:00 – 10:00/ })).toBeDefined();
  });
});

describe('le changement de praticien se confirme — quatrième critère', () => {
  it('demande confirmation avant d’envoyer, et n’envoie rien tant qu’elle manque', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin, chezTiana] });

    await user.click(grip('Rina Andriamana'));
    // La colonne de Tiana : son créneau de 08 h 00 est libre, celui de Hasina
    // aussi — c'est le second de la journée dans l'ordre du document.
    const cibles = screen.getAllByRole('button', { name: /^08 h 00/ });

    await user.click(cibles[1] as HTMLElement);

    const question = screen.getByRole('alertdialog');

    expect(question.textContent).toContain('Changer de praticien');
    expect(question.textContent).toContain('de Hasina à Tiana');
    expect(rescheduleDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('envoie le report une fois la confirmation donnée', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
        staff: TIANA,
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin, chezTiana] });

    await user.click(grip('Rina Andriamana'));
    await user.click(screen.getAllByRole('button', { name: /^08 h 00/ })[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Confirmer le changement' }));

    await waitFor(() => {
      expect(rescheduleDeskAppointmentAction).toHaveBeenCalledWith(SLUG, matin.id, {
        startsAt: '2026-08-26T08:00:00+03:00',
        staffId: TIANA.id,
      });
    });
  });

  it('remet le rendez-vous en place quand la confirmation est refusée', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin, chezTiana] });

    await user.click(grip('Rina Andriamana'));
    await user.click(screen.getAllByRole('button', { name: /^08 h 00/ })[1] as HTMLElement);
    await user.click(screen.getByRole('button', { name: 'Annuler' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rescheduleDeskAppointmentAction).not.toHaveBeenCalled();
    // Le bloc est revenu chez Hasina, à son heure.
    expect(screen.getByRole('button', { name: /09:00 – 10:00.*Rina Andriamana/s })).toBeDefined();
  });

  it('retire la question — et replace le bloc — quand la période change', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin, chezTiana] });

    await user.click(grip('Rina Andriamana'));
    await user.click(screen.getAllByRole('button', { name: /^08 h 00/ })[1] as HTMLElement);

    expect(screen.getByRole('alertdialog')).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    // Une question posée au-dessus d'un planning qui n'est plus le sien ne peut
    // pas se répondre : elle s'en va, et l'état optimiste avec elle — rien
    // n'était parti vers le serveur.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Jour précédent' }));

    expect(rescheduleDeskAppointmentAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /09:00 – 10:00.*Rina Andriamana/s })).toBeDefined();
  });

  it('ne demande rien d’un report qui reste chez le même praticien', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    await waitFor(() => {
      expect(rescheduleDeskAppointmentAction).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('la saisie au clavier', () => {
  it('annonce le rendez-vous saisi et transforme les créneaux en cibles', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin] });

    expect(slot('08 h 00').textContent).toContain('poser un rendez-vous');

    await user.click(grip('Rina Andriamana'));

    expect(grip('Rina Andriamana').getAttribute('aria-pressed')).toBe('true');
    expect(slot('08 h 00').textContent).toContain(
      'déplacer ici le rendez-vous de Rina Andriamana',
    );
  });

  it('repose le rendez-vous sur Échap, sans rien déplacer', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.keyboard('{Escape}');

    expect(grip('Rina Andriamana').getAttribute('aria-pressed')).toBe('false');
    expect(slot('08 h 00').textContent).toContain('poser un rendez-vous');
    expect(rescheduleDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('repose le rendez-vous quand la poignée est pressée une seconde fois', async () => {
    const user = userEvent.setup();
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(grip('Rina Andriamana'));

    expect(grip('Rina Andriamana').getAttribute('aria-pressed')).toBe('false');
  });

  it('repose le rendez-vous saisi quand la période change', async () => {
    const user = userEvent.setup();
    // Une journée du 27 : sans elle l'écran bascule sur son état vide, et il n'y
    // aurait aucun créneau à viser pour prouver que la saisie est bien reposée.
    const lendemain = appointment({
      id: 'aaaaaaaa-0000-4000-8000-000000000003',
      startsAt: '2026-08-27T06:00:00.000Z',
      endsAt: '2026-08-27T07:00:00.000Z',
      client: { firstName: 'Fara', lastName: 'Rakoto' },
    });

    // Le créneau redevient un créneau de création : c'est le tiroir de #50 qui
    // s'ouvre, et il va chercher les praticiens de la prestation.
    loadDeskServiceStaffAction.mockResolvedValue({ ok: true, data: { staff: [] } });
    renderBoard({ 'jour:2026-08-26': [matin], 'jour:2026-08-27': [lendemain] });

    await user.click(grip('Rina Andriamana'));
    await user.click(screen.getByRole('button', { name: 'Jour suivant' }));

    // Le bloc n'est plus à l'écran : le garder saisi ferait d'un créneau du 27
    // une cible de dépôt pour un rendez-vous du 26, et le lâcher partirait à
    // l'API sans que rien ne bouge — la journée d'origine resterait périmée dans
    // le cache.
    const cible = slot('08 h 00');

    expect(cible.textContent).toContain('poser un rendez-vous');

    await user.click(cible);

    expect(rescheduleDeskAppointmentAction).not.toHaveBeenCalled();
  });

  it('n’ouvre pas le tiroir de création quand un rendez-vous est saisi', async () => {
    const user = userEvent.setup();
    rescheduleDeskAppointmentAction.mockResolvedValue({
      ok: true,
      data: appointment({
        id: 'aaaaaaaa-0000-4000-8000-0000000000ff',
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T06:00:00.000Z',
      }),
    });
    renderBoard({ 'jour:2026-08-26': [matin] });

    await user.click(grip('Rina Andriamana'));
    await user.click(slot('08 h 00'));

    // Le clic déplace : il n'ouvre pas « Nouveau rendez-vous ».
    expect(screen.queryByText('Nouveau rendez-vous')).toBeNull();
    await waitFor(() => {
      expect(rescheduleDeskAppointmentAction).toHaveBeenCalled();
    });
  });
});
