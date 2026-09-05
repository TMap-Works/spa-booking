import type { Appointment, AppointmentStatus } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  buildCalendarBoard,
  cellsInWindow,
  computeSlotWindow,
  shortClientName,
  slotSpanOf,
  statusModifier,
  type CalendarCell,
  type CalendarEventCell,
} from '@/lib/admin/calendar-grid';
import { rangeOf } from '@/lib/admin/calendar-range';

/**
 * La grille du planning (#49, critères 1, 3 et 4).
 *
 * L'établissement de référence est à **Indian/Antananarivo**, UTC+3 sans heure
 * d'été : un rendu qui aurait oublié le fuseau du salon place tout trois heures
 * trop haut, et cela se voit ici sans faire dépendre le test du fuseau de la
 * machine qui l'exécute.
 */

const TIMEZONE = 'Indian/Antananarivo';

let sequence = 0;

function appointment(
  overrides: {
    readonly startsAt: string;
    readonly endsAt: string;
    readonly staff?: { readonly id: string; readonly displayName: string };
    readonly client?: { readonly firstName: string; readonly lastName: string };
    readonly status?: AppointmentStatus;
    readonly serviceName?: string;
  },
): Appointment {
  sequence += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
  const staff = overrides.staff ?? { id: 'staff-hasina', displayName: 'Hasina' };
  const client = overrides.client ?? { firstName: 'Rina', lastName: 'Andriamana' };

  return {
    id,
    status: overrides.status ?? 'confirmed',
    client: { id: `client-${id}`, ...client },
    staff: { id: staff.id, displayName: staff.displayName },
    service: {
      id: `service-${id}`,
      name: overrides.serviceName ?? 'Massage suédois',
      durationMinutes: 60,
      price: { amountMinor: 3500, currency: 'EUR' },
    },
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    price: { amountMinor: 3500, currency: 'EUR' },
    createdAt: '2026-08-01T08:00:00.000Z',
  };
}

function eventsOf(cells: readonly CalendarCell[]): CalendarEventCell[] {
  return cells.filter((cell): cell is CalendarEventCell => cell.kind === 'event');
}

describe('un rendez-vous devient des rangées de 30 minutes', () => {
  it('lit l’instant UTC à l’horloge du salon', () => {
    // 06:00 UTC, c'est 09:00 à Antananarivo : rangée 18, pas rangée 12.
    const span = slotSpanOf(
      appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      TIMEZONE,
    );

    expect(span).toEqual({ day: '2026-08-26', startSlot: 18, endSlot: 20 });
  });

  it('arrondit la fin à la rangée supérieure', () => {
    // 45 minutes occupent deux rangées : la seconde est entamée, donc prise.
    const span = slotSpanOf(
      appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T06:45:00.000Z' }),
      TIMEZONE,
    );

    expect(span.endSlot).toBe(20);
  });

  it('écrête à minuit un soin qui déborde sur le lendemain', () => {
    // Il occupe la fin de cette journée-là, et doit se voir là où il commence —
    // pas disparaître, pas se reporter sur la colonne suivante.
    const span = slotSpanOf(
      appointment({ startsAt: '2026-08-26T19:00:00.000Z', endsAt: '2026-08-26T21:30:00.000Z' }),
      TIMEZONE,
    );

    expect(span).toEqual({ day: '2026-08-26', startSlot: 44, endSlot: 48 });
  });
});

