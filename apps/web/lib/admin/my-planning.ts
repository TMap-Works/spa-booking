import {
  isoWeekdayOf,
  type AppointmentStatus,
  type CalendarDate,
  type Locale,
  type MyStaffAppointment,
  type MyStaffSchedule,
  type TimeZone,
} from '@spa/shared';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import { formatTimeInTimeZone, formattingLocale, type DisplayLocale } from '@/lib/format';
import en from '@/messages/en/admin-my-planning.json';
import fr from '@/messages/fr/admin-my-planning.json';

/**
 * « Mon planning » — l'emploi du temps du praticien connecté (#813), ce qui se
 * décide sans DOM : la vue, la fenêtre à demander à l'API, les horaires d'une
 * journée, les rendez-vous rangés par jour.
 *
 * Toutes les dates civiles sont **celles du salon** : le praticien travaille
 * dans le fuseau de son salon, pas dans celui de son téléphone.
 *
 * ## Les mots viennent du catalogue, pas de ce fichier (#1104)
 *
 * Deux choses seulement en rendent : le nom des trois vues, et ce qu'une journée
 * de travail dit d'elle-même — « Salon fermé » relève de l'écran, mais « minuit »
 * et « Toute la journée » se composent ici, au milieu d'un calcul d'heures. Elles
 * les lisent dans `messages/<langue>/admin-my-planning.json` par **import direct
 * des deux fichiers**, comme `lib/admin/calendar-messages.ts` et
 * `lib/appointment-status.ts` lisent les leurs : ce module est fait de fonctions
 * pures, appelées depuis un Server Component, depuis un Client Component et
 * depuis des tests sans DOM, où aucun crochet de `next-intl` n'existe. Ce sont
 * **les mêmes fichiers** que ceux qu'`useTranslations` sert à l'écran — il n'y a
 * qu'une écriture de ce vocabulaire, et le test de parité la garde entière dans
 * les deux langues.
 *
 * Aucun des messages lus ici n'a de forme plurielle ni de paramètre : un accès
 * direct à la valeur suffit, sans formateur ICU à monter.
 */

/** Les deux catalogues, dans l'ordre où le front les sert. */
const CATALOG = { fr, en } as const;

/**
 * La langue employée quand l'appelant n'en passe pas.
 *
 * `fr` et non `DEFAULT_LOCALE` : ce défaut garde le comportement d'avant #1104
 * pour les tests qui éprouvent les libellés français de ce module, plutôt que de
 * les faire basculer en anglais. L'écran, lui, passe toujours sa langue résolue.
 */
const FALLBACK_LOCALE: Locale = 'fr';

/** Les trois vues de l'écran — dans l'adresse (`?vue=`), en français. */
export const MY_PLANNING_VIEWS = ['jour', 'semaine', 'a-venir'] as const;

export type MyPlanningView = (typeof MY_PLANNING_VIEWS)[number];

/**
 * Le nom des trois onglets, dans la langue demandée.
 *
 * La **clé** reste française — c'est un segment d'URL (`?vue=semaine`), et le
 * traduire changerait les adresses d'un salon anglophone sans rien lui apprendre.
 * Seul le libellé suit la langue.
 */
export function myPlanningViewLabels(
  locale: Locale = FALLBACK_LOCALE,
): Readonly<Record<MyPlanningView, string>> {
  return CATALOG[locale].views;
}

/** La vue demandée, ou la journée — la vue qu'on consulte entre deux soins. */
export function parseMyPlanningView(raw: string | undefined): MyPlanningView {
  return (MY_PLANNING_VIEWS as readonly string[]).includes(raw ?? '')
    ? (raw as MyPlanningView)
    : 'jour';
}

/** L'horizon de la vue « À venir » : trente et un jours, la borne de l'API. */
export const UPCOMING_DAYS = 31;

/** Le lundi de la semaine qui contient cette date civile. */
export function mondayOfDate(date: CalendarDate): CalendarDate {
  return addCalendarDays(date, 1 - isoWeekdayOf(date));
}

/**
 * La fenêtre à demander à l'API pour une vue — bornes **comprises**, comme
 * `GET /me/appointments` les compte.
 */
export function planningRange(
  view: MyPlanningView,
  anchor: CalendarDate,
  today: CalendarDate,
): { readonly from: CalendarDate; readonly to: CalendarDate } {
  switch (view) {
    case 'jour':
      return { from: anchor, to: anchor };
    case 'semaine': {
      const monday = mondayOfDate(anchor);
      return { from: monday, to: addCalendarDays(monday, 6) };
    }
    case 'a-venir':
      return { from: today, to: addCalendarDays(today, UPCOMING_DAYS - 1) };
  }
}

