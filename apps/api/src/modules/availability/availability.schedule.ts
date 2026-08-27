/**
 * Horaires récurrents du personnel — le calcul, sans base ni HTTP (#32).
 *
 * Une semaine de travail se décrit en **heures murales** : « le mardi, de 09:00
 * à 12:00 et de 14:00 à 18:00 ». Le calcul de créneaux, lui, ne sait manipuler
 * que des instants. Ce module est la traversée entre les deux, et il ne la fait
 * jamais lui-même : il délègue chaque conversion à l'horloge de l'établissement
 * (`TenantClockService`, #41), qui recalcule l'offset **pour l'instant
 * considéré**.
 *
 * ## Ce qui n'est stocké nulle part
 *
 * Aucun décalage. Une plage vaut `09:00–12:00` toute l'année ; les instants
 * qu'elle produit valent `08:00Z–11:00Z` en janvier et `07:00Z–10:00Z` en
 * juillet, parce que la question est reposée à chaque date. C'est la seule
 * façon de traverser un changement d'heure sans décaler l'agenda — CDC §6,
 * sévérité haute.
 *
 * ## Les deux anomalies du changement d'heure, ici
 *
 * Une borne de fenêtre de travail n'est pas un rendez-vous : elle n'a pas à
 * refuser une heure ambiguë ou inexistante. La politique `compatible` de
 * `resolveWallTime` suffit et est même la seule raisonnable — le jour du passage
 * à l'heure d'été, une journée `09:00–18:00` reste une journée de travail, elle
 * dure simplement une heure de moins en instants. C'est `requireExactInstant`,
 * du côté de la **création** de rendez-vous, qui refuse de trancher.
 */

import {
  CALENDAR_DATE_PATTERN,
  LOCAL_TIME_PATTERN,
  type UtcRange,
  type ZonedResolution,
  type ZonedWallTime,
} from './availability.time';

/**
 * Les sept jours, en numérotation **ISO 8601** : 1 lundi … 7 dimanche.
 *
 * Pas le `0`-dimanche de `Date.prototype.getDay`. `0` est *falsy* : un
 * `weekday ?? défaut`, un `weekday || 1`, un `if (weekday)` traiteraient le
 * dimanche comme une valeur absente, et le praticien qui travaille le dimanche
 * verrait son horaire disparaître sans qu'aucun test de forme ne rougisse.
 *
 * TODO(#26) : cette numérotation est celle d'`isoWeekdaySchema` dans
 * `@spa/shared`. Elle en sera importée le jour où `apps/api` dépendra du paquet
 * — même TODO que `LOCAL_TIME_PATTERN` et `AVAILABILITY_ERROR_CODES`.
 */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export type IsoWeekday = (typeof ISO_WEEKDAYS)[number];

/** Minutes d'une journée civile de 24 heures — la borne haute d'une plage. */
export const MINUTES_IN_CIVIL_DAY = 1440;

/**
 * Minuit **de fin de journée**, la seule heure de fermeture que `HH:MM` ne sait
 * pas dire — la borne haute d'une plage est exclue, elle ne désigne pas une
 * heure vécue. Même littéral que `END_OF_DAY_LOCAL_TIME` du contrat partagé.
 */
export const END_OF_DAY_LOCAL_TIME = '24:00';

/** Une plage récurrente, telle que la base la porte : des minutes, pas des instants. */
export interface ScheduleRange {
  readonly weekday: IsoWeekday;
  /** Minutes depuis minuit local, 0 à 1439. */
  readonly startMinute: number;
  /** Minutes depuis minuit local, 1 à 1440 — borne exclue. */
  readonly endMinute: number;
}

/** Une fenêtre de travail réelle, sur une date donnée, en instants UTC. */
export interface WorkingWindow extends UtcRange {
  /** La date civile du tenant à laquelle cette fenêtre appartient. */
  readonly date: string;
  readonly weekday: IsoWeekday;
}

/**
 * Ce que le calcul attend de l'horloge de l'établissement.
 *
 * Un **port**, et non l'injection du service : ces fonctions restent exerçables
 * sans conteneur Nest, et `TenantClockService` le satisfait tel quel. C'est lui
 * qui valide le fuseau une fois pour toutes et traduit un fuseau inconnu en
 * erreur de domaine plutôt qu'en 500.
 */
export interface WallClock {
  resolveWallTime(wall: ZonedWallTime, timeZone: string): ZonedResolution;
  dayRange(calendarDate: string, timeZone: string): UtcRange;
}

const DAY_MS = 86_400_000;

