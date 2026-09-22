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
import { formattingLocale, type DisplayLocale } from '../format';

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
 * Le jour qui ouvre la semaine — `1` lundi, `0` dimanche (#848).
 *
 * La numérotation est celle de `Date.getUTCDay`, et elle s'arrête à ces deux
 * valeurs : ce sont les deux seules que les régions du MVP emploient. Les pays
 * dont la semaine ouvre le samedi — le Golfe, pour l'essentiel — sortent du
 * périmètre, et les servir demanderait une table de bien plus de deux entrées.
 */
export type WeekStart = 0 | 1;

/** Le jour d'ouverture par défaut — la semaine ISO 8601, celle de la France. */
export const DEFAULT_WEEK_START: WeekStart = 1;

/**
 * Les régions où la semaine s'ouvre le **dimanche** (CLDR, `weekData/firstDay`).
 *
 * Une table figée plutôt que `Intl.Locale.prototype.getWeekInfo` : la méthode
 * n'existe ni sur Node 20 — qui n'a que l'accesseur `weekInfo` — ni sur les
 * navigateurs d'avant 2025, et le planning se rend **des deux côtés**. Une
 * réponse qui diffère entre le serveur et le navigateur ferait ancrer la période
 * sur deux lundis différents, c'est-à-dire charger une semaine et en afficher
 * une autre. Une table se lit à l'identique partout.
 *
 * Tout ce qui n'y figure pas ouvre la semaine le lundi — le cas de la France, de
 * Madagascar et de l'immense majorité de l'Europe.
 */
const SUNDAY_FIRST_REGIONS: ReadonlySet<string> = new Set([
  'AG', 'AS', 'AU', 'BD', 'BR', 'BS', 'BT', 'BW', 'BZ', 'CA', 'CN', 'CO', 'DM',
  'DO', 'ET', 'GT', 'GU', 'HK', 'HN', 'ID', 'IL', 'IN', 'JM', 'JP', 'KE', 'KH',
  'KR', 'LA', 'MH', 'MM', 'MO', 'MT', 'MX', 'MZ', 'NI', 'NP', 'PA', 'PE', 'PH',
  'PK', 'PR', 'PY', 'SA', 'SG', 'SV', 'TH', 'TT', 'TW', 'UM', 'US', 'VE', 'VI',
  'WS', 'YE', 'ZA', 'ZW',
]);

/**
 * Le jour qui ouvre la semaine **de l'établissement** — jamais celui de la
 * langue de qui regarde (#848, deuxième critère).
 *
 * Un salon de Boston tient son planning du dimanche au samedi, y compris quand
 * une gérante francophone le consulte ; un salon parisien le tient du lundi au
 * dimanche, y compris pour une praticienne anglophone. C'est donc
 * `Tenant.countryCode` qui décide — le même champ dont `lib/format.ts` tire la
 * région de ses formats — et non la langue résolue.
 *
 * Un pays vide ou mal formé retombe sur le lundi : c'est le comportement
 * d'avant ce ticket, et il vaut mieux qu'une devinette sur le fuseau du serveur.
 */
export function weekStartOf(countryCode?: string | null | undefined): WeekStart {
  if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) {
    return DEFAULT_WEEK_START;
  }

  return SUNDAY_FIRST_REGIONS.has(countryCode.toUpperCase()) ? 0 : DEFAULT_WEEK_START;
}

/**
 * Le premier jour de la semaine de `date`.
 *
 * Lundi par défaut — la semaine ISO, celle qu'affichent les agendas en France
 * comme à Madagascar —, dimanche quand la région de l'établissement l'ouvre
 * ainsi (#848). Le calcul passe par midi UTC : sur une date lue à minuit, une
 * bascule d'heure d'été suffirait à retomber sur la veille, et la semaine
 * entière glisserait d'un jour.
 */
export function startOfWeek(
  date: CalendarDate,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): CalendarDate {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  // `getUTCDay` rend 0 pour dimanche. Le modulo ramène l'écart au premier jour
  // dans `[0, 6]` quel que soit celui qui ouvre la semaine.
  const sinceFirst = (weekday - weekStart + 7) % 7;

  return addCalendarDays(date, -sinceFirst);
}

/**
 * La date qui **identifie** la période contenant `date`.
 *
 * C'est elle qui sert de clé de cache et qui part dans l'URL : deux dates d'une
 * même semaine doivent désigner la même période, sinon le préchargement de la
 * période adjacente ne serait jamais réutilisé.
 */
export function anchorOf(
  view: CalendarView,
  date: CalendarDate,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): CalendarDate {
  return view === 'jour' ? date : startOfWeek(date, weekStart);
}