/** La période voisine — un jour ou une semaine plus tôt ou plus tard. */
export function shiftPlanningAnchor(
  view: MyPlanningView,
  anchor: CalendarDate,
  direction: -1 | 1,
): CalendarDate {
  return addCalendarDays(anchor, view === 'semaine' ? 7 * direction : direction);
}

/** Les journées d'une fenêtre, dans l'ordre. */
export function daysOf(from: CalendarDate, to: CalendarDate): readonly CalendarDate[] {
  const days: CalendarDate[] = [];
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/** Les rendez-vous rangés par journée du salon, chacune triée par heure. */
export function appointmentsByDay(
  appointments: readonly MyStaffAppointment[],
  timeZone: TimeZone,
): ReadonlyMap<CalendarDate, readonly MyStaffAppointment[]> {
  const days = new Map<CalendarDate, MyStaffAppointment[]>();

  for (const appointment of [...appointments].sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt),
  )) {
    const day = calendarDateInTimeZone(new Date(appointment.startsAt), timeZone);
    const list = days.get(day) ?? [];
    list.push(appointment);
    days.set(day, list);
  }

  return days;
}

/** Les statuts d'un rendez-vous qui reste à venir — ni passé, ni annulé. */
const STILL_EXPECTED: ReadonlySet<AppointmentStatus> = new Set(['pending', 'confirmed']);

/** Les rendez-vous encore attendus : à venir, et ni annulés ni déjà clos. */
export function upcomingOnly(
  appointments: readonly MyStaffAppointment[],
  now: Date,
): readonly MyStaffAppointment[] {
  return appointments.filter(
    (appointment) =>
      STILL_EXPECTED.has(appointment.status) && Date.parse(appointment.endsAt) > now.getTime(),
  );
}

/** Les trois morceaux d'une date, tels que la colonne de gauche les empile. */
export interface AgendaDate {
  /** « mer. » — le jour de la semaine, abrégé. */
  readonly weekday: string;
  /** « 23 » — le quantième, en chiffres tabulaires à l'écran. */
  readonly number: string;
  /** « sept. » — le mois, abrégé. */
  readonly month: string;
}

/**
 * La date d'une journée découpée pour la colonne de gauche de l'agenda.
 *
 * Trois morceaux plutôt qu'une phrase : c'est ce qui permet de peindre le
 * quantième plus gros que le reste, et de tenir une colonne de neuf rem au lieu
 * des trois lignes qu'occupait « mercredi 23 septembre 2026 ». L'année n'y est
 * pas — la barre de période la porte déjà, et la répéter à chaque journée d'une
 * semaine n'apprend rien.
 *
 * Le nom complet de la journée n'est pas perdu pour autant : l'écran le pose en
 * texte masqué dans le titre de la section, et ce sont ces abréviations qui
 * portent `aria-hidden` — un lecteur d'écran annoncerait « mer. » sans rien en
 * faire.
 *
 * Mise en forme **en UTC**, pour la raison qui vaut pour `formatCalendarDate` :
 * une date civile est déjà celle de l'établissement, et la reprojeter dans son
 * fuseau la décalerait d'un jour à l'est de Greenwich.
 */
