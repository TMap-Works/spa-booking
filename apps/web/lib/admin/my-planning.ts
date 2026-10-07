import {
  DEFAULT_LOCALE,
  isoWeekdayOf,
  type AppointmentStatus,
  type CalendarDate,
  type Locale,
  type MyStaffAppointment,
  type MyStaffSchedule,
  type TimeZone,
} from '@spa/shared';

import { formatWallTime } from '@/components/salon/opening-hours';
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
 * `DEFAULT_LOCALE` depuis #1297. Le repli valait `fr` pour garder le
 * comportement d'avant #1104 dans les suites qui éprouvent les libellés
 * français ; celles-ci demandent leur langue explicitement à présent, et
 * l'écran, lui, a toujours passé la sienne.
 */
const FALLBACK_LOCALE: Locale = DEFAULT_LOCALE;

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

/**
 * « Rina Andriamena » — la cliente telle que l'API la sert au praticien.
 *
 * Le nom **entier** depuis #1404. Il s'écrivait « Rina A. », au motif que le
 * praticien n'a pas à tenir le fichier client ; la même praticienne lit déjà le
 * nom complet et le téléphone dans « Clients » avec le même jeton, et l'abréger
 * ici ne retirait la donnée à personne — cela l'obligeait seulement à changer
 * d'écran pour savoir qui elle reçoit. Le contrat partagé porte le raisonnement
 * entier (`myStaffAppointmentClientSchema`).
 *
 * `trim` sur la composition et non sur chaque moitié : les deux colonnes sont
 * `NOT NULL` et `nameSchema` exige un caractère de chacune, mais une ligne
 * historique mal formée doit rendre un nom lisible plutôt qu'une espace en trop.
 */
export function clientLabel(appointment: MyStaffAppointment): string {
  return `${appointment.client.firstName} ${appointment.client.lastName}`.trim();
}

/** Une ligne du rail de date : une plage de travail, ou une absence. */
export interface WorkingLine {
  /**
   * « 09:00 – 12:00 » pour une plage de travail, dans la convention du pays du
   * salon — « 9:00 AM – 12:00 PM » à New York (#1345) ; « 16:00 – 17:00 ·
   * Formation » pour une absence.
   */
  readonly text: string;
  /** Vrai quand la ligne dit une absence, et non du travail. */
  readonly timeOff: boolean;
}

/** Ce que le praticien a à savoir de sa journée, avant ses rendez-vous. */
export interface WorkingDay {
  /** Le salon est fermé ce jour de la semaine. */
  readonly closed: boolean;
  /**
   * Ce que la journée dit d'elle-même, **dans l'ordre où cela se lit** : chaque
   * plage encore travaillée, suivie de l'absence qui la coupe. Vide quand il n'a
   * pas de plage ce jour-là, ou quand le salon est fermé.
   */
  readonly lines: readonly WorkingLine[];
  /**
   * L'absence a emporté toutes ses plages : il ne travaille pas ce jour-là, et
   * les lignes ne disent plus que son absence. C'est ce qui permet à l'écran de
   * l'annoncer « Absente — Formation » au lieu de « Absence : … » posé à côté
   * d'horaires qu'elle n'honorera pas (#1408).
   */
  readonly away: boolean;
}

/** Une plage de minutes comptées depuis minuit dans le fuseau du salon. */
interface MinuteSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * « 09:00 » → 540, « 24:00 » → 1440.
 *
 * Lecture directe, sans le `wallMinutesOrNull` de `@spa/shared` : celui-là est
 * un garde de validation, il n'est pas dans le baril public du contrat, et ces
 * heures-ci arrivent déjà validées par `staffScheduleEntrySchema`. Les bornes de
 * fin valent `24:00` par convention du contrat, que l'arithmétique porte sans
 * cas particulier.
 */
function wallMinutes(wall: string): number {
  const [hours = '0', minutes = '0'] = wall.split(':');

  return Number(hours) * 60 + Number(minutes);
}

/**
 * Décalage de `timeZone` par rapport à UTC **à cet instant-là**, en millisecondes.
 *
 * Mesuré et non tabulé : on lit l'instant à l'horloge du fuseau, on relit ces
 * champs comme s'ils étaient UTC, et on prend l'écart. `hourCycle: 'h23'` et non
 * `hour12: false` : les deux se contredisent sur certains moteurs, et `hour12`
 * seul peut rendre `24` pour minuit.
 */
