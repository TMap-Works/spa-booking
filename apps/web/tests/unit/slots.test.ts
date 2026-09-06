/**
 * La logique du sélecteur de créneau (#44), éprouvée sans DOM.
 *
 * Ce sont les règles qui décident *ce que l'écran montre* : quel créneau
 * survit au dédoublonnage, quelle journée s'affiche quand la précédente s'est
 * remplie, où va le focus sous une flèche. Les monter dans un composant pour les
 * vérifier reviendrait à tester React.
 */

import type {
  AvailabilitySlot,
  CalendarDate,
  DayAvailability,
  TimeZone,
  UtcInstant,
} from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  canSelectDay,
  dateBarDays,
  dateBarMoveForKey,
  distinctSlotTimes,
  gridMoveForKey,
  moveInDateBar,
  moveInGrid,
  openDays,
  resolveActiveDay,
  selectableDays,
  slotRows,
  type DateBarDay,
} from '@/lib/booking/slots';

const HERY = '44444444-4444-4444-8444-444444444444';
const NIVO = '55555555-5555-4555-8555-555555555555';

function slot(startsAt: string, staffId: string): AvailabilitySlot {
  return { startsAt: startsAt as UtcInstant, endsAt: startsAt as UtcInstant, staffId };
}

function day(date: string, slots: readonly AvailabilitySlot[]): DayAvailability {
  return { date: date as CalendarDate, slots: [...slots] };
}

describe('distinctSlotTimes', () => {
  it('ne garde qu’un créneau par heure de début', () => {
    // Sans préférence de praticien, l'API rend un créneau par praticien libre.
    // Deux boutons « 09:00 » côte à côte ne laisseraient aucun choix à faire.
    const slots = distinctSlotTimes([
      slot('2026-09-01T06:00:00.000Z', HERY),
      slot('2026-09-01T06:00:00.000Z', NIVO),
      slot('2026-09-01T11:00:00.000Z', NIVO),
    ]);

    expect(slots.map((entry) => entry.startsAt)).toEqual([
      '2026-09-01T06:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
    ]);
  });

  it('retient le premier praticien rendu par le serveur', () => {
    const slots = distinctSlotTimes([
      slot('2026-09-01T06:00:00.000Z', HERY),
      slot('2026-09-01T06:00:00.000Z', NIVO),
    ]);

    expect(slots[0]?.staffId).toBe(HERY);
  });

  it('trie sur l’instant et non sur la chaîne', () => {
    // Deux écritures du même contrat, précisions différentes : une comparaison
    // lexicographique classerait `06:00:00Z` après `06:00:00.000Z`.
    const slots = distinctSlotTimes([
      slot('2026-09-01T11:00:00Z', NIVO),
      slot('2026-09-01T06:00:00.000Z', HERY),
    ]);

    expect(slots.map((entry) => entry.startsAt)).toEqual([
      '2026-09-01T06:00:00.000Z',
      '2026-09-01T11:00:00Z',
    ]);
  });
});

describe('openDays', () => {
  it('écarte les journées complètes, que le serveur renvoie vides plutôt qu’omises', () => {
    const days = selectableDays([
      day('2026-09-01', []),
      day('2026-09-02', [slot('2026-09-02T06:00:00.000Z', HERY)]),
    ]);

    expect(openDays(days).map((entry) => entry.date)).toEqual(['2026-09-02']);
  });
});

describe('resolveActiveDay', () => {
  // Les journées lui arrivent **déjà filtrées** : c'est l'appelant qui mémoïse
  // `openDays`, et refiltrer ici referait ce travail à chaque rendu.
  const days = openDays(
    selectableDays([
      day('2026-09-01', [slot('2026-09-01T06:00:00.000Z', HERY)]),
      day('2026-09-02', [slot('2026-09-02T06:00:00.000Z', HERY)]),
    ]),
  );

  it('retient la journée choisie', () => {
    expect(resolveActiveDay(days, '2026-09-02' as CalendarDate)?.date).toBe('2026-09-02');
  });

  it('retombe sur la première journée ouverte quand la journée choisie s’est remplie', () => {
    const remplie = openDays(
      selectableDays([
        day('2026-09-01', []),
        day('2026-09-02', [slot('2026-09-02T06:00:00.000Z', HERY)]),
      ]),
    );

    // Sans ce repli, le sélecteur pointerait une option qui n'existe plus
    // au-dessus d'une liste vide, sans un mot.
    expect(resolveActiveDay(remplie, '2026-09-01' as CalendarDate)?.date).toBe('2026-09-02');
  });

  it('rend null quand plus rien n’est ouvert', () => {
    expect(resolveActiveDay(openDays(selectableDays([day('2026-09-01', [])])), null)).toBeNull();
  });
});

