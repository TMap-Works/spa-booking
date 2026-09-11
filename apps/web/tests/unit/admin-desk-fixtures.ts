import type { AvailabilitySlot } from '@spa/shared';

/**
 * Les créneaux tels que le moteur de disponibilité les rend vraiment (#611).
 *
 * Ce n'est pas une commodité de test, c'est **le fait** que le ticket corrige :
 * le moteur aligne ses créneaux sur le début de plage du praticien, au pas de
 * quinze minutes. Un praticien qui ouvre à 07:10 n'a donc pas un seul créneau à
 * la minute 00 — la campagne de QA en a relevé vingt-six sur une journée, tous
 * hors heures rondes. Un jeu d'essai qui proposerait 08:00, 08:30, 09:00 ferait
 * passer l'écran fautif et échouer sa correction.
 *
 * Le salon des tests est à Antananarivo, qui est à UTC+3 **toute l'année** : la
 * conversion de l'heure murale vers l'instant est donc une soustraction
 * constante, et aucun test ne dépend de la date à laquelle il tourne.
 */

/** Décalage du salon des tests, en minutes — `Indian/Antananarivo`, sans heure d'été. */
const TENANT_OFFSET_MINUTES = 3 * 60;

/** Début de plage du praticien, en heure murale du salon. */
export const DESK_FIRST_SLOT_TIME = '07:10';

/** Pas du moteur, en minutes. */
export const DESK_SLOT_STEP_MINUTES = 15;

/** Durée du soin des jeux d'essai — l'écart entre `startsAt` et `endsAt`. */
const DESK_SLOT_DURATION_MINUTES = 60;

/** « 2026-08-26 » + 250 minutes UTC → « 2026-08-26T04:10:00.000Z ». */
function instantOf(date: string, utcMinutes: number): string {
  const hours = String(Math.floor(utcMinutes / 60)).padStart(2, '0');
  const minutes = String(utcMinutes % 60).padStart(2, '0');

  return `${date}T${hours}:${minutes}:00.000Z`;
}

/** Un créneau unique, à l'instant UTC donné. */
export function deskSlot(startsAt: string, staffId = 'staff-hasina'): AvailabilitySlot {
  const start = Date.parse(startsAt);

  return {
    startsAt,
    endsAt: new Date(start + DESK_SLOT_DURATION_MINUTES * 60_000).toISOString(),
    staffId,
  };
}

/**
 * La journée de créneaux d'un praticien : `count` créneaux de quinze minutes à
 * partir de 07:10 au salon.
 *
 * Quarante créneaux couvrent 07:10 à 16:55, ce qui englobe toutes les heures que
 * les tests du comptoir visent — et aucune n'est ronde.
 */
export function deskSlots(date: string, staffId = 'staff-hasina', count = 40): AvailabilitySlot[] {
  const [firstHour = '0', firstMinute = '0'] = DESK_FIRST_SLOT_TIME.split(':');
  const first = Number(firstHour) * 60 + Number(firstMinute) - TENANT_OFFSET_MINUTES;

  return Array.from({ length: count }, (_unused, index) =>
    deskSlot(instantOf(date, first + index * DESK_SLOT_STEP_MINUTES), staffId),
  );
}