function offsetInTimeZone(instant: Date, timeZone: TimeZone): number {
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
}

/**
 * L'heure qu'affiche l'horloge du salon à cet instant, en minutes depuis le
 * minuit de la journée affichée.
 *
 * **La même unité que `wallMinutes`**, et c'est tout l'objet de cette fonction :
 * les plages de travail portent des heures murales, les absences des instants, et
 * les comparer exige qu'elles comptent la même chose. Les minutes **écoulées**
 * depuis `dayStart` ne le font pas : une journée de changement d'heure dure 23 ou
 * 25 heures, et l'absence de 14 h – 19 h y tombait à 900 – 1200 ou 780 – 1080
 * là où la plage de 14 h – 19 h vaut 840 – 1140 — la plage n'était alors plus
 * vue comme couverte, et l'écran réaffichait côte à côte les horaires et
 * l'absence que #1408 venait justement de fondre. Corriger de l'écart de
 * décalage entre les deux instants rend l'heure murale, et porte au passage la
 * borne de fin de journée à `24:00` comme la convention du contrat l'écrit.
 */
function dayMinutesInTimeZone(instant: number, dayStart: Date, timeZone: TimeZone): number {
  const drift =
    offsetInTimeZone(new Date(instant), timeZone) - offsetInTimeZone(dayStart, timeZone);

  return (instant - dayStart.getTime() + drift) / 60_000;
}

/**
 * Les plages fondues en plages disjointes, triées.
 *
 * Ce qui permet de dire qu'une plage de travail est **entièrement** couverte :
 * deux absences bout à bout — 09:00 – 13:00 puis 13:00 – 19:00 — emportent la
 * journée alors qu'aucune des deux ne la couvre à elle seule, et les comparer
 * une par une l'aurait laissée s'afficher comme travaillée.
 */
function mergeSpans(spans: readonly MinuteSpan[]): readonly MinuteSpan[] {
  const merged: { from: number; to: number }[] = [];

  for (const span of [...spans].sort((left, right) => left.from - right.from)) {
    const last = merged.at(-1);
    if (last !== undefined && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
    } else {
      merged.push({ from: span.from, to: span.to });
    }
  }

  return merged;
}

