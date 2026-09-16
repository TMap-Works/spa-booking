import type { Appointment, AppointmentStatus, OpeningHoursEntry } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  buildCalendarBoard,
  cellsInWindow,
  computeSlotWindow,
  shortClientName,
  slotSpanOf,
  statusModifier,
  type CalendarCell,
  type CalendarClosedCell,
  type CalendarEventCell,
  type CalendarFreeCell,
  type CalendarGhostCell,
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

function ghostsOf(cells: readonly CalendarCell[]): CalendarGhostCell[] {
  return cells.filter((cell): cell is CalendarGhostCell => cell.kind === 'ghost');
}

function freeOf(cells: readonly CalendarCell[]): CalendarFreeCell[] {
  return cells.filter((cell): cell is CalendarFreeCell => cell.kind === 'free');
}

describe('un rendez-vous devient des rangées de 30 minutes', () => {
  it('lit l’instant UTC à l’horloge du salon', () => {
    // 06:00 UTC, c'est 09:00 à Antananarivo : rangée 18, pas rangée 12.
    const span = slotSpanOf(
      appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      TIMEZONE,
    );

    expect(span).toEqual({
      day: '2026-08-26',
      startSlot: 18,
      endSlot: 20,
      startMinutes: 9 * 60,
      endMinutes: 10 * 60,
    });
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

    expect(span).toEqual({
      day: '2026-08-26',
      startSlot: 44,
      endSlot: 48,
      startMinutes: 22 * 60,
      // Écrêtée à minuit comme `endSlot` : la fin réelle appartient au lendemain.
      endMinutes: 24 * 60,
    });
  });

  it('garde l’heure réelle à côté des rangées, quand elle tombe hors grille', () => {
    // 09:15 → 10:15 : le bloc se cale sur les rangées 18 à 21 (09:00 → 10:30),
    // mais les minutes, elles, restent celles du rendez-vous. C'est ce que le
    // libellé affiche, et c'est tout l'objet de #538.
    const span = slotSpanOf(
      appointment({ startsAt: '2026-08-26T06:15:00.000Z', endsAt: '2026-08-26T07:15:00.000Z' }),
      TIMEZONE,
    );

    expect(span).toEqual({
      day: '2026-08-26',
      startSlot: 18,
      endSlot: 21,
      startMinutes: 9 * 60 + 15,
      endMinutes: 10 * 60 + 15,
    });
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

  it('n’ouvre aucune colonne quand la journée est vide et le répertoire inconnu', () => {
    // Le repli d'avant #507 : sans répertoire, les colonnes se déduisent des
    // seuls rendez-vous. Le planning reste consultable, mais la journée creuse
    // n'offre aucun créneau — c'est pourquoi la page lit `GET /v1/staff`.
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

/**
 * Le premier rendez-vous d'une journée creuse — #507.
 *
 * Le tiroir de création ne s'ouvre que par un clic sur une case libre. Sans
 * colonne, il n'y a pas de case, et le salon ne pouvait pas poser depuis le
 * planning le rendez-vous d'un jour vide — précisément le geste qu'on en attend.
 */
describe('vue jour — le répertoire des praticiens fait les colonnes', () => {
  const REPERTOIRE = [
    { id: 'staff-tiana', displayName: 'Tiana' },
    { id: 'staff-hasina', displayName: 'Hasina' },
  ];

  it('ouvre une colonne de créneaux libres sur une journée sans rendez-vous', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    // Alphabétique, comme les colonnes déduites des rendez-vous : la place d'une
    // colonne ne doit pas dépendre de l'ordre où l'API a rendu les fiches.
    expect(board.columns.map((column) => column.name)).toEqual(['Hasina', 'Tiana']);
    expect(board.columns.map((column) => column.meta)).toEqual([
      'Aucun rendez-vous',
      'Aucun rendez-vous',
    ]);
    expect(board.appointmentCount).toBe(0);
  });

  it('remplit ces colonnes de cases libres cliquables, praticien désigné', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });
    const hasina = board.columns[0];

    // 08 h – 20 h par défaut, soit 24 rangées de 30 minutes, toutes libres.
    expect(hasina?.cells).toHaveLength(board.slotCount);
    expect(hasina?.cells.every((cell) => cell.kind === 'free')).toBe(true);
    // C'est ce couple que le clic transmet au tiroir : la journée du salon et
    // l'heure civile, converties une fois avec le fuseau de l'établissement.
    expect(hasina?.cells[0]).toMatchObject({ kind: 'free', day: '2026-08-26', time: '08:00' });
    // Le praticien de la colonne, que le tiroir propose d'emblée.
    expect(hasina?.staffId).toBe('staff-hasina');
  });

  it('range les rendez-vous du jour dans la colonne de leur praticien', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
      ],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(board.columns.map((column) => column.meta)).toEqual(['1 RDV', 'Aucun rendez-vous']);
    expect(eventsOf(board.columns[0]?.cells ?? [])).toHaveLength(1);
    expect(eventsOf(board.columns[1]?.cells ?? [])).toHaveLength(0);
  });

  it('garde sa colonne à un praticien occupé mais absent du répertoire', () => {
    // Fiche désactivée depuis que le rendez-vous a été posé : le répertoire
    // actif ne la porte plus, et pourtant le rendez-vous existe. Le masquer
    // ferait disparaître de l'écran un soin que le salon doit honorer.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({
          startsAt: '2026-08-26T06:00:00.000Z',
          endsAt: '2026-08-26T07:00:00.000Z',
          staff: { id: 'staff-zo', displayName: 'Zo' },
        }),
      ],
      staff: [{ id: 'staff-hasina', displayName: 'Hasina' }],
      timeZone: TIMEZONE,
    });

    expect(board.columns.map((column) => column.name)).toEqual(['Hasina', 'Zo']);
    expect(board.columns.map((column) => column.meta)).toEqual(['Aucun rendez-vous', '1 RDV']);
  });

  it('ne dédouble pas la colonne d’un praticien qui est dans les deux', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T06:00:00.000Z', endsAt: '2026-08-26T07:00:00.000Z' }),
        appointment({ startsAt: '2026-08-26T08:00:00.000Z', endsAt: '2026-08-26T09:00:00.000Z' }),
      ],
      staff: [{ id: 'staff-hasina', displayName: 'Hasina' }],
      timeZone: TIMEZONE,
    });

    expect(board.columns).toHaveLength(1);
    expect(board.columns[0]?.meta).toBe('2 RDV');
  });

  it('laisse la vue semaine sur ses journées, quel que soit le répertoire', () => {
    const board = buildCalendarBoard({
      view: 'semaine',
      range: rangeOf('semaine', '2026-08-26'),
      appointments: [],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    // Une colonne de la vue semaine est une journée de toute l'équipe : le
    // répertoire n'y a rien à dire, et `staffId` y reste `null` pour que le
    // tiroir laisse choisir plutôt que de deviner.
    expect(board.columns).toHaveLength(7);
    expect(board.columns.every((column) => column.staffId === null)).toBe(true);
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
      { kind: 'free', key: 'a', slot: 0, span: 1, timeLabel: '08 h 00', day: '2026-08-26', time: '08:00', nowOffset: null },
      { kind: 'free', key: 'b', slot: 4, span: 1, timeLabel: '10 h 00', day: '2026-08-26', time: '10:00', nowOffset: null },
      { kind: 'free', key: 'c', slot: 20, span: 1, timeLabel: '18 h 00', day: '2026-08-26', time: '18:00', nowOffset: null },
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

describe('un rendez-vous hors grille dit son heure, pas celle de sa rangée (#538)', () => {
  // Toutes les autres fixtures de ce fichier commencent pile sur la grille —
  // 09:00, 10:00, 08:00. `Math.floor` et `Math.ceil` n'y déplacent jamais rien,
  // et le défaut y était donc invisible. Il n'a été vu qu'en CI, parce que le
  // parcours critique réserve le premier créneau libre : rouge quand l'heure
  // du jour le faisait tomber entre deux rangées, vert le reste du temps.
  const horsGrille = appointment({
    // 06:15 UTC = 09:15 à Antananarivo, pour un soin d'une heure.
    startsAt: '2026-08-26T06:15:00.000Z',
    endsAt: '2026-08-26T07:15:00.000Z',
  });

  it('affiche « 09:15 – 10:15 » en vue jour, et non les bornes de la grille', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [horsGrille],
      timeZone: TIMEZONE,
    });
    const event = eventsOf(board.columns[0]?.cells ?? [])[0];

    expect(event?.timeLabel).toBe('09:15 – 10:15');
  });

  it('cale malgré tout le bloc sur la grille — le dessin, lui, ne ment pas', () => {
    // Le libellé porte l'heure réelle ; la géométrie reste sur les rangées,
    // faute de quoi le bloc ne s'alignerait sur rien. Rangée 18 (09:00) à 21
    // (10:30), soit 2 rangées après la première affichée, sur 3 de haut.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [horsGrille],
      timeZone: TIMEZONE,
    });
    const event = eventsOf(board.columns[0]?.cells ?? [])[0];

    expect(event).toMatchObject({ slot: 2, span: 3 });
  });

  it('affiche « 09:15 » en vue semaine', () => {
    const board = buildCalendarBoard({
      view: 'semaine',
      range: rangeOf('semaine', '2026-08-26'),
      appointments: [horsGrille],
      timeZone: TIMEZONE,
    });
    const event = eventsOf(board.columns[2]?.cells ?? [])[0];

    expect(event?.timeLabel).toBe('09:15');
  });
});

