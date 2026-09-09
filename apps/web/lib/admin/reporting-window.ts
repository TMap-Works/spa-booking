/**
 * La période que l'écran de reporting affiche — et elle seule (#75, premier
 * critère).
 *
 * ## Deux référentiels, et ne jamais les confondre
 *
 * L'opérateur choisit des **dates civiles** : « du 1er au 30 septembre ». L'API,
 * elle, prend deux **instants** ISO 8601 à offset explicite, `from` inclus et
 * `to` exclu. Le pont entre les deux est le fuseau du salon, et c'est tout le
 * sujet de ce module : à Papeete, la journée du 3 mars ne commence pas au même
 * moment qu'à Paris, et lire les bornes en UTC décalerait la recette d'une
 * demi-journée sur tout salon éloigné de Greenwich.
 *
 * Le sens de conversion est donc toujours le même : date civile du salon →
 * minuit local → instant UTC. Aucune borne n'est construite autrement, et le
 * fuseau du navigateur n'intervient nulle part.
 *
 * ## `to` est exclu, et l'écran ne le montre jamais
 *
 * Le contrat de l'API est `[from, to[` — la convention de l'historique de
 * rapprochement (#62), celle qui permet de poser deux mois bout à bout sans
 * compter deux fois l'encaissement de minuit. Mais « du 1er au 30 » se dit avec
 * le 30 **inclus** : l'URL et l'écran portent donc la borne haute incluse, et la
 * conversion vers l'API ajoute la journée. Exposer le `to` exclu ferait
 * afficher « au 1er octobre » à qui a demandé septembre.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

import { addCalendarDays } from '../booking/calendar';

/**
 * Le plafond de la fenêtre, en journées — `MAX_REPORT_WINDOW_DAYS` du module
 * `reporting` de l'API, qui répond 422 au-delà.
 *
 * Recopié plutôt qu'importé : `apps/web` ne dépend pas de `apps/api`, et le
 * contrat partagé ne publie pas encore le vocabulaire du reporting (voir
 * `reporting-contract.ts`). Le refus reste celui du serveur ; le connaître ici
 * ne sert qu'à ne pas envoyer une requête dont on sait qu'elle sera refusée.
 *
 * 366 et non 365 : « l'année 2028 », du 1er janvier au 1er janvier suivant, fait
 * 366 jours sur une année bissextile.
 */
export const MAX_REPORT_WINDOW_DAYS = 366;

/**
 * Les périodes proposées, nommées comme l'URL les porte.
 *
 * En français, comme `?vue=semaine` du planning : les paramètres visibles de ce
 * back-office le sont déjà, et une valeur anglaise au milieu serait une
 * frontière de langue de plus à retenir.
 *
 * `personnalisee` n'est pas un raccourci : c'est ce que porte l'URL dès que
 * l'opérateur saisit ses propres bornes, et c'est ce qui distingue « les 30
 * derniers jours, quel que soit le jour où je rouvre l'écran » d'une plage figée
 * qu'on partage à un collègue.
 */
export const REPORT_PERIODS = [
  'sept-jours',
  'trente-jours',
  'mois-courant',
  'mois-precedent',
  'personnalisee',
] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** La période ouverte quand l'URL n'en désigne aucune. */
export const DEFAULT_REPORT_PERIOD: ReportPeriod = 'trente-jours';

/** Ce que l'opérateur lit — bornes **incluses**, en dates civiles du salon. */
export interface ReportRange {
  readonly from: CalendarDate;
  /** Dernière journée **comprise** dans la période. */
  readonly to: CalendarDate;
}

/** Ce que l'API reçoit — `from` inclus, `to` exclu, deux instants UTC. */
export interface ReportWindowQuery {
  readonly from: string;
  readonly to: string;
}

/** Le libellé d'une période, pour le sélecteur. */
export const REPORT_PERIOD_LABELS: Readonly<Record<ReportPeriod, string>> = {
  'sept-jours': '7 derniers jours',
  'trente-jours': '30 derniers jours',
  'mois-courant': 'Mois en cours',
  'mois-precedent': 'Mois précédent',
  personnalisee: 'Période personnalisée',
};

/**
 * La date civile qu'il est **dans le salon**, pas dans le navigateur ni sur le
 * serveur de rendu.
 */
export function todayInTenant(timeZone: TimeZone, now: Date = new Date()): CalendarDate {
  return civilDateInTimeZone(now, timeZone);
}