describe('slotRows', () => {
  /** Antananarivo, UTC+3 sans heure d'été — le décalage ne dépend pas de la date. */
  const timeZone = 'Indian/Antananarivo' as TimeZone;

  it('range les créneaux par moment de la journée, dans l’horloge du salon', () => {
    // 06:00 UTC = 09:00 sur place (matin), 11:00 UTC = 14:00 (après-midi),
    // 16:00 UTC = 19:00 (soir). Un découpage fait sur l'heure UTC classerait
    // les trois au matin.
    const rows = slotRows(
      [
        slot('2026-09-01T06:00:00.000Z', HERY),
        slot('2026-09-01T11:00:00.000Z', HERY),
        slot('2026-09-01T16:00:00.000Z', HERY),
      ],
      timeZone,
    );

    expect(rows.map((row) => row.label)).toEqual(['Matin', 'Après-midi', 'Soir']);
    expect(rows.map((row) => row.slots.length)).toEqual([1, 1, 1]);
  });

  it('n’ouvre pas une ligne vide', () => {
    // « Soir » au-dessus de rien ferait chercher des créneaux qui n'existent pas.
    const rows = slotRows([slot('2026-09-01T06:00:00.000Z', HERY)], timeZone);

    expect(rows.map((row) => row.label)).toEqual(['Matin']);
  });
});

describe('gridMoveForKey', () => {
  it('reprend le tableau des touches du document de conception', () => {
    expect(gridMoveForKey('ArrowLeft', false)).toBe('previous');
    expect(gridMoveForKey('ArrowRight', false)).toBe('next');
    expect(gridMoveForKey('ArrowUp', false)).toBe('up');
    expect(gridMoveForKey('ArrowDown', false)).toBe('down');
    expect(gridMoveForKey('Home', false)).toBe('rowStart');
    expect(gridMoveForKey('End', false)).toBe('rowEnd');
    expect(gridMoveForKey('Home', true)).toBe('gridStart');
    expect(gridMoveForKey('End', true)).toBe('gridEnd');
  });

  it('laisse au navigateur ce qui ne la regarde pas', () => {
    // Avaler la tabulation ou l'entrée casserait le parcours clavier natif,
    // exactement ce que le composant est censé garantir.
    expect(gridMoveForKey('Tab', false)).toBeNull();
    expect(gridMoveForKey('Enter', false)).toBeNull();
    expect(gridMoveForKey(' ', false)).toBeNull();
  });
});

describe('moveInGrid', () => {
  // Trois lignes de tailles différentes : matin chargé, après-midi plus court,
  // soir réduit à un créneau — le cas où un rang doit être ramené au dernier.
  const rows = [4, 2, 1];

  it('ne boucle pas aux bords de la grille', () => {
    // Une flèche droite qui ramènerait du dernier créneau du soir au premier du
    // matin ferait réserver 09:00 pour 19:45.
    expect(moveInGrid(rows, { row: 2, column: 0 }, 'next')).toEqual({ row: 2, column: 0 });
    expect(moveInGrid(rows, { row: 0, column: 0 }, 'previous')).toEqual({ row: 0, column: 0 });
    expect(moveInGrid(rows, { row: 0, column: 1 }, 'up')).toEqual({ row: 0, column: 1 });
    expect(moveInGrid(rows, { row: 2, column: 0 }, 'down')).toEqual({ row: 2, column: 0 });
  });

  it('traverse les lignes à l’horizontale', () => {
    // « Le créneau suivant » de la journée, pas « le suivant de cette ligne » :
    // s'arrêter à midi obligerait à connaître l'axe vertical pour continuer.
    expect(moveInGrid(rows, { row: 0, column: 3 }, 'next')).toEqual({ row: 1, column: 0 });
    expect(moveInGrid(rows, { row: 1, column: 0 }, 'previous')).toEqual({ row: 0, column: 3 });
  });

  it('ramène le rang dans la ligne visée quand elle est plus courte', () => {
    expect(moveInGrid(rows, { row: 0, column: 3 }, 'down')).toEqual({ row: 1, column: 1 });
    expect(moveInGrid(rows, { row: 1, column: 1 }, 'down')).toEqual({ row: 2, column: 0 });
  });

  it('va aux bornes de la ligne, et aux bornes de la grille avec Ctrl', () => {
    expect(moveInGrid(rows, { row: 0, column: 2 }, 'rowStart')).toEqual({ row: 0, column: 0 });
    expect(moveInGrid(rows, { row: 0, column: 0 }, 'rowEnd')).toEqual({ row: 0, column: 3 });
    expect(moveInGrid(rows, { row: 1, column: 1 }, 'gridStart')).toEqual({ row: 0, column: 0 });
    expect(moveInGrid(rows, { row: 0, column: 0 }, 'gridEnd')).toEqual({ row: 2, column: 0 });
  });

  it('ne sort pas d’une grille vide', () => {
    expect(moveInGrid([], { row: 0, column: 0 }, 'next')).toEqual({ row: 0, column: 0 });
  });
});