describe('vue jour — une colonne par praticien', () => {
  const hasinaMatin = appointment({
    startsAt: '2026-08-26T06:00:00.000Z',
    endsAt: '2026-08-26T07:00:00.000Z',
  });
  const hasinaMidi = appointment({
    startsAt: '2026-08-26T08:00:00.000Z',
    endsAt: '2026-08-26T09:30:00.000Z',
    status: 'pending',
  });
  const tiana = appointment({
    startsAt: '2026-08-26T06:30:00.000Z',
    endsAt: '2026-08-26T07:30:00.000Z',
    staff: { id: 'staff-tiana', displayName: 'Tiana' },
    client: { firstName: 'Naina', lastName: 'Rabe' },
  });

  const board = buildCalendarBoard({
    view: 'jour',
    range: rangeOf('jour', '2026-08-26'),
    appointments: [tiana, hasinaMidi, hasinaMatin],
    timeZone: TIMEZONE,
  });

  it('cadre la journée de 08 h à 20 h par défaut', () => {
    expect(board.firstSlot).toBe(16);
    expect(board.lastSlot).toBe(40);
    expect(board.slotCount).toBe(24);
    expect(board.hours).toHaveLength(12);
    expect(board.hours[0]).toBe('08 h');
    expect(board.hours.at(-1)).toBe('19 h');
  });

  it('range les colonnes par nom, quel que soit l’ordre d’arrivée', () => {
    // L'ordre d'arrivée changerait la place des colonnes d'un rafraîchissement à
    // l'autre, et l'opérateur cliquerait à côté.
    expect(board.columns.map((column) => column.name)).toEqual(['Hasina', 'Tiana']);
    expect(board.columns.map((column) => column.meta)).toEqual(['2 RDV', '1 RDV']);
    expect(board.appointmentCount).toBe(3);
  });

  it('place chaque bloc à sa rangée et lui donne sa hauteur', () => {
    const hasina = board.columns[0];
    const events = eventsOf(hasina?.cells ?? []);

    // 09:00 → rangée 18, moins la rangée 16 où commence l'affichage : 2.
    expect(events[0]).toMatchObject({ slot: 2, span: 2, lane: 0 });
    expect(events[1]).toMatchObject({ slot: 6, span: 3, lane: 0 });
  });

  it('écrit l’heure, le client et la prestation, dans cet ordre', () => {
    const events = eventsOf(board.columns[0]?.cells ?? []);

    expect(events[0]?.timeLabel).toBe('09:00 – 10:00');
    expect(events[0]?.clientLabel).toBe('Rina Andriamana');
    expect(events[0]?.serviceLabel).toBe('Massage suédois');
  });

  it('remplit de créneaux libres tout ce que rien n’occupe', () => {
    const hasina = board.columns[0];
    const free = (hasina?.cells ?? []).filter((cell) => cell.kind === 'free');

    // 24 rangées affichées, 5 occupées par les deux rendez-vous.
    expect(free).toHaveLength(19);
    // Chaque cellule est unique et couvre une rangée : deux boutons sur la même
    // rangée se recouvriraient, et l'un des deux serait inatteignable.
    expect(new Set(free.map((cell) => cell.slot)).size).toBe(19);
  });

  it('énumère les cellules dans l’ordre chronologique', () => {
    // C'est l'ordre du document, donc l'ordre de tabulation : la journée se
    // parcourt au clavier comme elle se déroule.
    const slots = (board.columns[0]?.cells ?? []).map((cell) => cell.slot);

    expect([...slots].sort((left, right) => left - right)).toEqual(slots);
  });

  it('élargit l’amplitude pour ne rien cacher hors des heures ouvrées', () => {
    const early = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      // 04:00 UTC = 07:00 au salon, avant le cadrage par défaut.
      appointments: [
        appointment({ startsAt: '2026-08-26T04:00:00.000Z', endsAt: '2026-08-26T05:00:00.000Z' }),
      ],
      timeZone: TIMEZONE,
    });

    expect(early.firstSlot).toBe(14);
    expect(early.hours[0]).toBe('07 h');
  });

  it('écarte un rendez-vous qui n’est pas de la journée affichée', () => {
    // Les bornes de la requête sont des dates civiles que le serveur traduit en
    // instants : un soin de la veille au soir peut retomber dedans. Le placer
    // ici ouvrirait une colonne et l'afficherait à la rangée de sa **propre**
    // journée — un rendez-vous d'hier montré à 21 h aujourd'hui.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-25T18:00:00.000Z', endsAt: '2026-08-25T19:00:00.000Z' }),
      ],
      timeZone: TIMEZONE,
    });

    expect(board.columns).toHaveLength(0);
  });

  it('n’ouvre aucune colonne quand la journée est vide', () => {
    const empty = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      timeZone: TIMEZONE,
    });

    expect(empty.columns).toHaveLength(0);
    expect(empty.appointmentCount).toBe(0);
  });
});