/** `true` si l'entier désigne un jour de semaine ISO. */
export function isIsoWeekday(value: number): value is IsoWeekday {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

/**
 * Découpe une date civile en ses trois composants.
 *
 * Le refus est un `RangeError` et non une erreur de domaine : arriver ici avec
 * une date mal formée est un défaut de programmation, le DTO l'aurait refusée en
 * 400 bien avant. Même arbitrage que `wallTimeAt` dans `availability.time.ts`.
 */
function calendarPartsOf(calendarDate: string): { year: number; month: number; day: number } {
  const matched = CALENDAR_DATE_PATTERN.exec(calendarDate);

  if (matched === null) {
    throw new RangeError(`date civile attendue au format YYYY-MM-DD : « ${calendarDate} »`);
  }

  return { year: Number(matched[1]), month: Number(matched[2]), day: Number(matched[3]) };
}

/**
 * Jour de semaine ISO d'une **date civile du tenant**.
 *
 * Aucun fuseau n'entre dans ce calcul, et c'est le point : une date civile est
 * déjà exprimée dans le calendrier de l'établissement. Chercher l'instant
 * correspondant avant d'en lire le jour ferait dépendre le résultat du fuseau,
 * et déplacerait un horaire d'un jour entier de part et d'autre de minuit.
 */
export function isoWeekdayOf(calendarDate: string): IsoWeekday {
  const { year, month, day } = calendarPartsOf(calendarDate);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  probe.setUTCHours(0, 0, 0, 0);

  const jsDay = probe.getUTCDay();

  // `getUTCDay` rend 0 pour dimanche ; ISO 8601 le numérote 7.
  return (jsDay === 0 ? 7 : jsDay) as IsoWeekday;
}

/**
 * Heure murale `HH:MM` → minutes depuis minuit local. `24:00` vaut 1440.
 *
 * Le motif est celui du moteur de conversion (`LOCAL_TIME_PATTERN`) : le DTO
 * refuse en 400 exactement ce que cette fonction refuserait en `RangeError`.
 */
export function localTimeToMinutes(localTime: string): number {
  if (localTime === END_OF_DAY_LOCAL_TIME) {
    return MINUTES_IN_CIVIL_DAY;
  }

  const matched = LOCAL_TIME_PATTERN.exec(localTime);

  if (matched === null) {
    throw new RangeError(`heure locale attendue au format HH:MM : « ${localTime} »`);
  }

  return Number(matched[1]) * 60 + Number(matched[2]);
}

/** L'inverse — 1440 se rend `24:00`, la borne haute d'une journée. */
export function minutesToLocalTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > MINUTES_IN_CIVIL_DAY) {
    throw new RangeError(`minutes depuis minuit hors de la journée civile : ${String(minutes)}`);
  }

  if (minutes === MINUTES_IN_CIVIL_DAY) {
    return END_OF_DAY_LOCAL_TIME;
  }

  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/**
 * Le premier recouvrement d'une semaine de travail, ou `null`.
 *
 * Rend le **couple fautif** et non un booléen : le message d'erreur doit dire
 * lesquelles des vingt-huit plages possibles se marchent dessus, faute de quoi
 * l'utilisateur relit sa semaine entière pour trouver la faute.
 *
 * L'adjacence (`fin === début`) est tolérée : c'est une journée continue décrite
 * en deux morceaux, pas un double emploi — la borne haute est exclue.
 */
export function firstOverlap(
  ranges: readonly ScheduleRange[],
): { readonly left: ScheduleRange; readonly right: ScheduleRange } | null {
  const byWeekday = new Map<IsoWeekday, ScheduleRange[]>();

  for (const range of ranges) {
    const sameDay = byWeekday.get(range.weekday) ?? [];
    const clash = sameDay.find(
      (other) => range.startMinute < other.endMinute && other.startMinute < range.endMinute,
    );

    if (clash !== undefined) {
      return { left: clash, right: range };
    }

    sameDay.push(range);
    byWeekday.set(range.weekday, sameDay);
  }

  return null;
}

/** Minuit UTC d'une date civile — le repère commun des deux fonctions qui suivent. */
function utcMidnightOf(calendarDate: string): Date {
  const { year, month, day } = calendarPartsOf(calendarDate);
  const midnight = new Date(0);
  midnight.setUTCFullYear(year, month - 1, day);
  midnight.setUTCHours(0, 0, 0, 0);

  return midnight;
}

/**
 * Nombre de dates civiles de `from` à `to`, bornes comprises — `0` ou moins sur
 * une plage inversée.
 *
 * Se **compte sans s'énumérer**, et c'est tout l'objet de cette fonction : le
 * refus d'une plage trop large est une protection contre un déni de service, et
 * la faire précéder de la construction de la liste qu'elle refuse ferait payer
 * exactement le coût qu'elle existe pour éviter. Même définition que
 * `calendarDaysBetween` du contrat partagé (TODO(#26)).
 */
