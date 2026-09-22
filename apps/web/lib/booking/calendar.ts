/**
 * Dates civiles du parcours de réservation.
 *
 * Une **date civile** n'est pas un instant : « aujourd'hui » à Antananarivo et
 * « aujourd'hui » à Papeete ne désignent pas la même journée au même moment. Les
 * bornes de la requête de disponibilité sont des dates civiles de
 * l'établissement (voir `availabilityQuerySchema`), et c'est le seul endroit du
 * front qui les calcule.
 *
 * ## La langue (#846)
 *
 * Deux des trois fonctions de ce fichier ne produisent pas du texte mais une
 * **donnée** — un `YYYY-MM-DD` — et leur locale `en-US` est un détail de
 * découpage, non un choix d'affichage : elle ne bouge pas avec la langue.
 *
 * `formatCalendarMonth`, elle, est lue par une cliente, et reçoit donc un
 * `DisplayLocale`. L'étiquette BCP 47 est demandée à `formattingLocale`
 * (`lib/format.ts`) plutôt que composée ici : c'est là que vit la règle de repli
 * quand l'établissement n'a pas publié son pays, et deux façons de la calculer
 * finiraient par diverger. Le paramètre reste facultatif, comme dans
 * `lib/format.ts` et pour la même raison : les appelants hors de l'empreinte de
 * ce ticket gardent le comportement d'avant.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '@/lib/format';

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

/**
 * Le mois d'une date civile, tel que la navigation de période l'annonce —
 * « août 2026 ».
 *
 * C'est le libellé que `docs/design/appointments/wireframes.md` écrit entre les
 * deux chevrons de l'étape 3 (« ‹ août 2026 › »), et que `states.md` reprend
 * dans ses trois états. Il porte l'année parce qu'un calendrier ouvert en
 * décembre navigue vers janvier : « janvier » seul ne dirait pas lequel.
 *
 * Lu dans le référentiel UTC pour la raison qu'expose `formatCalendarDate` :
 * une date civile **est déjà** celle de l'établissement, et la reprojeter dans
 * son fuseau la décalerait d'un jour — donc, le 1er du mois, de tout un mois.
 *
 * Le nom du mois vient d'`Intl` et non d'un catalogue : « septembre » et
 * « September » sont des mots que la bibliothèque standard sait déjà dire, et
 * les recopier dans deux JSON ferait douze libellés à tenir par langue.
 */
export function formatCalendarMonth(date: CalendarDate, display?: DisplayLocale): string {
  return new Intl.DateTimeFormat(formattingLocale(display?.locale, display?.countryCode), {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}
