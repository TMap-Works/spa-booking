/**
 * La trame du calendrier mensuel (#827), éprouvée sans DOM.
 *
 * Ce sont les règles qui décident *ce que l'écran montre* : quelles cases
 * composent un mois, quelle plage on demande au serveur pour l'afficher, et où
 * va le focus sous une flèche. Les monter dans un composant pour les vérifier
 * reviendrait à tester React.
 *
 * Les cas retenus sont ceux où une arithmétique de dates se trompe vraiment :
 * un mois qui commence un dimanche, un 31 qu'on pousse vers un mois de trente
 * jours, un février bissextile, et le passage d'une année à l'autre.
 */

import { MAX_AVAILABILITY_RANGE_DAYS, type CalendarDate } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  addMonths,
  bookingWindow,
  clampToWindow,
  dayOfMonth,
  firstDayOfMonth,
  formatMonth,
  isNavigableMonth,
  isWithinWindow,
  lastDayOfMonth,
  monthMoveForKey,
  monthOf,
  monthRange,
  monthWeeks,
  moveInMonth,
  type BookingWindow,
} from '@/lib/booking/month-grid';

/** Une fenêtre bornée à la main, pour éprouver les bords sans dépendre du jour. */
function window(first: string, last: string): BookingWindow {
  return { first: first as CalendarDate, last: last as CalendarDate };
}

describe('monthOf, firstDayOfMonth, lastDayOfMonth', () => {
  it('rend le mois, son premier et son dernier jour', () => {
    expect(monthOf('2026-09-16' as CalendarDate)).toBe('2026-09');
    expect(firstDayOfMonth('2026-09')).toBe('2026-09-01');
    expect(lastDayOfMonth('2026-09')).toBe('2026-09-30');
    expect(lastDayOfMonth('2026-08')).toBe('2026-08-31');
  });

  it('connaît février, bissextile ou non', () => {
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    // 2100 n'est pas bissextile — la règle séculaire, que `new Date` tient et
    // qu'une division par quatre écrite à la main manquerait.
    expect(lastDayOfMonth('2100-02')).toBe('2100-02-28');
  });
});

describe('addMonths', () => {
  it('franchit l’année dans les deux sens', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-09', 0)).toBe('2026-09');
    expect(addMonths('2026-09', 16)).toBe('2028-01');
    expect(addMonths('2026-09', -21)).toBe('2024-12');
  });

  it('ne reporte jamais le débordement d’un quantième', () => {
    // `new Date(2026, 0, 31)` avancé d'un mois rend le 3 mars : le calcul passe
    // par un rang de mois, où le quantième n'entre pas.
    expect(addMonths('2026-01', 1)).toBe('2026-02');
    expect(addMonths('2026-03', -1)).toBe('2026-02');
  });
});