describe('vue semaine — une colonne par journée', () => {
  const board = buildCalendarBoard({
    view: 'semaine',
    range: rangeOf('semaine', '2026-08-26'),
    appointments: [
      appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      appointment({
        startsAt: '2026-08-28T06:00:00.000Z',
        endsAt: '2026-08-28T07:00:00.000Z',
        staff: { id: 'staff-tiana', displayName: 'Tiana' },
      }),
    ],
    timeZone: TIMEZONE,
  });

  it('ouvre les sept journées, même celles sans rendez-vous', () => {
    expect(board.columns).toHaveLength(7);
    expect(board.columns.map((column) => column.meta)).toEqual([
      'Aucun rendez-vous',
      'Aucun rendez-vous',
      '1 RDV',
      'Aucun rendez-vous',
      '1 RDV',
      'Aucun rendez-vous',
      'Aucun rendez-vous',
    ]);
  });

  it('range chaque rendez-vous dans la colonne de sa journée, au fuseau du salon', () => {
    // 2026-08-26T06:00Z tombe le 26 à Antananarivo comme à Londres ; ce qui
    // pourrait glisser d'une colonne, c'est un rendez-vous de fin de soirée.
    const mercredi = board.columns[2];

    expect(eventsOf(mercredi?.cells ?? [])).toHaveLength(1);
  });

  it('abrège le client et retire la prestation, faute de largeur', () => {
    const event = eventsOf(board.columns[2]?.cells ?? [])[0];

    expect(event?.timeLabel).toBe('09:00');
    expect(event?.clientLabel).toBe('Rina A.');
    // Émettre un libellé que la CSS masque coûterait un nœud par rendez-vous,
    // sur la vue qui en porte le plus.
    expect(event?.serviceLabel).toBeNull();
  });

  it('range côte à côte deux soins simultanés d’une même journée', () => {
    // Une colonne de la vue semaine agrège toute l'équipe : deux praticiens à la
    // même heure y sont la règle. Empilés, l'un cacherait l'autre.
    const simultanes = buildCalendarBoard({
      view: 'semaine',
      range: rangeOf('semaine', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
        appointment({
          startsAt: '2026-08-26T06:30:00.000Z',
          endsAt: '2026-08-26T07:30:00.000Z',
          staff: { id: 'staff-tiana', displayName: 'Tiana' },
        }),
      ],
      timeZone: TIMEZONE,
    });
    const mercredi = simultanes.columns[2];

    expect(mercredi?.laneCount).toBe(2);
    expect(eventsOf(mercredi?.cells ?? []).map((cell) => cell.lane)).toEqual([0, 1]);
  });

  it('garde un seul couloir quand rien ne se chevauche', () => {
    expect(board.columns.map((column) => column.laneCount)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe('heure courante', () => {
  it('marque la rangée en cours, et elle seule', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      ],
      timeZone: TIMEZONE,
      // 07:40 UTC = 10:40 au salon : rangée 21, à 33 % de sa hauteur.
      now: new Date('2026-08-26T07:40:00.000Z'),
    });
    const marked = (board.columns[0]?.cells ?? []).filter(
      (cell) => cell.kind === 'free' && cell.nowOffset !== null,
    );

    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ slot: 5, nowOffset: '33%' });
  });

  it('ne marque rien un autre jour que celui de la colonne', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      ],
      timeZone: TIMEZONE,
      now: new Date('2026-09-02T07:40:00.000Z'),
    });

    expect(
      (board.columns[0]?.cells ?? []).every((cell) => cell.kind !== 'free' || cell.nowOffset === null),
    ).toBe(true);
  });
});

describe('virtualisation — troisième critère', () => {
  it('monte une fenêtre de repli tant que la mise en page n’est pas mesurée', () => {
    // Rendu serveur, premier rendu client, jsdom : `clientHeight` vaut zéro.
    // Prendre cette valeur au mot ne monterait rien du tout.
    expect(
      computeSlotWindow({ scrollTop: 0, viewportHeight: 0, slotHeight: 0, slotCount: 48 }),
    ).toEqual({ first: 0, last: 12 });
  });

  it('suit le défilement, réserve comprise', () => {
    expect(
      computeSlotWindow({ scrollTop: 300, viewportHeight: 800, slotHeight: 44, slotCount: 48 }),
    ).toEqual({ first: 2, last: 29 });
  });

  it('ne dépasse jamais les bornes de la grille', () => {
    expect(
      computeSlotWindow({ scrollTop: 0, viewportHeight: 4000, slotHeight: 44, slotCount: 24 }),
    ).toEqual({ first: 0, last: 24 });
    expect(
      computeSlotWindow({ scrollTop: 5000, viewportHeight: 800, slotHeight: 44, slotCount: 24 }),
    ).toMatchObject({ last: 24 });
    expect(
      computeSlotWindow({ scrollTop: 0, viewportHeight: 800, slotHeight: 44, slotCount: 0 }),
    ).toEqual({ first: 0, last: 0 });
  });

  it('garde les blocs qui coupent la fenêtre, même commencés au-dessus', () => {
    // Un soin de trois heures commencé avant le haut de l'écran doit rester
    // monté : sinon il disparaît en cours de défilement.
    const cells: CalendarCell[] = [
      { kind: 'free', key: 'a', slot: 0, span: 1, timeLabel: '08 h 00', nowOffset: null },
      { kind: 'free', key: 'b', slot: 4, span: 1, timeLabel: '10 h 00', nowOffset: null },
      { kind: 'free', key: 'c', slot: 20, span: 1, timeLabel: '18 h 00', nowOffset: null },
    ];

    expect(cellsInWindow(cells, { first: 3, last: 10 }).map((cell) => cell.key)).toEqual(['b']);

    const longSoin: CalendarEventCell = {
      kind: 'event',
      key: 'long',
      slot: 0,
      span: 6,
      lane: 0,
      appointment: appointment({
        startsAt: '2026-08-26T05:00:00.000Z',
        endsAt: '2026-08-26T08:00:00.000Z',
      }),
      timeLabel: '08:00 – 11:00',
      clientLabel: 'Ravaka Mamy',
      serviceLabel: 'Rituel corps',
    };

    expect(cellsInWindow([longSoin], { first: 3, last: 10 })).toHaveLength(1);
  });
});

describe('statuts', () => {
  it('traduit le statut du contrat en classe de la feuille de style', () => {
    expect(statusModifier('no_show')).toBe('no-show');
    expect(statusModifier('confirmed')).toBe('confirmed');
  });
});

describe('nom abrégé', () => {
  it('garde le prénom entier et l’initiale du nom', () => {
    expect(shortClientName({ id: 'x', firstName: 'Rina', lastName: 'Andriamana' })).toBe('Rina A.');
  });
});