/**
 * Les heures que le salon n'ouvre pas — #752.
 *
 * Le planning peignait chaque rangée de son amplitude comme un créneau libre,
 * jours de fermeture compris, là où le moteur refuse tout ce qui tombe hors des
 * fenêtres de travail (`booking-engine` §3, étape 2 : les horaires du personnel,
 * moins les congés, moins les jours de fermeture du tenant). Ces rangées-là
 * deviennent le fond inactif nommé de `mockups/admin/calendrier.html`.
 */
describe('les horaires d’ouverture ferment les rangées qu’ils ne couvrent pas', () => {
  /** Spa Lumière : du lundi au vendredi, 09:00–13:00 puis 14:00–19:00. */
  const SEMAINE: readonly OpeningHoursEntry[] = ([1, 2, 3, 4, 5] as const).flatMap((weekday) => [
    { weekday, opensAt: '09:00', closesAt: '13:00' },
    { weekday, opensAt: '14:00', closesAt: '19:00' },
  ]);

  const HASINA = { id: 'staff-hasina', displayName: 'Hasina' };
  const REPERTOIRE = [HASINA];

  /** Les cellules fermées d'une colonne, dans l'ordre chronologique. */
  function closedOf(cells: readonly CalendarCell[]): CalendarClosedCell[] {
    return cells.filter((cell): cell is CalendarClosedCell => cell.kind === 'closed');
  }

  /**
   * La clé React attendue d'une cellule fermée — **composée**, jamais écrite.
   *
   * `key: closedKey(16)` en toutes lettres déclenche la règle
   * `generic-api-key` de gitleaks : une propriété nommée `key`, une valeur à
   * entropie suffisante, et la barrière de sécurité de la CI bloque la PR sur un
   * faux positif. La composer dit exactement la même chose — c'est bien la forme
   * que `buildColumn` produit, `ferme-<colonne>-<rangée absolue>` — et ne
   * ressemble plus à un secret.
   */
  const closedKey = (slot: number): string => `ferme-col-${HASINA.id}-${String(slot)}`;

  /** Mercredi 26 août 2026 — une journée ouverte, avec sa coupure méridienne. */
  const mercredi = buildCalendarBoard({
    view: 'jour',
    range: rangeOf('jour', '2026-08-26'),
    appointments: [],
    openingHours: SEMAINE,
    staff: REPERTOIRE,
    timeZone: TIMEZONE,
  });

  it('fusionne les rangées fermées en trois blocs nommés', () => {
    // Amplitude 08 h – 20 h : une heure avant l'ouverture, une heure de coupure,
    // une heure après la fermeture. Un libellé par demi-heure serait illisible.
    expect(closedOf(mercredi.columns[0]?.cells ?? [])).toEqual([
      {
        kind: 'closed',
        key: closedKey(16),
        slot: 0,
        span: 2,
        label: 'Hors horaires',
        nowOffset: null,
      },
      {
        kind: 'closed',
        key: closedKey(26),
        slot: 10,
        span: 2,
        label: 'Pause',
        nowOffset: null,
      },
      {
        kind: 'closed',
        key: closedKey(38),
        slot: 22,
        span: 2,
        label: 'Hors horaires',
        nowOffset: null,
      },
    ]);
  });

  it('ne laisse libres que les rangées que le salon ouvre vraiment', () => {
    const free = (mercredi.columns[0]?.cells ?? []).filter((cell) => cell.kind === 'free');

    // 09:00 → 12:30 et 14:00 → 18:30, soit 8 + 10 rangées de départ possibles.
    expect(free).toHaveLength(18);
    expect(free[0]).toMatchObject({ time: '09:00' });
    expect(free.at(-1)).toMatchObject({ time: '18:30' });
    // La rangée de 18:30 est la dernière : à 19:00 le salon ferme, et une
    // prestation ne peut plus y commencer.
    expect(free.some((cell) => cell.kind === 'free' && cell.time === '19:00')).toBe(false);
  });

  it('ferme la journée entière un jour absent des horaires', () => {
    // Dimanche 30 août. Un jour absent d'une semaine renseignée est un jour de
    // fermeture — la lecture qu'en font déjà la vitrine publique et les réglages.
    const dimanche = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-30'),
      appointments: [],
      openingHours: SEMAINE,
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });
    const colonne = dimanche.columns[0];

    expect(colonne?.cells).toEqual([
      {
        kind: 'closed',
        key: closedKey(16),
        slot: 0,
        span: 24,
        label: 'Fermé',
        nowOffset: null,
      },
    ]);
    expect(colonne?.meta).toBe('Fermé');
  });

  it('ne ferme rien quand le salon n’a saisi aucun horaire', () => {
    // « Le salon ferme tous les jours » et « le salon n'a rien saisi » sont deux
    // états différents, et un seul autorise à peindre une fermeture.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-30'),
      appointments: [],
      openingHours: [],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(closedOf(board.columns[0]?.cells ?? [])).toHaveLength(0);
    expect(board.columns[0]?.meta).toBe('Aucun rendez-vous');
  });

  it('élargit l’amplitude aux heures d’ouverture, sans jamais la resserrer', () => {
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      openingHours: [{ weekday: 3, opensAt: '07:00', closesAt: '21:00' }],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(board.firstSlot).toBe(14);
    expect(board.lastSlot).toBe(42);
    // Et l'inverse : des horaires étroits ne masquent pas le reste de la
    // journée, ils le peignent en fond inactif.
    expect(mercredi.firstSlot).toBe(16);
    expect(mercredi.lastSlot).toBe(40);
  });

  it('garde visible — et intact — un rendez-vous posé hors horaires', () => {
    // Le cas qui interdit de masquer les rangées fermées : un rendez-vous de
    // 07 h un jour ouvert à 09 h existe, et le salon doit l'honorer.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [
        appointment({ startsAt: '2026-08-26T04:00:00.000Z', endsAt: '2026-08-26T05:00:00.000Z' }),
      ],
      openingHours: SEMAINE,
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });
    const cells = board.columns[0]?.cells ?? [];

    expect(board.firstSlot).toBe(14);
    expect(eventsOf(cells)[0]).toMatchObject({ slot: 0, span: 2 });
    // La fermeture reprend là où le rendez-vous s'arrête : 08 h → 09 h.
    expect(closedOf(cells)[0]).toMatchObject({ slot: 2, span: 2, label: 'Hors horaires' });
    expect(board.columns[0]?.meta).toBe('1 RDV');
  });

  it('ne coupe pas une journée décrite en deux plages adjacentes', () => {
    // « 09:00–12:00 » et « 12:00–19:00 » sont une journée continue en deux
    // morceaux — le contrat tolère l'adjacence. Une « Pause » de hauteur nulle
    // n'aurait rien à dire.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      openingHours: [
        { weekday: 3, opensAt: '12:00', closesAt: '19:00' },
        { weekday: 3, opensAt: '09:00', closesAt: '12:00' },
      ],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(closedOf(board.columns[0]?.cells ?? []).map((cell) => cell.label)).toEqual([
      'Hors horaires',
      'Hors horaires',
    ]);
  });

  it('lit « 24:00 » comme la fin de la journée, et non comme une heure illisible', () => {
    // `scheduleEndTimeSchema` l'admet en borne haute : c'est ainsi qu'un salon
    // ouvert jusqu'à minuit s'écrit. Le refuser aurait fermé sa soirée entière.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      openingHours: [{ weekday: 3, opensAt: '18:00', closesAt: '24:00' }],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(board.lastSlot).toBe(48);
    expect(closedOf(board.columns[0]?.cells ?? [])).toEqual([
      {
        kind: 'closed',
        key: closedKey(16),
        slot: 0,
        span: 20,
        label: 'Hors horaires',
        nowOffset: null,
      },
    ]);
  });

  it('pose le trait d’heure courante sur une fermeture, et à sa vraie hauteur', () => {
    // Le trait ne vivait que sur les créneaux libres : un dimanche fermé, une
    // coupure méridienne ou une soirée close le faisaient disparaître — c'est-à-
    // dire la moitié des moments où l'on regarde le planning. Le pourcentage
    // porte sur le bloc fusionné entier, pas sur une demi-heure.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-30'),
      appointments: [],
      openingHours: SEMAINE,
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
      // 07:40 UTC = 10:40 au salon. Le bloc va de 08 h à 20 h : 160 minutes
      // écoulées sur 720, soit 22 %.
      now: new Date('2026-08-30T07:40:00.000Z'),
    });

    expect(closedOf(board.columns[0]?.cells ?? [])[0]).toMatchObject({
      span: 24,
      nowOffset: '22%',
    });
  });

  it('ne ferme rien quand aucune plage saisie ne se lit', () => {
    // Des plages toutes illisibles ne disent pas « fermé sept jours sur sept » :
    // elles ne disent rien. Les traiter comme une semaine close aurait retiré au
    // salon son seul point d'entrée vers le tiroir, sur la donnée la moins sûre.
    const board = buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-08-26'),
      appointments: [],
      openingHours: [{ weekday: 3, opensAt: '10:00', closesAt: '09:00' }],
      staff: REPERTOIRE,
      timeZone: TIMEZONE,
    });

    expect(closedOf(board.columns[0]?.cells ?? [])).toHaveLength(0);
    expect(board.columns[0]?.meta).toBe('Aucun rendez-vous');
  });

  it('ferme les colonnes de week-end de la vue semaine', () => {
    const board = buildCalendarBoard({
      view: 'semaine',
      range: rangeOf('semaine', '2026-08-26'),
      appointments: [],
      openingHours: SEMAINE,
      timeZone: TIMEZONE,
    });

    // Sept colonnes, du lundi 24 au dimanche 30.
    expect(board.columns).toHaveLength(7);
    expect(board.columns.map((column) => column.meta)).toEqual([
      'Aucun rendez-vous',
      'Aucun rendez-vous',
      'Aucun rendez-vous',
      'Aucun rendez-vous',
      'Aucun rendez-vous',
      'Fermé',
      'Fermé',
    ]);
    // Samedi et dimanche : pas une seule cellule libre, là où la vue semaine en
    // offrait 48 sur ces deux journées.
    for (const index of [5, 6]) {
      const cells = board.columns[index]?.cells ?? [];

      expect(cells.filter((cell) => cell.kind === 'free')).toHaveLength(0);
      expect(closedOf(cells)).toHaveLength(1);
    }
  });
});