export function calendarDaysBetween(from: string, to: string): number {
  const span = utcMidnightOf(to).getTime() - utcMidnightOf(from).getTime();

  return Math.round(span / DAY_MS) + 1;
}

/**
 * Les dates civiles de `from` à `to`, bornes comprises.
 *
 * L'itération se fait en UTC sur des composants de date, jamais en ajoutant
 * 24 heures à un instant local : une journée civile dure 23 ou 25 heures deux
 * fois par an, et l'addition ferait sauter — ou répéter — un jour.
 */
export function eachCalendarDate(from: string, to: string): string[] {
  const cursor = utcMidnightOf(from);
  const last = utcMidnightOf(to);

  const dates: string[] = [];

  while (cursor.getTime() <= last.getTime()) {
    dates.push(
      `${String(cursor.getUTCFullYear()).padStart(4, '0')}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`,
    );
    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return dates;
}

/**
 * L'instant que désigne une minute murale sur une date civile donnée.
 *
 * `1440` — minuit de fin de journée — passe par `dayRange`, qui sait que le
 * lendemain du 31 mars est le 1er avril et que la journée ne dure pas toujours
 * 24 heures. Le calculer comme « début + 1440 minutes » laisserait une heure
 * hors de la journée en octobre et en inventerait une en mars.
 */
function instantAtMinute(
  clock: WallClock,
  calendarDate: string,
  minute: number,
  timeZone: string,
): Date {
  if (minute === MINUTES_IN_CIVIL_DAY) {
    return clock.dayRange(calendarDate, timeZone).endsAt;
  }

  const { year, month, day } = calendarPartsOf(calendarDate);

  return clock.resolveWallTime(
    {
      year,
      month,
      day,
      hour: Math.floor(minute / 60),
      minute: minute % 60,
      second: 0,
    },
    timeZone,
  ).instant;
}

/** Ce dont le calcul de fenêtres a besoin, et rien d'autre. */
export interface WorkingWindowsInput {
  /** Les plages récurrentes du praticien, tous jours confondus. */
  readonly ranges: readonly ScheduleRange[];
  /** Les jours où l'établissement est fermé — aucune fenêtre n'y est produite. */
  readonly closedWeekdays: ReadonlySet<IsoWeekday>;
  /** Fuseau IANA de l'établissement. */
  readonly timeZone: string;
  /** Première et dernière date civile, bornes comprises. */
  readonly from: string;
  readonly to: string;
}

/**
 * Les fenêtres de travail réelles d'un praticien sur une plage de dates.
 *
 * C'est l'entrée que consommera le calcul de créneaux (#34) : « horaires − jours
 * de fermeture », auquel il retranchera ensuite les congés (#33) et les
 * rendez-vous déjà pris.
 *
 * Les fenêtres sont rendues **triées par instant de début**, ce que l'ordre
 * naturel du parcours ne garantit pas : deux plages du même jour peuvent arriver
 * dans n'importe quel ordre depuis la base, et le calcul de créneaux suppose un
 * ordre.
 *
 * Une fenêtre dont les deux bornes tombent sur le même instant est écartée. Le
 * cas n'existe que le jour d'un passage à l'heure d'été, sur une plage
 * entièrement contenue dans le trou d'horloge — `02:00–03:00` à Paris fin mars,
 * une heure qui n'a pas eu lieu. La rendre proposerait un créneau vide.
 */
export function workingWindows(clock: WallClock, input: WorkingWindowsInput): WorkingWindow[] {
  const byWeekday = new Map<IsoWeekday, ScheduleRange[]>();

  for (const range of input.ranges) {
    const sameDay = byWeekday.get(range.weekday) ?? [];
    sameDay.push(range);
    byWeekday.set(range.weekday, sameDay);
  }

  const windows: WorkingWindow[] = [];

  for (const date of eachCalendarDate(input.from, input.to)) {
    const weekday = isoWeekdayOf(date);

    if (input.closedWeekdays.has(weekday)) {
      continue;
    }

    for (const range of byWeekday.get(weekday) ?? []) {
      const startsAt = instantAtMinute(clock, date, range.startMinute, input.timeZone);
      const endsAt = instantAtMinute(clock, date, range.endMinute, input.timeZone);

      if (endsAt.getTime() <= startsAt.getTime()) {
        continue;
      }

      windows.push({ date, weekday, startsAt, endsAt });
    }
  }

  return windows.sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
