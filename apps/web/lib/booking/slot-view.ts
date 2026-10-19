import {
  COPILOT_DAY_PARTS,
  calendarDateSchema,
  type CalendarDate,
  type CopilotDayPart,
  type DayAvailability,
  type TimeZone,
  type UtcInstant,
} from '@spa/shared';

/**
 * Ce que l'étape « Créneau » montre : un jour, une plage de la journée — #1457
 * (P2-02 du plan du copilot IA).
 *
 * `?jour=AAAA-MM-JJ` ouvre l'étape sur ce jour, `?plage=matin|apres-midi|soir`
 * ne garde que les créneaux de cette partie de la journée. Ce sont des
 * **filtres d'affichage**, pas des choix de réservation : ils ne vont pas dans
 * le brouillon, ne retiennent aucun créneau, et une valeur illisible est
 * ignorée comme le reste de l'adresse du tunnel (`draft.ts`).
 *
 * Ils servent à la main — la rangée de plages au-dessus des créneaux — comme au
 * chat, qui ouvre « un massage demain après-midi » directement filtré. Les deux
 * passent par la même adresse, et donc par le même écran.
 *
 * Le vocabulaire des plages est celui du registre du copilot
 * (`COPILOT_DAY_PARTS`) : un seul mot pour la même chose, d'un bout à l'autre.
 */

export const SLOT_VIEW_KEYS = { day: 'jour', dayPart: 'plage' } as const;

export const DAY_PARTS = COPILOT_DAY_PARTS;

export type DayPart = CopilotDayPart;

export interface SlotView {
  readonly day: CalendarDate | null;
  readonly dayPart: DayPart | null;
}

export const EMPTY_SLOT_VIEW: SlotView = { day: null, dayPart: null };

/**
 * Bornes d'une plage, en heures **du salon**, début inclus, fin exclue. Un
 * créneau appartient à la plage où il commence : un soin de 11 h 30 à 12 h 30
 * est du matin.
 */
export const DAY_PART_HOURS: Readonly<Record<DayPart, readonly [number, number]>> = {
  matin: [0, 12],
  'apres-midi': [12, 18],
  soir: [18, 24],
};

function isDayPart(value: string | null): value is DayPart {
  return value !== null && (DAY_PARTS as readonly string[]).includes(value);
}

export function slotViewFromSearch(search: string | URLSearchParams): SlotView {
  const params = new URLSearchParams(search);
  const day = calendarDateSchema.safeParse(params.get(SLOT_VIEW_KEYS.day));
  const dayPart = params.get(SLOT_VIEW_KEYS.dayPart);
  return {
    day: day.success ? day.data : null,
    dayPart: isDayPart(dayPart) ? dayPart : null,
  };
}

/** La query string `search` où la vue remplace la précédente — les autres paramètres restent. */
export function searchWithSlotView(search: string, view: SlotView): string {
  const params = new URLSearchParams(search);
  if (view.day === null) params.delete(SLOT_VIEW_KEYS.day);
  else params.set(SLOT_VIEW_KEYS.day, view.day);
  if (view.dayPart === null) params.delete(SLOT_VIEW_KEYS.dayPart);
  else params.set(SLOT_VIEW_KEYS.dayPart, view.dayPart);
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

/** L'heure du salon (0 à 23) à laquelle commence un créneau. */
export function hourInTimeZone(startsAt: UtcInstant, timeZone: TimeZone): number {
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(
    new Date(startsAt),
  );
  return Number(hour);
}

/**
 * Les mêmes journées, avec les seuls créneaux de la plage.
 *
 * Les journées restent toutes là, même vidées : le calendrier écrit alors
 * « complet » sur ce jour **pour cette plage**, et la bande garde sa forme.
 */
export function daysInDayPart(
  days: readonly DayAvailability[],
  dayPart: DayPart | null,
  timeZone: TimeZone,
): readonly DayAvailability[] {
  if (dayPart === null) return days;
  const [from, to] = DAY_PART_HOURS[dayPart];
  return days.map((day) => ({
    ...day,
    slots: day.slots.filter((slot) => {
      const hour = hourInTimeZone(slot.startsAt, timeZone);
      return hour >= from && hour < to;
    }),
  }));
}