/**
 * Un rendez-vous soldé n'occupe plus son créneau — #753.
 *
 * Le tableau du cycle de vie porte « Occupe le créneau : non » pour `completed`,
 * `cancelled` et `no_show` ; la contrainte d'exclusion les laisse hors de son
 * prédicat partiel, et le calcul des créneaux libres ne retranche que les
 * `pending` et les `confirmed` (`booking-engine` §1, §3, §5). L'après-midi
 * relevé par l'audit est celui de la preuve : deux annulés qui se chevauchent, et
 * pas une cellule libre entre 13 h 30 et 16 h 30.
 *
 * Le mercredi 16 septembre 2026, à Antananarivo — la journée de la capture.
 */
describe('les statuts terminaux ne prennent plus la place (#753)', () => {
  /** 14:10 – 15:40 au salon, annulé — le premier bloc de la capture. */
  const ANNULE_TOT = {
    startsAt: '2026-09-16T11:10:00.000Z',
    endsAt: '2026-09-16T12:40:00.000Z',
    status: 'cancelled',
  } as const;

  /** 14:55 – 16:25 au salon, annulé — celui qui chevauchait le précédent. */
  const ANNULE_TARD = {
    startsAt: '2026-09-16T11:55:00.000Z',
    endsAt: '2026-09-16T13:25:00.000Z',
    status: 'cancelled',
  } as const;

  function journee(appointments: readonly Appointment[], openingHours?: readonly OpeningHoursEntry[]) {
    return buildCalendarBoard({
      view: 'jour',
      range: rangeOf('jour', '2026-09-16'),
      appointments,
      timeZone: TIMEZONE,
      ...(openingHours === undefined ? {} : { openingHours }),
    });
  }

  it('rouvre à la réservation l’après-midi que deux annulés occupaient', () => {
    const cells = journee([appointment(ANNULE_TOT), appointment(ANNULE_TARD)]).columns[0]?.cells ?? [];

    // La preuve de l'audit, prise à l'envers : chaque demi-heure de 14 h à 16 h
    // redevient une cellule libre, donc un point d'entrée vers le tiroir.
    expect(freeOf(cells).map((cell) => cell.time)).toEqual(
      expect.arrayContaining(['14:00', '14:30', '15:00', '15:30', '16:00']),
    );
    // Et rien n'a disparu : les deux annulés sont toujours là, à leur heure.
    expect(ghostsOf(cells).map((cell) => cell.timeLabel)).toEqual([
      '14:10 – 15:40',
      '14:55 – 16:25',
    ]);
    expect(eventsOf(cells)).toHaveLength(0);
  });

  it('range les annulés qui se chevauchent sur leur propre calque', () => {
    const column = journee([appointment(ANNULE_TOT), appointment(ANNULE_TARD)]).columns[0];
    const cells = column?.cells ?? [];

    // Deux couloirs pour les soldés — ils ne se recouvrent pas…
    expect(ghostsOf(cells).map((cell) => cell.lane)).toEqual([0, 1]);
    expect(ghostsOf(cells).map((cell) => cell.laneCount)).toEqual([2, 2]);
    // …mais la colonne, elle, n'est plus scindée : la cellule libre garde toute
    // sa largeur, et un rendez-vous vivant la garderait aussi.
    expect(column?.laneCount).toBe(1);
  });

  it('ne rétrécit pas le rendez-vous vivant posé sur l’heure d’un annulé', () => {
    // Le geste que le ticket rend possible : reposer un client sur le créneau
    // qu'une annulation a libéré. Le bloc neuf doit occuper toute la colonne —
    // sans quoi on aurait remplacé une gêne par une autre.
    const column = journee([
      appointment(ANNULE_TOT),
      appointment({
        startsAt: '2026-09-16T11:30:00.000Z',
        endsAt: '2026-09-16T12:30:00.000Z',
        status: 'confirmed',
      }),
    ]).columns[0];
    const cells = column?.cells ?? [];

    expect(column?.laneCount).toBe(1);
    expect(eventsOf(cells).map((cell) => cell.lane)).toEqual([0]);
    // Le vivant, lui, reprend bien son créneau : plus de cellule libre dessous.
    expect(freeOf(cells).map((cell) => cell.time)).not.toContain('14:30');
  });

  it('sépare les deux calques sur le seul critère du contrat partagé', () => {
    const statuses: readonly AppointmentStatus[] = [
      'pending',
      'confirmed',
      'completed',
      'cancelled',
      'no_show',
    ];
    const cells =
      journee(
        statuses.map((status, index) =>
          appointment({
            // Une heure chacun, à la suite, pour qu'aucun ne se chevauche.
            startsAt: `2026-09-16T${String(6 + index).padStart(2, '0')}:00:00.000Z`,
            endsAt: `2026-09-16T${String(7 + index).padStart(2, '0')}:00:00.000Z`,
            status,
          }),
        ),
      ).columns[0]?.cells ?? [];

    expect(eventsOf(cells).map((cell) => cell.appointment.status)).toEqual([
      'pending',
      'confirmed',
    ]);
    expect(ghostsOf(cells).map((cell) => cell.appointment.status)).toEqual([
      'completed',
      'cancelled',
      'no_show',
    ]);
  });

  it('garde le soldé visible même sur une rangée que le salon ne travaille pas', () => {
    // Un annulé pendant la coupure méridienne : la rangée redevient « Pause »,
    // parce qu'elle n'est toujours pas réservable (#752) — et le repère reste,
    // parce qu'un rendez-vous ne disparaît jamais de l'écran.
    const cells =
      journee(
        [
          appointment({
            startsAt: '2026-09-16T10:00:00.000Z',
            endsAt: '2026-09-16T10:30:00.000Z',
            status: 'cancelled',
          }),
        ],
        [
          { weekday: 3, opensAt: '09:00', closesAt: '13:00' },
          { weekday: 3, opensAt: '14:00', closesAt: '19:00' },
        ],
      ).columns[0]?.cells ?? [];

    expect(ghostsOf(cells)).toHaveLength(1);
    expect(freeOf(cells).map((cell) => cell.time)).not.toContain('13:00');
    expect(
      cells
        .filter((cell): cell is CalendarClosedCell => cell.kind === 'closed')
        .map((cell) => cell.label),
    ).toContain('Pause');
    // Et il reste lisible : « Pause » est opaque, le repère est écrit après lui,
    // donc peint par-dessus. Rien ne porte de `z-index` sur cette grille — c'est
    // l'ordre du document qui décide, et c'est donc lui qu'on vérifie.
    const pause = cells.findIndex((cell) => cell.kind === 'closed');
    const repere = cells.findIndex((cell) => cell.kind === 'ghost');

    expect(pause).toBeGreaterThanOrEqual(0);
    expect(repere).toBeGreaterThan(pause);
  });

  it('peint le rendez-vous vivant par-dessus le soldé qu’il remplace', () => {
    // Le geste du ticket, poussé à son terme : le client repris à l'heure exacte
    // de l'annulation. Les deux cellules partagent alors la même rangée, et c'est
    // le vivant qu'il faut lire — un repère écrit après lui le recouvrirait.
    const cells =
      journee([
        appointment(ANNULE_TOT),
        appointment({
          startsAt: ANNULE_TOT.startsAt,
          endsAt: ANNULE_TOT.endsAt,
          status: 'confirmed',
        }),
      ]).columns[0]?.cells ?? [];

    const repere = cells.findIndex((cell) => cell.kind === 'ghost');
    const vivant = cells.findIndex((cell) => cell.kind === 'event');

    expect(repere).toBeGreaterThanOrEqual(0);
    expect(vivant).toBeGreaterThan(repere);
  });
});