/** La plage couverte par la période qui contient `date`. */
export function rangeOf(
  view: CalendarView,
  date: CalendarDate,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): CalendarRange {
  const from = anchorOf(view, date, weekStart);

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
  weekStart: WeekStart = DEFAULT_WEEK_START,
): CalendarDate {
  return addCalendarDays(anchorOf(view, date, weekStart), steps * daysInView(view));
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
export function rangeKey(
  view: CalendarView,
  date: CalendarDate,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): string {
  return `${view}:${anchorOf(view, date, weekStart)}`;
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

/**
 * Le repli d'affichage, quand l'appelant n'a pas encore de langue à passer.
 *
 * Même arbitrage que `lib/format.ts` : le français, c'est-à-dire le
 * comportement d'avant l'épique #843, plutôt qu'un basculement en anglais
 * d'écrans dont la traduction n'aurait pas été relue.
 */
const FALLBACK_DISPLAY: DisplayLocale = { locale: 'fr' };

/** L'étiquette `Intl` d'un contexte d'affichage — langue **et** région du salon. */
function tag(display: DisplayLocale): string {
  return formattingLocale(display.locale, display.countryCode);
}

/**
 * Le libellé de la période, tel que la barre d'outils l'affiche.
 *
 * Les dates civiles sont mises en forme **en UTC** : elles sont déjà celles de
 * l'établissement, et les reprojeter dans son fuseau les décalerait d'un jour
 * pour tout salon à l'est de Greenwich. Même raison que `formatCalendarDate` de
 * `lib/format.ts`.
 *
 * La langue vient de la session, la **région** de l'établissement (#848) : c'est
 * ce qui distingue « Wednesday, August 26, 2026 » d'un salon de Boston de
 * « Wednesday 26 August 2026 » d'un salon londonien, sans que le rendez-vous qui
 * s'y trouve bouge d'une minute.
 */
export function rangeLabel(
  view: CalendarView,
  date: CalendarDate,
  display: DisplayLocale = FALLBACK_DISPLAY,
  weekStart: WeekStart = DEFAULT_WEEK_START,
): string {
  const range = rangeOf(view, date, weekStart);

  if (view === 'jour') {
    return capitalize(
      new Intl.DateTimeFormat(tag(display), { timeZone: 'UTC', dateStyle: 'full' }).format(
        new Date(`${range.from}T00:00:00Z`),
      ),
      display,
    );
  }

  return formatDayAndMonth(range.from, range.to, display);
}

/** « 24 – 30 août 2026 », ou « 29 septembre – 5 octobre 2026 » à cheval sur deux mois. */
function formatDayAndMonth(
  from: CalendarDate,
  to: CalendarDate,
  display: DisplayLocale,
): string {
  const intlTag = tag(display);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);

  const startText = new Intl.DateTimeFormat(intlTag, {
    timeZone: 'UTC',
    day: 'numeric',
    ...(sameMonth ? {} : { month: 'long' }),
  }).format(start);

  const endText = new Intl.DateTimeFormat(intlTag, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(end);

  return `${startText} – ${endText}`;
}

/**
 * L'en-tête d'une colonne de la vue semaine — « Lun. 24 », « Mon 24 ».
 *
 * Le jour et le quantième sont mis en forme **séparément** puis joints, plutôt
 * que demandés d'un seul squelette : `{ weekday: 'short', day: 'numeric' }` rend
 * « 24 Mon » en `en-US`, où CLDR place le quantième en tête. Deux formats et une
 * espace donnent le même résultat qu'avant en français et l'ordre attendu en
 * anglais.
 */
export function weekdayLabel(
  date: CalendarDate,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  const intlTag = tag(display);
  const day = new Date(`${date}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat(intlTag, {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(day);
  const number = new Intl.DateTimeFormat(intlTag, { timeZone: 'UTC', day: 'numeric' }).format(day);

  return capitalize(`${weekday} ${number}`, display);
}

/**
 * Première lettre en capitale.
 *
 * `Intl` rend « mardi 26 août 2026 » en minuscule — correct en typographie
 * française au fil du texte, mais ce libellé est un titre de barre d'outils.
 * L'anglais capitalise déjà ses noms de jours et de mois : la fonction n'y
 * change alors rien.
 *
 * La mise en casse passe par la langue d'affichage : elle dépend de l'alphabet,
 * et c'est la même discipline que `lib/appointment-status.ts`.
 */
function capitalize(text: string, display: DisplayLocale): string {
  return text.length === 0
    ? text
    : `${text.charAt(0).toLocaleUpperCase(display.locale)}${text.slice(1)}`;
}