describe('monthWeeks', () => {
  it('aligne le premier jour sur sa colonne, lundi en tête', () => {
    // Le 1er septembre 2026 est un mardi : une case vide devant.
    const weeks = monthWeeks('2026-09');

    expect(weeks[0]).toEqual([
      null,
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('remplit la dernière ligne de cases vides plutôt que du mois suivant', () => {
    const weeks = monthWeeks('2026-09');
    const last = weeks.at(-1);

    expect(last?.[2]).toBe('2026-09-30');
    expect(last?.slice(3)).toEqual([null, null, null, null]);
  });

  it('rend six lignes pour un mois de 31 jours commençant un dimanche', () => {
    // Le 1er mars 2026 est un dimanche : six cases vides devant, et le mois
    // déborde donc sur une sixième ligne.
    const weeks = monthWeeks('2026-03');

    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0]?.[6]).toBe('2026-03-01');
    expect(weeks.at(-1)?.[1]).toBe('2026-03-31');
  });

  it('rend quatre lignes pour un février de 28 jours commençant un lundi', () => {
    // Février 2021 : 28 jours, commence un lundi — le seul cas où un mois tient
    // exactement en quatre lignes, et où une sixième ligne posée par principe
    // ajouterait deux rangées vides.
    const weeks = monthWeeks('2021-02');

    expect(weeks).toHaveLength(4);
    expect(weeks[0]?.[0]).toBe('2021-02-01');
    expect(weeks.at(-1)?.[6]).toBe('2021-02-28');
  });

  it('ne rend jamais que des lignes de sept cases', () => {
    for (const month of ['2026-01', '2026-02', '2026-03', '2026-11', '2024-02']) {
      for (const week of monthWeeks(month)) {
        expect(week).toHaveLength(7);
      }
    }
  });
});

describe('bookingWindow', () => {
  it('ouvre exactement la profondeur que le contrat plafonne', () => {
    const bounds = bookingWindow('2026-09-16' as CalendarDate);

    expect(bounds.first).toBe('2026-09-16');
    // Bornes comprises : `from + 30` fait bien trente et un jours.
    expect(bounds.last).toBe('2026-10-16');
    expect(MAX_AVAILABILITY_RANGE_DAYS).toBe(31);
  });
});

describe('monthRange', () => {
  const bounds = window('2026-09-16', '2026-10-16');

  it('rogne le mois courant sur aujourd’hui', () => {
    expect(monthRange('2026-09', bounds)).toEqual({ from: '2026-09-16', to: '2026-09-30' });
  });

  it('rogne le dernier mois sur la fin de la fenêtre', () => {
    expect(monthRange('2026-10', bounds)).toEqual({ from: '2026-10-01', to: '2026-10-16' });
  });

  it('ne demande rien d’un mois entièrement hors de la fenêtre', () => {
    expect(monthRange('2026-08', bounds)).toBeNull();
    expect(monthRange('2026-11', bounds)).toBeNull();
  });

  it('ne dépasse jamais le plafond du contrat, bornes comprises', () => {
    // Une fenêtre qui couvre un mois entier de 31 jours : le pire cas.
    const wide = window('2026-07-01', '2026-12-31');
    const range = monthRange('2026-08', wide);

    expect(range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(dayOfMonth(range?.to ?? ('' as CalendarDate))).toBeLessThanOrEqual(
      MAX_AVAILABILITY_RANGE_DAYS,
    );
  });
});

describe('isWithinWindow, clampToWindow, isNavigableMonth', () => {
  const bounds = window('2026-09-16', '2026-10-16');

  it('situe une date par rapport à la fenêtre', () => {
    expect(isWithinWindow('2026-09-15' as CalendarDate, bounds)).toBe(false);
    expect(isWithinWindow('2026-09-16' as CalendarDate, bounds)).toBe(true);
    expect(isWithinWindow('2026-10-16' as CalendarDate, bounds)).toBe(true);
    expect(isWithinWindow('2026-10-17' as CalendarDate, bounds)).toBe(false);
  });

  it('ramène une date hors bornes sur la borne la plus proche', () => {
    expect(clampToWindow('2026-01-01' as CalendarDate, bounds)).toBe('2026-09-16');
    expect(clampToWindow('2027-01-01' as CalendarDate, bounds)).toBe('2026-10-16');
    expect(clampToWindow('2026-09-20' as CalendarDate, bounds)).toBe('2026-09-20');
  });

  it('n’ouvre la navigation qu’aux mois que la fenêtre touche', () => {
    expect(isNavigableMonth('2026-08', bounds)).toBe(false);
    expect(isNavigableMonth('2026-09', bounds)).toBe(true);
    expect(isNavigableMonth('2026-10', bounds)).toBe(true);
    expect(isNavigableMonth('2026-11', bounds)).toBe(false);
  });
});

describe('monthMoveForKey', () => {
  it('reprend le clavier du document de conception, et rien de plus', () => {
    expect(monthMoveForKey('ArrowLeft')).toBe('previousDay');
    expect(monthMoveForKey('ArrowRight')).toBe('nextDay');
    expect(monthMoveForKey('ArrowUp')).toBe('previousWeek');
    expect(monthMoveForKey('ArrowDown')).toBe('nextWeek');
    expect(monthMoveForKey('Home')).toBe('weekStart');
    expect(monthMoveForKey('End')).toBe('weekEnd');
    expect(monthMoveForKey('PageUp')).toBe('previousMonth');
    expect(monthMoveForKey('PageDown')).toBe('nextMonth');
  });

  it('laisse au navigateur les touches qui ne le regardent pas', () => {
    for (const key of ['Tab', 'Enter', ' ', 'Escape', 'a']) {
      expect(monthMoveForKey(key)).toBeNull();
    }
  });
});

describe('moveInMonth', () => {
  const bounds = window('2026-09-16', '2026-10-16');
  const from = '2026-09-22' as CalendarDate;

  it('déplace au jour et à la semaine', () => {
    expect(moveInMonth(from, 'previousDay', bounds)).toBe('2026-09-21');
    expect(moveInMonth(from, 'nextDay', bounds)).toBe('2026-09-23');
    expect(moveInMonth(from, 'previousWeek', bounds)).toBe('2026-09-16');
    expect(moveInMonth(from, 'nextWeek', bounds)).toBe('2026-09-29');
  });

  it('va aux bords de la ligne, lundi et dimanche', () => {
    // Le 22 septembre 2026 est un mardi.
    expect(moveInMonth(from, 'weekStart', bounds)).toBe('2026-09-21');
    expect(moveInMonth(from, 'weekEnd', bounds)).toBe('2026-09-27');
  });

  it('traverse le mois avec les flèches', () => {
    expect(moveInMonth('2026-09-30' as CalendarDate, 'nextDay', bounds)).toBe('2026-10-01');
    expect(moveInMonth('2026-10-01' as CalendarDate, 'previousDay', bounds)).toBe('2026-09-30');
  });

  it('ne boucle pas aux bords de la fenêtre', () => {
    expect(moveInMonth('2026-09-16' as CalendarDate, 'previousDay', bounds)).toBe('2026-09-16');
    expect(moveInMonth('2026-09-16' as CalendarDate, 'previousWeek', bounds)).toBe('2026-09-16');
    expect(moveInMonth('2026-10-16' as CalendarDate, 'nextDay', bounds)).toBe('2026-10-16');
    expect(moveInMonth('2026-10-16' as CalendarDate, 'nextWeek', bounds)).toBe('2026-10-16');
    // Le bord de ligne ne fait pas exception : un lundi hors fenêtre est rogné.
    expect(moveInMonth('2026-09-16' as CalendarDate, 'weekStart', bounds)).toBe('2026-09-16');
  });

  it('garde le quantième en changeant de mois', () => {
    const large = window('2026-01-01', '2026-12-31');

    expect(moveInMonth('2026-09-20' as CalendarDate, 'nextMonth', large)).toBe('2026-10-20');
    expect(moveInMonth('2026-09-20' as CalendarDate, 'previousMonth', large)).toBe('2026-08-20');
  });

  it('retombe sur le dernier jour quand le mois d’arrivée est plus court', () => {
    const large = window('2026-01-01', '2026-12-31');

    // Le 31 mars vers avril, qui n'a que trente jours — et non le 1er mai, que
    // `new Date` rendrait en reportant le débordement.
    expect(moveInMonth('2026-03-31' as CalendarDate, 'nextMonth', large)).toBe('2026-04-30');
    expect(moveInMonth('2026-03-30' as CalendarDate, 'previousMonth', large)).toBe('2026-02-28');
  });

  it('rogne un changement de mois qui sort de la fenêtre', () => {
    expect(moveInMonth('2026-09-20' as CalendarDate, 'previousMonth', bounds)).toBe('2026-09-16');
    expect(moveInMonth('2026-10-20' as CalendarDate, 'nextMonth', bounds)).toBe('2026-10-16');
  });
});

describe('formatMonth', () => {
  it('écrit le mois et son année, en français', () => {
    expect(formatMonth('2026-09')).toBe('septembre 2026');
    expect(formatMonth('2027-01')).toBe('janvier 2027');
  });
});
