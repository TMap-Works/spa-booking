/**
 * Dates civiles du parcours de réservation.
 *
 * Une **date civile** n'est pas un instant : « aujourd'hui » à Antananarivo et
 * « aujourd'hui » à Papeete ne désignent pas la même journée au même moment. Les
 * bornes de la requête de disponibilité sont des dates civiles de
 * l'établissement (voir `availabilityQuerySchema`), et c'est le seul endroit du
 * front qui les calcule.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

/** Millisecondes dans une journée — les bornes se déplacent en UTC, pas en heure murale. */
const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * La date civile qu'affiche l'horloge de `timeZone` à cet instant.
 *
 * `formatToParts` plutôt qu'une locale complaisante : `en-CA` rend bien
 * `2026-09-01`, mais c'est une propriété de cette locale et non une garantie.
 * Les composants extraits un par un, la sortie est un `YYYY-MM-DD` par
 * construction.
 */
export function calendarDateInTimeZone(instant: Date, timeZone: TimeZone): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * `date` décalée de `days` journées civiles.
 *
 * Le calcul passe par midi UTC : sur une date lue à minuit, une bascule d'heure
 * d'été suffirait à faire retomber l'addition sur la veille.
 */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.parse(`${date}T12:00:00Z`) + days * MILLISECONDS_IN_DAY);

  return shifted.toISOString().slice(0, 10);
}
