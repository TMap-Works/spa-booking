/**
 * Les jours d'ouverture publiés, tels que le calendrier les lit (#742).
 *
 * Logique pure, éprouvée sans monter de DOM : c'est elle qui décide du mot —
 * « Fermé » ou « Complet » — que la case du calendrier annonce, et c'est la
 * frontière à ne pas franchir qui s'y vérifie le mieux. Ces plages décrivent la
 * vitrine du salon (CDC §2.3 : le module distingue les horaires des rendez-vous
 * pris) et ne décident d'aucune disponibilité.
 */

import type { IsoWeekday, OpeningHoursEntry } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { isPublishedClosedDay, publishedOpenWeekdays } from '@/lib/booking/opening-days';

/** Une plage d'ouverture du jour ISO demandé — l'heure importe peu ici. */
function plage(weekday: IsoWeekday): OpeningHoursEntry {
  return { weekday, opensAt: '09:00', closesAt: '19:00' };
}

/** Du lundi au vendredi, la semaine de l'établissement semé. */
const SEMAINE_OUVREE: readonly OpeningHoursEntry[] = [1, 2, 3, 4, 5].map((weekday) =>
  plage(weekday as IsoWeekday),
);

describe('publishedOpenWeekdays', () => {
  it('rend les jours ISO qui portent au moins une plage', () => {
    expect([...(publishedOpenWeekdays(SEMAINE_OUVREE) ?? [])]).toEqual([1, 2, 3, 4, 5]);
  });

  it('ne compte qu’une fois un jour à coupure méridienne', () => {
    const avecCoupure: readonly OpeningHoursEntry[] = [
      { weekday: 2, opensAt: '09:00', closesAt: '13:00' },
      { weekday: 2, opensAt: '14:00', closesAt: '19:00' },
    ];

    expect([...(publishedOpenWeekdays(avecCoupure) ?? [])]).toEqual([2]);
  });

  it('rend `null` quand le salon n’a rien publié', () => {
    // L'API **omet** les horaires plutôt que de rendre une semaine vide (#343) :
    // absent et vide disent tous deux « on ne sait pas ».
    expect(publishedOpenWeekdays(undefined)).toBeNull();
    expect(publishedOpenWeekdays([])).toBeNull();
  });
});

describe('isPublishedClosedDay', () => {
  const ouverts = publishedOpenWeekdays(SEMAINE_OUVREE);

  it('déclare fermé un jour de semaine absent des horaires', () => {
    // 19 septembre 2026 : un samedi, 20 septembre : un dimanche.
    expect(isPublishedClosedDay('2026-09-19', ouverts)).toBe(true);
    expect(isPublishedClosedDay('2026-09-20', ouverts)).toBe(true);
  });

  it('laisse ouvert un jour que les horaires portent', () => {
    expect(isPublishedClosedDay('2026-09-18', ouverts)).toBe(false);
  });

  it('ne déclare rien fermé sans horaires publiés', () => {
    // Sans quoi un salon fraîchement inscrit verrait ses sept jours barrés.
    expect(isPublishedClosedDay('2026-09-20', null)).toBe(false);
  });
});