/**
 * La journée d'un praticien d'après ses horaires, ses absences et les
 * fermetures du salon.
 *
 * Une absence qui déborde la journée s'affiche bornée à celle-ci : « toute la
 * journée » quand elle la couvre entière, plutôt qu'une heure de début tombée
 * trois jours plus tôt.
 *
 * ## L'absence se retranche des horaires (#1408)
 *
 * Les deux listes étaient rendues côte à côte, sans se parler : un vendredi
 * d'absence complète annonçait « 09:00 – 13:00 / 14:00 – 19:00 », puis
 * « Absence : Toute la journée · Formation » en dessous — on lisait d'abord
 * qu'elle travaillait. Un dimanche de fermeture disait « Salon fermé » **et**
 * « Absence : Toute la journée », deux fois la même chose.
 *
 * La journée se compose donc en une seule liste ordonnée, sur trois règles :
 *
 * - **le salon fermé emporte tout** — ni plage ni absence à lire, « Salon
 *   fermé » dit déjà qu'elle ne reçoit personne ;
 * - **une plage entièrement couverte disparaît** — l'absence prend sa place, et
 *   `away` dit à l'écran de l'annoncer comme telle ;
 * - **les lignes se rangent dans l'heure**, plages et absences mêlées : une
 *   absence partielle tombe ainsi contre la plage qu'elle ampute, au lieu d'être
 *   reléguée sous la journée entière.
 *
 * Les deux natures d'heure se comparent en **minutes d'horloge depuis le minuit
 * du salon** : les plages portent des heures murales, les absences des instants
 * (`myStaffScheduleSchema`), et `dayMinutesInTimeZone` ramène les secondes aux
 * premières — et non les minutes écoulées depuis `dayStart`, qui décalent d'une
 * heure entière tout ce qui suit un changement d'heure.
 *
 * `display` porte la langue **et la région de l'établissement** (#1104) : les
 * deux mots composés ici viennent du catalogue, et les heures d'une absence sont
 * mises en forme par `lib/format.ts`, dans le fuseau du salon — qui ne bouge pas
 * avec la langue.
 *
 * ## Les bornes d'une plage de travail suivent la même convention (#1345)
 *
 * Elles restaient telles que le contrat les porte (`09:00`), au motif — exact —
 * que ce sont des heures murales saisies par la gérance et non des instants à
 * reprojeter. Mais la journée affichait alors ses deux natures d'heure côte à
 * côte : « 09:00 – 12:00 » pour la plage de travail, « 4:00 PM – 5:00 PM » pour
 * l'absence juste en dessous, chez un salon américain lu en anglais.
 *
 * Elles passent donc par `formatWallTime` de `components/salon/opening-hours.ts`,
 * le point d'écriture unique d'une heure murale du front : c'est la vitrine qui le
 * tient, et l'import va du back-office vers elle — jamais l'inverse, qui ferait
 * entrer le graphe du back-office dans le chemin de LCP de la page publique.
 * `24:00` y garde son mot, comme avant.
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

  if (schedule.closedWeekdays.includes(weekday)) {
    return { closed: true, lines: [], away: false };
  }

  const shifts = schedule.entries
    .filter((entry) => entry.weekday === weekday)
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt))
    .map((entry) => ({
      from: wallMinutes(entry.startsAt),
      to: wallMinutes(entry.endsAt),
      text: `${formatWallTime(entry.startsAt, display, words.midnight)} – ${formatWallTime(entry.endsAt, display, words.midnight)}`,
    }));

  const absences = schedule.timeOff
    .filter(
      (off) =>
        Date.parse(off.startsAt) < dayEnd.getTime() && Date.parse(off.endsAt) > dayStart.getTime(),
    )
    .map((off) => {
      const start = Math.max(Date.parse(off.startsAt), dayStart.getTime());
      const end = Math.min(Date.parse(off.endsAt), dayEnd.getTime());
      const whole = start === dayStart.getTime() && end === dayEnd.getTime();
      // Une absence du jour entier dit son motif, et rien de plus : « Absente —
      // Formation » se lit, « Absente — Toute la journée · Formation » se
      // déchiffre. Sans motif, il reste le seul mot qui apprenne quelque chose.
      const span = whole
        ? (off.reason ?? words.allDay)
        : `${formatTimeInTimeZone(new Date(start).toISOString(), schedule.timezone, display)} – ${formatTimeInTimeZone(new Date(end).toISOString(), schedule.timezone, display)}`;
      return {
        from: dayMinutesInTimeZone(start, dayStart, schedule.timezone),
        to: dayMinutesInTimeZone(end, dayStart, schedule.timezone),
        text: whole || off.reason === null ? span : `${span} · ${off.reason}`,
      };
    })
    .sort((left, right) => left.from - right.from);

  const busy = mergeSpans(absences);
  // Les deux natures de ligne se rangent dans l'heure, et c'est ce qui place
  // l'absence contre la plage qu'elle coupe : une absence de 16 h tombe après la
  // plage de 14 h, sans avoir à les apparier. À heure égale, la plage passe
  // devant — on travaille d'abord, on s'absente ensuite.
  const lines: readonly WorkingLine[] = [
    ...shifts
      .filter((shift) => !busy.some((span) => span.from <= shift.from && span.to >= shift.to))
      .map((shift) => ({ from: shift.from, text: shift.text, timeOff: false })),
    ...absences.map((absence) => ({ from: absence.from, text: absence.text, timeOff: true })),
  ]
    .sort((left, right) => left.from - right.from || Number(left.timeOff) - Number(right.timeOff))
    .map(({ text, timeOff }) => ({ text, timeOff }));

  return {
    closed: false,
    lines,
    away: lines.length > 0 && lines.every((line) => line.timeOff),
  };
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
  const midnight = (date: CalendarDate): Date => {
    const utcMidnight = new Date(`${date}T00:00:00.000Z`);
    return new Date(utcMidnight.getTime() - offsetInTimeZone(utcMidnight, timeZone));
  };

  return { start: midnight(day), end: midnight(addCalendarDays(day, 1)) };
}