/**
 * La plage d'une période, bornes incluses, calées sur la journée du salon.
 *
 * Les périodes glissantes se terminent **aujourd'hui** et non hier : un gérant
 * qui ouvre l'écran à midi veut voir la matinée qu'il vient de faire. Les
 * encaissements du jour en cours sont partiels, et c'est ce que l'écran dit —
 * plutôt que d'escamoter la journée courante.
 */
export function rangeOfPeriod(
  period: ReportPeriod,
  timeZone: TimeZone,
  now: Date = new Date(),
): ReportRange {
  const today = todayInTenant(timeZone, now);

  switch (period) {
    case 'sept-jours':
      return { from: addCalendarDays(today, -6), to: today };
    case 'trente-jours':
      return { from: addCalendarDays(today, -29), to: today };
    case 'mois-courant':
      return { from: startOfMonth(today), to: today };
    case 'mois-precedent': {
      const previous = addCalendarDays(startOfMonth(today), -1);

      return { from: startOfMonth(previous), to: previous };
    }
    case 'personnalisee':
      // Sans bornes saisies, « personnalisée » n'a rien à désigner : on rend la
      // période par défaut plutôt qu'une plage vide, qui ferait un écran vide
      // sans dire pourquoi.
      return rangeOfPeriod(DEFAULT_REPORT_PERIOD, timeZone, now);
  }
}

/** Le premier jour du mois de `date`. */
function startOfMonth(date: CalendarDate): CalendarDate {
  return `${date.slice(0, 7)}-01`;
}

/** Nombre de journées d'une plage, bornes incluses. */
export function daysInRange(range: ReportRange): number {
  const from = Date.parse(`${range.from}T12:00:00Z`);
  const to = Date.parse(`${range.to}T12:00:00Z`);

  return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * Ce qui empêche une plage d'être demandée, ou `null` si elle est demandable.
 *
 * Les deux refus sont ceux de l'API — 422 sur une fenêtre inversée ou de plus
 * d'un an —, dits ici pour que l'opérateur les voie **sur le champ fautif**
 * plutôt qu'en retour d'un aller-retour (web-frontend §4). La garde qui compte
 * reste celle du serveur ; celle-ci n'est qu'un confort.
 */
export function rangeRefusal(range: ReportRange): string | null {
  // Une borne vidée n'est pas une borne : un champ de date rendu vide donne
  // `''`, dont la comparaison et le comptage de journées ne disent rien
  // (`NaN > 366` est faux). Sans ce refus, la saisie partait telle quelle,
  // l'URL portait `du=`, et l'écran retombait en silence sur les trente
  // derniers jours — en affichant toujours « Période personnalisée ».
  if (parseReportDate(range.from) === null || parseReportDate(range.to) === null) {
    return 'Renseignez les deux bornes de la période, au format jour/mois/année.';
  }

  if (range.to < range.from) {
    return 'La date de fin précède la date de début.';
  }

  const days = daysInRange(range);

  return days > MAX_REPORT_WINDOW_DAYS
    ? `Une période s’arrête à ${String(MAX_REPORT_WINDOW_DAYS)} jours — celle-ci en compte ${String(days)}.`
    : null;
}

/**
 * La plage civile du salon traduite en fenêtre d'API.
 *
 * `to` est la **journée suivant** la borne haute affichée : l'API exclut sa
 * borne de fin, et s'arrêter à minuit du dernier jour amputerait la période de
 * sa dernière journée entière — l'erreur qui fait qu'un rapport « du 1er au 30 »
 * ne compte rien du 30.
 */
export function windowOfRange(range: ReportRange, timeZone: TimeZone): ReportWindowQuery {
  return {
    from: startOfCivilDay(range.from, timeZone).toISOString(),
    to: startOfCivilDay(addCalendarDays(range.to, 1), timeZone).toISOString(),
  };
}

const MILLISECONDS_IN_MINUTE = 60 * 1000;

/**
 * L'instant UTC auquel commence la journée civile `date` dans `timeZone`.
 *
 * Le calcul est en deux passes, et la seconde n'est pas une précaution
 * théorique : le décalage d'un fuseau dépend de l'instant qu'on y lit, si bien
 * qu'une première estimation prise le mauvais côté d'un changement d'heure
 * donnerait une heure de trop. On lit donc le décalage à l'estimation, on
 * corrige, puis on relit le décalage au résultat — s'il a changé, c'est qu'on a
 * traversé la bascule, et c'est le second qui fait foi.
 *
 * Cas limite assumé : le jour où l'heure d'été fait sauter minuit, la journée
 * civile commence à 1 h locale. La fonction rend alors ce moment-là, qui est
 * bien le premier instant de cette journée dans ce fuseau.
 */
export function startOfCivilDay(date: CalendarDate, timeZone: TimeZone): Date {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const firstOffset = timeZoneOffsetMinutes(new Date(guess), timeZone);
  const candidate = guess - firstOffset * MILLISECONDS_IN_MINUTE;
  const secondOffset = timeZoneOffsetMinutes(new Date(candidate), timeZone);

  return firstOffset === secondOffset
    ? new Date(candidate)
    : new Date(guess - secondOffset * MILLISECONDS_IN_MINUTE);
}

/**
 * Le décalage de `timeZone` sur UTC, en minutes, **à cet instant précis**.
 *
 * Lu d'`Intl` et non d'une table : les règles d'heure d'été changent, et une
 * table locale finirait par diverger de la base IANA que la plateforme embarque.
 */
function timeZoneOffsetMinutes(instant: Date, timeZone: TimeZone): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );

  return Math.round((asUtc - instant.getTime()) / MILLISECONDS_IN_MINUTE);
}