export function agendaDate(
  day: CalendarDate,
  display: DisplayLocale = { locale: FALLBACK_LOCALE },
): AgendaDate {
  const midnight = new Date(`${day}T00:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions): string =>
    new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
      timeZone: 'UTC',
      ...options,
    }).format(midnight);

  return {
    weekday: part({ weekday: 'short' }),
    number: part({ day: 'numeric' }),
    month: part({ month: 'short' }),
  };
}

/**
 * Le prochain rendez-vous encore attendu, s'il y en a un.
 *
 * C'est la seule ligne que la praticienne cherche en sortant d'un soin : elle
 * est donc désignée à l'écran plutôt que laissée à compter dans la liste. Le
 * « prochain » se lit sur la même définition que la vue « À venir » — ni passé,
 * ni annulé — pour qu'un rendez-vous marqué en soit retiré sans autre règle.
 */
export function nextAppointment(
  appointments: readonly MyStaffAppointment[],
  now: Date,
): MyStaffAppointment | null {
  let soonest: MyStaffAppointment | null = null;

  for (const candidate of upcomingOnly(appointments, now)) {
    if (soonest === null || candidate.startsAt < soonest.startsAt) {
      soonest = candidate;
    }
  }

  return soonest;
}

/**
 * Ce que pèse une période : ses rendez-vous, les annulés exceptés.
 *
 * Un rendez-vous annulé reste affiché — la praticienne doit savoir qu'un
 * créneau s'est libéré — mais il ne charge plus sa journée, et le compter le
 * ferait mentir.
 */
export function bookedCount(appointments: readonly MyStaffAppointment[]): number {
  return appointments.filter((appointment) => appointment.status !== 'cancelled').length;
}

/**
 * La période affichée contient-elle la journée courante du salon ?
 *
 * Ce que le retour « Aujourd'hui » a besoin de savoir pour ne pas se proposer
 * quand il ne mène nulle part. Comparaison de chaînes : une `CalendarDate` est
 * un `AAAA-MM-JJ`, dont l'ordre lexicographique est l'ordre chronologique.
 */
export function showsToday(
  from: CalendarDate,
  to: CalendarDate,
  today: CalendarDate,
): boolean {
  return from <= today && today <= to;
}

/** « Rina A. » — la cliente telle que l'API la sert au praticien. */
export function clientLabel(appointment: MyStaffAppointment): string {
  return appointment.client.lastInitial === ''
    ? appointment.client.firstName
    : `${appointment.client.firstName} ${appointment.client.lastInitial}.`;
}

/** Ce que le praticien a à savoir de sa journée, avant ses rendez-vous. */
export interface WorkingDay {
  /** Le salon est fermé ce jour de la semaine. */
  readonly closed: boolean;
  /** Ses plages de travail — « 09:00 – 12:00 ». Vide : il ne travaille pas. */
  readonly hours: readonly string[];
  /** Ses absences qui touchent la journée — « 14:00 – 16:00 · Formation ». */
  readonly absences: readonly string[];
}

/**
 * La journée d'un praticien d'après ses horaires, ses absences et les
 * fermetures du salon.
 *
 * Une absence qui déborde la journée s'affiche bornée à celle-ci : « toute la
 * journée » quand elle la couvre entière, plutôt qu'une heure de début tombée
 * trois jours plus tôt.
 *
 * `display` porte la langue **et la région de l'établissement** (#1104) : les
 * deux mots composés ici viennent du catalogue, et les heures d'une absence sont
 * mises en forme par `lib/format.ts`, dans le fuseau du salon — qui ne bouge pas
 * avec la langue. Les bornes d'une plage de travail, elles, restent telles que le
 * contrat les porte (`09:00`) : ce sont des heures murales saisies par la
 * gérance, pas des instants à reprojeter.
 */
export function workingDay(
  schedule: MyStaffSchedule,
  day: CalendarDate,
  dayStart: Date,
  dayEnd: Date,
  display: DisplayLocale = { locale: FALLBACK_LOCALE },
): WorkingDay {
  const words = CATALOG[display.locale].schedule;
  const weekday = isoWeekdayOf(day);
  const hours = schedule.entries
    .filter((entry) => entry.weekday === weekday)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .map(
      (entry) => `${entry.startsAt} – ${entry.endsAt === '24:00' ? words.midnight : entry.endsAt}`,
    );

  const absences = schedule.timeOff
    .filter(
      (off) =>
        Date.parse(off.startsAt) < dayEnd.getTime() && Date.parse(off.endsAt) > dayStart.getTime(),
    )
    .map((off) => {
      const start = Math.max(Date.parse(off.startsAt), dayStart.getTime());
      const end = Math.min(Date.parse(off.endsAt), dayEnd.getTime());
      const whole = start === dayStart.getTime() && end === dayEnd.getTime();
      const span = whole
        ? words.allDay
        : `${formatTimeInTimeZone(new Date(start).toISOString(), schedule.timezone, display)} – ${formatTimeInTimeZone(new Date(end).toISOString(), schedule.timezone, display)}`;
      return off.reason === null ? span : `${span} · ${off.reason}`;
    });

  return { closed: schedule.closedWeekdays.includes(weekday), hours, absences };
}

/**
 * Les bornes UTC d'une journée du salon — de minuit à minuit dans son fuseau.
 *
 * Calculées sans bibliothèque : on part de minuit UTC et on corrige du décalage
 * que le fuseau affiche à cet instant-là. Un changement d'heure dans la nuit
 * décale la borne d'une heure au plus, ce qui ne change pas le jour d'une
 * absence.
 */
export function dayBoundsInTimeZone(
  day: CalendarDate,
  timeZone: TimeZone,
): { readonly start: Date; readonly end: Date } {
  const offsetAt = (instant: Date): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const value = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');
    const asUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    );
    return asUtc - instant.getTime();
  };

  const midnight = (date: CalendarDate): Date => {
    const utcMidnight = new Date(`${date}T00:00:00.000Z`);
    return new Date(utcMidnight.getTime() - offsetAt(utcMidnight));
  };

  return { start: midnight(day), end: midnight(addCalendarDays(day, 1)) };
}
