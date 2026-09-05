/**
 * La période que le planning du back-office affiche — et elle seule (#49).
 *
 * ## Une plage est une paire de dates civiles, jamais une paire d'instants
 *
 * `appointmentListQuerySchema` prend `from` et `to` en **dates civiles**, et son
 * en-tête dit pourquoi : « le 3 mars » ne commence pas au même moment à Papeete
 * et à Paris, et c'est le fuseau de l'établissement — que seul le serveur
 * connaît — qui tranche. Ce module ne manipule donc jamais d'instant : il
 * calcule des journées, et le seul endroit où l'heure du navigateur intervient
 * est `todayInTimeZone`, qui demande explicitement dans quel fuseau lire
 * « aujourd'hui ».
 *
 * ## Pourquoi un « ancrage » distinct de la date affichée
 *
 * En vue semaine, le 26 et le 28 août 2026 désignent la **même** plage. Les
 * distinguer ferait charger deux fois la même semaine et raterait le cache au
 * moindre aller-retour. `anchorOf` ramène donc toute date à la borne de sa
 * période — elle-même en vue jour, le lundi de sa semaine en vue semaine —, et
 * c'est cet ancrage qui sert de clé.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

import { addCalendarDays, calendarDateInTimeZone } from '../booking/calendar';

/**
 * Les deux vues du planning, nommées comme l'URL les porte.
 *
 * En français parce que ce sont des valeurs d'URL — `?vue=semaine` — et que les
 * chemins du back-office le sont déjà (`/admin/calendrier`, `/admin/reglages`).
 * Un `?view=week` au milieu de chemins français serait une frontière de langue
 * de plus à retenir, sans rien apporter.
 */
export const CALENDAR_VIEWS = ['jour', 'semaine'] as const;

export type CalendarView = (typeof CALENDAR_VIEWS)[number];

/** La vue ouverte quand l'URL n'en désigne aucune — l'écran du matin. */
export const DEFAULT_CALENDAR_VIEW: CalendarView = 'jour';

/** Bornes incluses, comme celles de `appointmentListQuerySchema`. */
export interface CalendarRange {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
}

/** Nombre de journées qu'affiche une vue. */
export function daysInView(view: CalendarView): number {
  return view === 'jour' ? 1 : 7;
}

/** La date civile qu'il est **dans le salon**, pas dans le navigateur. */
export function todayInTimeZone(timeZone: TimeZone, now: Date = new Date()): CalendarDate {
  return calendarDateInTimeZone(now, timeZone);
}

/**
 * Le lundi de la semaine de `date`.
 *
 * Lundi et non dimanche : c'est la semaine ISO, celle qu'affichent les agendas
 * en France comme à Madagascar. Le calcul passe par midi UTC — sur une date lue
 * à minuit, une bascule d'heure d'été suffirait à retomber sur la veille, et la
 * semaine entière glisserait d'un jour.
 */
export function startOfWeek(date: CalendarDate): CalendarDate {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  // `getUTCDay` rend 0 pour dimanche : ramené à 6, lundi vaut 0.
  const sinceMonday = (weekday + 6) % 7;

  return addCalendarDays(date, -sinceMonday);
}

/**
 * La date qui **identifie** la période contenant `date`.
 *
 * C'est elle qui sert de clé de cache et qui part dans l'URL : deux dates d'une
 * même semaine doivent désigner la même période, sinon le préchargement de la
 * période adjacente ne serait jamais réutilisé.
 */
export function anchorOf(view: CalendarView, date: CalendarDate): CalendarDate {
  return view === 'jour' ? date : startOfWeek(date);
}

/** La plage couverte par la période qui contient `date`. */
export function rangeOf(view: CalendarView, date: CalendarDate): CalendarRange {
  const from = anchorOf(view, date);

  return { from, to: addCalendarDays(from, daysInView(view) - 1) };
}

/**
 * La période décalée de `steps` crans — un jour ou une semaine selon la vue.
 *
 * `steps` et non deux fonctions `previous`/`next` : le préchargement demande les
 * deux voisines d'un même geste, et une seule fonction évite qu'elles divergent.
 */
export function shiftAnchor(
  view: CalendarView,
  date: CalendarDate,
  steps: number,
): CalendarDate {
  return addCalendarDays(anchorOf(view, date), steps * daysInView(view));
}

/**
 * Les journées d'une plage, dans l'ordre — les colonnes de la vue semaine.
 */
export function daysOf(range: CalendarRange): CalendarDate[] {
  const days: CalendarDate[] = [];

  for (let day = range.from; day <= range.to; day = addCalendarDays(day, 1)) {
    days.push(day);
  }

  return days;
}

/**
 * La clé de cache d'une période.
 *
 * La vue en fait partie : la journée du 26 et la semaine qui la contient sont
 * deux jeux de rendez-vous différents, et les confondre servirait un jour entier
 * là où l'écran attend une semaine.
 */
export function rangeKey(view: CalendarView, date: CalendarDate): string {
  return `${view}:${anchorOf(view, date)}`;
}

/** La vue lue d'une chaîne de requête — `jour` par défaut, jamais d'erreur. */
export function parseCalendarView(raw: string | undefined): CalendarView {
  return CALENDAR_VIEWS.find((view) => view === raw) ?? DEFAULT_CALENDAR_VIEW;
}

/**
 * La date lue d'une chaîne de requête, ou `null` si elle n'en est pas une.
 *
 * Le motif est vérifié **et** la date rejouée : `2026-02-31` a la bonne forme et
 * n'existe pas au calendrier. C'est la même exigence que `calendarDateSchema` du
 * contrat, que ce module ne peut pas importer sans faire dépendre une lecture
 * d'URL d'une validation Zod complète.
 */
export function parseCalendarDate(raw: string | undefined): CalendarDate | null {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }

  const parsed = new Date(`${raw}T12:00:00Z`);

  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

const LOCALE = 'fr-FR';

/**
 * Le libellé de la période, tel que la barre d'outils l'affiche.
 *
 * Les dates civiles sont mises en forme **en UTC** : elles sont déjà celles de
 * l'établissement, et les reprojeter dans son fuseau les décalerait d'un jour
 * pour tout salon à l'est de Greenwich. Même raison que `formatCalendarDate` de
 * `lib/format.ts`.
 */
export function rangeLabel(view: CalendarView, date: CalendarDate): string {
  const range = rangeOf(view, date);

  if (view === 'jour') {
    return capitalize(
      new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', dateStyle: 'full' }).format(
        new Date(`${range.from}T00:00:00Z`),
      ),
    );
  }

  return `${formatDayAndMonth(range.from, range.to)}`;
}

/** « 24 – 30 août 2026 », ou « 29 septembre – 5 octobre 2026 » à cheval sur deux mois. */
function formatDayAndMonth(from: CalendarDate, to: CalendarDate): string {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);

  const startText = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    ...(sameMonth ? {} : { month: 'long' }),
  }).format(start);

  const endText = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(end);

  return `${startText} – ${endText}`;
}

/** L'en-tête d'une colonne de la vue semaine — « Lun 24 ». */
export function weekdayLabel(date: CalendarDate): string {
  return capitalize(
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: 'UTC',
      weekday: 'short',
      day: 'numeric',
    }).format(new Date(`${date}T00:00:00Z`)),
  );
}

/**
 * Première lettre en capitale.
 *
 * `Intl` rend « mardi 26 août 2026 » en minuscule — correct en typographie
 * française au fil du texte, mais ce libellé est un titre de barre d'outils.
 */
function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