/**
 * La date civile qu'affiche l'horloge de `timeZone` à cet instant.
 *
 * Même construction que `calendarDateInTimeZone` du parcours de réservation, et
 * pour la même raison : `formatToParts` plutôt qu'une locale complaisante, de
 * sorte que la sortie soit un `YYYY-MM-DD` par construction.
 */
function civilDateInTimeZone(instant: Date, timeZone: TimeZone): CalendarDate {
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

/** La période lue d'une chaîne de requête — le défaut, jamais d'erreur. */
export function parseReportPeriod(raw: string | undefined): ReportPeriod {
  return REPORT_PERIODS.find((period) => period === raw) ?? DEFAULT_REPORT_PERIOD;
}

/**
 * La date lue d'une chaîne de requête, ou `null` si elle n'en est pas une.
 *
 * Le motif est vérifié **et** la date rejouée : `2026-02-31` a la bonne forme et
 * n'existe pas au calendrier.
 */
export function parseReportDate(raw: string | undefined): CalendarDate | null {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return null;
  }

  const parsed = new Date(`${raw}T12:00:00Z`);

  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

/**
 * La plage que l'URL désigne, quelle que soit la cohérence de ce qu'elle porte.
 *
 * Une période personnalisée n'est retenue que si **les deux** bornes sont
 * lisibles : une seule ne décrit rien, et compléter l'autre au jugé afficherait
 * une période que personne n'a demandée. Tout le reste retombe sur la période
 * nommée, qui a toujours une plage.
 */
export function resolveReportRange(
  period: ReportPeriod,
  from: CalendarDate | null,
  to: CalendarDate | null,
  timeZone: TimeZone,
  now: Date = new Date(),
): ReportRange {
  if (period === 'personnalisee' && from !== null && to !== null) {
    return { from, to };
  }

  return rangeOfPeriod(period, timeZone, now);
}

const LOCALE = 'fr-FR';

/**
 * La période telle que l'écran l'annonce — « 1 – 30 septembre 2026 ».
 *
 * Les dates civiles sont mises en forme **en UTC** : elles sont déjà celles de
 * l'établissement, et les reprojeter dans son fuseau les décalerait d'un jour
 * pour tout salon à l'est de Greenwich. Même raison que `formatCalendarDate` de
 * `lib/format.ts`.
 */
export function rangeLabel(range: ReportRange): string {
  if (range.from === range.to) {
    return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', dateStyle: 'long' }).format(
      new Date(`${range.from}T00:00:00Z`),
    );
  }

  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const start = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    ...(sameMonth ? {} : { month: 'long' }),
    ...(range.from.slice(0, 4) === range.to.slice(0, 4) ? {} : { year: 'numeric' }),
  }).format(new Date(`${range.from}T00:00:00Z`));
  const end = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${range.to}T00:00:00Z`));

  return `${start} – ${end}`;
}

/** « 3 sept. » — l'abscisse d'un graphique quotidien. */
export function shortDayLabel(date: CalendarDate): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${date}T00:00:00Z`));
}
