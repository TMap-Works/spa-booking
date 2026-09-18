import {
  isoWeekdayOf,
  type AppointmentStatus,
  type CalendarDate,
  type MyStaffAppointment,
  type MyStaffSchedule,
  type TimeZone,
} from '@spa/shared';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import { formatTimeInTimeZone } from '@/lib/format';

/**
 * « Mon planning » — l'emploi du temps du praticien connecté (#813), ce qui se
 * décide sans DOM : la vue, la fenêtre à demander à l'API, les horaires d'une
 * journée, les rendez-vous rangés par jour.
 *
 * Toutes les dates civiles sont **celles du salon** : le praticien travaille
 * dans le fuseau de son salon, pas dans celui de son téléphone.
 */

/** Les trois vues de l'écran — dans l'adresse (`?vue=`), en français. */
export const MY_PLANNING_VIEWS = ['jour', 'semaine', 'a-venir'] as const;

export type MyPlanningView = (typeof MY_PLANNING_VIEWS)[number];

export const MY_PLANNING_VIEW_LABELS: Readonly<Record<MyPlanningView, string>> = {
  jour: 'Jour',
  semaine: 'Semaine',
  'a-venir': 'À venir',
};

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
 */
export function workingDay(
  schedule: MyStaffSchedule,
  day: CalendarDate,
  dayStart: Date,
  dayEnd: Date,
): WorkingDay {
  const weekday = isoWeekdayOf(day);
  const hours = schedule.entries
    .filter((entry) => entry.weekday === weekday)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .map((entry) => `${entry.startsAt} – ${entry.endsAt === '24:00' ? 'minuit' : entry.endsAt}`);

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
        ? 'Toute la journée'
        : `${formatTimeInTimeZone(new Date(start).toISOString(), schedule.timezone)} – ${formatTimeInTimeZone(new Date(end).toISOString(), schedule.timezone)}`;
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