describe('dateBarDays', () => {
  const fenetre = ['2026-09-01', '2026-09-02'] as readonly CalendarDate[];

  it('rend la fenêtre civile, comptes inconnus, tant que la réponse manque', () => {
    // C'est ce qui met la barre de dates à l'écran pendant le chargement
    // (`states.md` étape 3) : des dates, que le navigateur pose sans personne.
    expect(dateBarDays(fenetre, null)).toEqual([
      { date: '2026-09-01', slotCount: null },
      { date: '2026-09-02', slotCount: null },
    ]);
  });

  it('rend la réponse, journées complètes comprises, dès qu’elle est là', () => {
    const days = selectableDays([
      day('2026-09-01', []),
      day('2026-09-02', [slot('2026-09-02T06:00:00.000Z', HERY)]),
    ]);

    expect(dateBarDays(fenetre, days)).toEqual([
      { date: '2026-09-01', slotCount: 0 },
      { date: '2026-09-02', slotCount: 1 },
    ]);
  });
});

describe('canSelectDay', () => {
  it('distingue « on ne sait pas encore » de « complet »', () => {
    // Le premier reste opérable — la barre sert justement à changer de jour
    // avant la fin du chargement ; le second est hors du parcours des flèches.
    expect(canSelectDay({ date: '2026-09-01' as CalendarDate, slotCount: null })).toBe(true);
    expect(canSelectDay({ date: '2026-09-01' as CalendarDate, slotCount: 0 })).toBe(false);
    expect(canSelectDay({ date: '2026-09-01' as CalendarDate, slotCount: 3 })).toBe(true);
  });
});

describe('dateBarMoveForKey', () => {
  it('reprend le tableau « Barre de dates » du document de conception', () => {
    expect(dateBarMoveForKey('ArrowLeft')).toBe('previous');
    expect(dateBarMoveForKey('ArrowRight')).toBe('next');
    expect(dateBarMoveForKey('PageUp')).toBe('weekBefore');
    expect(dateBarMoveForKey('PageDown')).toBe('weekAfter');
  });

  it('laisse au navigateur ce qui ne la regarde pas', () => {
    expect(dateBarMoveForKey('Tab')).toBeNull();
    expect(dateBarMoveForKey('Enter')).toBeNull();
    expect(dateBarMoveForKey('Home')).toBeNull();
  });
});

describe('moveInDateBar', () => {
  /** Une quinzaine où le 3e et le 10e jour sont complets. */
  const bar: readonly DateBarDay[] = Array.from({ length: 14 }, (_unused, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, '0')}` as CalendarDate,
    slotCount: index === 2 || index === 9 ? 0 : 4,
  }));

  it('ne boucle pas aux bords de la barre', () => {
    // Une flèche droite qui ramènerait du 14 septembre au 1er ferait réserver
    // dans treize jours ce qu'on croyait réserver demain.
    expect(moveInDateBar(bar, 13, 'next')).toBe(13);
    expect(moveInDateBar(bar, 0, 'previous')).toBe(0);
  });

  it('saute les journées complètes', () => {
    expect(moveInDateBar(bar, 1, 'next')).toBe(3);
    expect(moveInDateBar(bar, 3, 'previous')).toBe(1);
  });

  it('avance et recule d’une semaine', () => {
    expect(moveInDateBar(bar, 0, 'weekAfter')).toBe(7);
    expect(moveInDateBar(bar, 7, 'weekBefore')).toBe(0);
  });

  it('prend la journée ouverte la plus proche quand la semaine tombe sur un complet', () => {
    // Sans ce repli, `PageSuiv` serait muette une semaine sur deux sur un
    // agenda chargé — le 2 + 7 = 9e rang est complet.
    expect(moveInDateBar(bar, 2, 'weekAfter')).toBe(10);
    expect(moveInDateBar(bar, 9, 'weekBefore')).toBe(1);
  });

  it('bute sur les bords plutôt que de déborder', () => {
    expect(moveInDateBar(bar, 12, 'weekAfter')).toBe(13);
    expect(moveInDateBar(bar, 1, 'weekBefore')).toBe(0);
  });

  it('ne sort pas d’une barre vide', () => {
    expect(moveInDateBar([], 0, 'next')).toBe(0);
  });

  it('ne bouge pas quand plus rien n’est ouvert autour', () => {
    const complet: readonly DateBarDay[] = [
      { date: '2026-09-01' as CalendarDate, slotCount: 2 },
      { date: '2026-09-02' as CalendarDate, slotCount: 0 },
      { date: '2026-09-03' as CalendarDate, slotCount: 0 },
    ];

    expect(moveInDateBar(complet, 0, 'next')).toBe(0);
  });
});

