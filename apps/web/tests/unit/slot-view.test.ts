import type { DayAvailability } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { daysInDayPart, hourInTimeZone, searchWithSlotView, slotViewFromSearch } from '@/lib/booking/slot-view';

/**
 * `?jour=` et `?plage=` du tunnel (#1457, P2-02 du copilot) : lus sans jamais
 * planter sur une adresse bricolée, réécrits sans toucher aux autres
 * paramètres, et appliqués dans le fuseau du salon.
 */

describe('slotViewFromSearch', () => {
  it('lit un jour civil et une plage connue', () => {
    expect(slotViewFromSearch('?etape=creneau&jour=2026-10-20&plage=apres-midi')).toEqual({
      day: '2026-10-20',
      dayPart: 'apres-midi',
    });
  });

  it('ignore une valeur illisible plutôt que de la propager', () => {
    expect(slotViewFromSearch('?jour=2026-02-30&plage=nuit')).toEqual({ day: null, dayPart: null });
    expect(slotViewFromSearch('')).toEqual({ day: null, dayPart: null });
  });
});

describe('searchWithSlotView', () => {
  it('pose et retire la vue sans toucher aux autres paramètres', () => {
    const search = '?etape=creneau&prestation=abc&utm_source=chat';
    expect(searchWithSlotView(search, { day: '2026-10-20', dayPart: 'soir' })).toBe(
      '?etape=creneau&prestation=abc&utm_source=chat&jour=2026-10-20&plage=soir',
    );
    expect(searchWithSlotView('?etape=creneau&jour=2026-10-20&plage=soir', { day: null, dayPart: null })).toBe(
      '?etape=creneau',
    );
  });
});

describe('daysInDayPart', () => {
  const day = (slots: string[]): DayAvailability => ({
    date: '2026-10-20',
    slots: slots.map((startsAt) => ({
      startsAt,
      endsAt: startsAt,
      staffId: '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69',
    })),
  });

  it('découpe la journée dans le fuseau du salon, pas en UTC', () => {
    // Paris en heure d'été (UTC+2) : 09:30Z = 11:30 (matin), 10:00Z = 12:00
    // (après-midi), 16:00Z = 18:00 (soir).
    const days = [day(['2026-10-20T09:30:00Z', '2026-10-20T10:00:00Z', '2026-10-20T16:00:00Z'])];
    const starts = (part: 'matin' | 'apres-midi' | 'soir') =>
      daysInDayPart(days, part, 'Europe/Paris')[0]!.slots.map((s) => s.startsAt);

    expect(starts('matin')).toEqual(['2026-10-20T09:30:00Z']);
    expect(starts('apres-midi')).toEqual(['2026-10-20T10:00:00Z']);
    expect(starts('soir')).toEqual(['2026-10-20T16:00:00Z']);
  });

  it('garde les journées vidées, et ne touche à rien sans plage', () => {
    const days = [day(['2026-10-20T06:00:00Z'])];
    expect(daysInDayPart(days, 'soir', 'Europe/Paris')).toEqual([{ date: '2026-10-20', slots: [] }]);
    expect(daysInDayPart(days, null, 'Europe/Paris')).toBe(days);
  });

  it("lit l'heure du salon sur 24 heures", () => {
    expect(hourInTimeZone('2026-10-20T22:30:00Z', 'Indian/Antananarivo')).toBe(1);
  });
});
