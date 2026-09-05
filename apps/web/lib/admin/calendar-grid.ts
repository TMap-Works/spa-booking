/**
 * La grille du planning — des rendez-vous en UTC vers des cellules de colonne.
 *
 * Tout le calcul de l'écran le plus regardé du back-office (#49) est ici, en
 * fonctions pures : le composant ne fait que rendre ce que ce module décrit.
 * C'est ce qui rend testable sans navigateur ce qui casserait le plus cher — un
 * rendez-vous placé une demi-heure trop bas, un bloc qui en recouvre un autre,
 * ou la virtualisation qui masque une ligne visible.
 *
 * ## Trois invariants
 *
 * 1. **Les instants arrivent en UTC et ne s'affichent jamais tels quels.** Toute
 *    conversion passe par `Intl` avec le fuseau de l'établissement, jamais par
 *    celui du navigateur : un planning lu depuis Paris doit montrer la journée du
 *    salon d'Antananarivo, pas la sienne (`CLAUDE.md`, ADR 0006).
 * 2. **Rien n'est positionné en absolu.** Une cellule dit sa rangée de départ et
 *    sa hauteur en rangées de 30 minutes ; c'est la grille CSS qui place. Voir
 *    l'en-tête de `styles/admin/calendar.css`.
 * 3. **Un chevauchement se range côte à côte, il ne se recouvre pas.** La
 *    contrainte d'exclusion l'interdit pour un même praticien, mais une colonne
 *    de la vue semaine agrège toute l'équipe : deux soins simultanés y sont la
 *    règle, pas l'exception.
 */

import type { Appointment, AppointmentStatus, CalendarDate, TimeZone } from '@spa/shared';

import type { CalendarRange, CalendarView } from './calendar-range';
import { daysOf, weekdayLabel } from './calendar-range';

/** Hauteur d'une rangée, en minutes — le pas de la grille CSS. */
export const SLOT_MINUTES = 30;

/** Rangées d'une heure pleine. */
export const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;

/** Rangées d'une journée entière. */
export const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR;

/**
 * Amplitude affichée par défaut — 08 h à 20 h.
 *
 * Ce n'est pas l'amplitude du salon : les horaires d'ouverture ne sont pas
 * servis par la route d'agenda, et deviner une fermeture ferait disparaître un
 * rendez-vous pris hors horaires. C'est un cadrage de confort, **toujours
 * élargi** pour contenir ce que la journée porte réellement.
 */
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 20;

/** Rangées mises en réserve de part et d'autre de la fenêtre visible. */
export const OVERSCAN_SLOTS = 4;

/**
 * Fenêtre montée tant que la hauteur réelle du conteneur n'est pas connue.
 *
 * Le premier rendu — celui du serveur, et celui de jsdom — n'a aucune mise en
 * page : `clientHeight` y vaut zéro, et prendre cette valeur au mot ne monterait
 * rien du tout. Six heures suffisent à remplir un écran de bureau, et la mesure
 * qui suit le montage élargit ou resserre.
 */
export const FALLBACK_VISIBLE_SLOTS = 12;

/** Classe de statut, telle que `styles/admin/calendar.css` la nomme. */
export function statusModifier(status: AppointmentStatus): string {
  return status.replace(/_/g, '-');
}

/** Libellé d'un statut, tel que la légende et le nom accessible l'annoncent. */
export const STATUS_LABELS: Readonly<Record<AppointmentStatus, string>> = {
  pending: 'à confirmer',
  confirmed: 'confirmé',
  completed: 'honoré',
  cancelled: 'annulé',
  no_show: 'non présenté',
};

interface ZonedFields {
  readonly date: CalendarDate;
  /** Minutes écoulées depuis minuit, dans le fuseau demandé. */
  readonly minutes: number;
}

/**
 * L'instant UTC lu à l'horloge de `timeZone`.
 *
 * `hourCycle: 'h23'` et non `hour12: false` : les deux se contredisent sur
 * certains moteurs, et `hour12: false` seul peut rendre `24` pour minuit — une
 * heure qui n'existe pas et qui placerait le rendez-vous de 00 h 15 à la fin de
 * la journée précédente.
 */
export function zonedFields(instant: string, timeZone: TimeZone): ZonedFields {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    minutes: Number(value('hour')) * 60 + Number(value('minute')),
  };
}

/** Les bornes d'un rendez-vous, en rangées de la journée où il commence. */
interface SlotSpan {
  readonly day: CalendarDate;
  readonly startSlot: number;
  readonly endSlot: number;
}

/**
 * Le rendez-vous ramené à des rangées.
 *
 * Un soin qui déborde sur le lendemain est **écrêté à minuit** plutôt qu'ignoré
 * ou reporté sur la colonne suivante : il occupe bien la fin de cette journée-là,
 * et l'opérateur doit le voir là où il commence.
 */
export function slotSpanOf(appointment: Appointment, timeZone: TimeZone): SlotSpan {
  const start = zonedFields(appointment.startsAt, timeZone);
  const end = zonedFields(appointment.endsAt, timeZone);
  const endMinutes = end.date === start.date ? end.minutes : 24 * 60;
  const startSlot = Math.floor(start.minutes / SLOT_MINUTES);
  const endSlot = Math.ceil(endMinutes / SLOT_MINUTES);

  return {
    day: start.date,
    startSlot,
    // Un rendez-vous plus court qu'une rangée en occupe une : une cellule de
    // hauteur nulle serait invisible et increvable au clavier.
    endSlot: Math.max(endSlot, startSlot + 1),
  };
}

/** Ce qu'une cellule de colonne peut être. */
export interface CalendarEventCell {
  readonly kind: 'event';
  readonly key: string;
  /** Rangée de départ, **relative** à la première rangée affichée. */
  readonly slot: number;
  readonly span: number;
  /** Couloir horizontal, pour les rendez-vous simultanés d'une même colonne. */
  readonly lane: number;
  readonly appointment: Appointment;
  readonly timeLabel: string;
  readonly clientLabel: string;
  readonly serviceLabel: string | null;
}

export interface CalendarFreeCell {
  readonly kind: 'free';
  readonly key: string;
  readonly slot: number;
  readonly span: 1;
  /** Heure civile du créneau — « 10 h 30 », pour le nom accessible du bouton. */
  readonly timeLabel: string;
  /**
   * Position du trait d'heure courante dans la rangée, en pourcentage, ou `null`
   * quand l'heure qu'il est n'y tombe pas.
   */
  readonly nowOffset: string | null;
}

export type CalendarCell = CalendarEventCell | CalendarFreeCell;

export interface CalendarColumn {
  /** Identifiant stable — c'est lui qui relie la colonne à son en-tête. */
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  /** Nombre de couloirs occupés, `1` dans le cas courant. */
  readonly laneCount: number;
  readonly cells: readonly CalendarCell[];
}

export interface CalendarBoard {
  readonly view: CalendarView;
  /** Première rangée affichée, en rangées depuis minuit. */
  readonly firstSlot: number;
  /** Première rangée **exclue**, en rangées depuis minuit. */
  readonly lastSlot: number;
  /** Nombre de rangées affichées — la hauteur de la grille. */
  readonly slotCount: number;
  /** Étiquettes de la gouttière, une par heure pleine. */
  readonly hours: readonly string[];
  readonly columns: readonly CalendarColumn[];
  /** Nombre de rendez-vous de la plage, tous statuts confondus. */
  readonly appointmentCount: number;
}

/** « 09 h » — l'étiquette d'heure de la gouttière. */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')} h`;
}

/** « 09:30 » — une heure de rangée, sans dépendre d'un fuseau : elle est déjà locale. */
function slotClock(slot: number): string {
  const minutes = slot * SLOT_MINUTES;

  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** « 10 h 30 » — la même heure, telle qu'un lecteur d'écran doit l'entendre. */
function spokenClock(slot: number): string {
  const minutes = slot * SLOT_MINUTES;

  return `${String(Math.floor(minutes / 60)).padStart(2, '0')} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** « Rina A. » — la vue semaine n'a pas la largeur d'un nom complet. */
export function shortClientName(client: Appointment['client']): string {
  const initial = client.lastName.charAt(0);

  return initial === '' ? client.firstName : `${client.firstName} ${initial}.`;
}

/**
 * Attribue un couloir à chaque rendez-vous d'une colonne.
 *
 * Le premier couloir libre à l'heure de départ, dans l'ordre chronologique :
 * c'est l'algorithme d'ordonnancement d'intervalles le plus simple qui garantisse
 * qu'aucun bloc n'en recouvre un autre, et il rend `1` couloir dès que rien ne se
 * chevauche — donc dans toute la vue jour, où la contrainte d'exclusion interdit
 * déjà les simultanés.
 */
function assignLanes(spans: readonly SlotSpan[]): { lanes: number[]; laneCount: number } {
  const lastEnd: number[] = [];
  const lanes: number[] = [];

  for (const span of spans) {
    let lane = lastEnd.findIndex((end) => end <= span.startSlot);

    if (lane === -1) {
      lane = lastEnd.length;
    }

    lastEnd[lane] = span.endSlot;
    lanes.push(lane);
  }

  return { lanes, laneCount: Math.max(lastEnd.length, 1) };
}

interface ColumnInput {
  readonly id: string;
  readonly name: string;
  readonly appointments: readonly Appointment[];
  /** Journée de la colonne — la même pour toutes en vue jour. */
  readonly day: CalendarDate;
}

interface BuildOptions {
  readonly view: CalendarView;
  readonly range: CalendarRange;
  readonly appointments: readonly Appointment[];
  readonly timeZone: TimeZone;
  /** Instant de référence du trait d'heure courante. */
  readonly now?: Date;
}

/**
 * Le planning complet, prêt à rendre.
 *
 * Les colonnes sont **déduites des rendez-vous** en vue jour : l'API n'expose pas
 * la liste des fiches praticien de l'établissement (#421), et inventer des
 * colonnes à partir des comptes internes afficherait des personnes qui ne
 * pratiquent pas. Un praticien sans rendez-vous ce jour-là n'a donc pas de
 * colonne — c'est la limite connue de cet écran tant que `GET /staff` n'existe
 * pas.
 */
export function buildCalendarBoard(options: BuildOptions): CalendarBoard {
  const { view, range, appointments, timeZone } = options;
  const spans = new Map<string, SlotSpan>();

  for (const appointment of appointments) {
    spans.set(appointment.id, slotSpanOf(appointment, timeZone));
  }

  const { firstSlot, lastSlot } = displayedSlots([...spans.values()]);
  const columns = columnInputs(view, range, appointments, spans).map((input) =>
    buildColumn(input, spans, { view, firstSlot, lastSlot, timeZone, ...(options.now === undefined ? {} : { now: options.now }) }),
  );

  const hours: string[] = [];
  for (let hour = firstSlot / SLOTS_PER_HOUR; hour < lastSlot / SLOTS_PER_HOUR; hour += 1) {
    hours.push(hourLabel(hour));
  }

  return {
    view,
    firstSlot,
    lastSlot,
    slotCount: lastSlot - firstSlot,
    hours,
    columns,
    appointmentCount: appointments.length,
  };
}

/**
 * L'amplitude horaire affichée : le cadrage par défaut, élargi à l'heure pleine
 * pour contenir tout ce que la plage porte.
 */
function displayedSlots(spans: readonly SlotSpan[]): { firstSlot: number; lastSlot: number } {
  let first = DEFAULT_FIRST_HOUR * SLOTS_PER_HOUR;
  let last = DEFAULT_LAST_HOUR * SLOTS_PER_HOUR;

  for (const span of spans) {
    first = Math.min(first, span.startSlot);
    last = Math.max(last, span.endSlot);
  }

  return {
    firstSlot: Math.floor(first / SLOTS_PER_HOUR) * SLOTS_PER_HOUR,
    lastSlot: Math.min(Math.ceil(last / SLOTS_PER_HOUR) * SLOTS_PER_HOUR, SLOTS_PER_DAY),
  };
}

/** Une colonne par praticien en vue jour, une par journée en vue semaine. */
function columnInputs(
  view: CalendarView,
  range: CalendarRange,
  appointments: readonly Appointment[],
  spans: ReadonlyMap<string, SlotSpan>,
): ColumnInput[] {
  if (view === 'semaine') {
    return daysOf(range).map((day) => ({
      id: `col-${day}`,
      name: weekdayLabel(day),
      day,
      appointments: appointments.filter((item) => spans.get(item.id)?.day === day),
    }));
  }

  const byStaff = new Map<string, { name: string; appointments: Appointment[] }>();

  for (const appointment of appointments) {
    // Filtré sur la journée affichée, comme la vue semaine l'est sur la sienne :
    // les bornes de la requête sont des dates civiles que le serveur traduit en
    // instants, et un soin commencé la veille au soir peut retomber dedans. Sans
    // ce garde-fou il ouvrirait une colonne et se placerait à la rangée de sa
    // propre journée — un rendez-vous d'hier affiché à 20 h aujourd'hui.
    if (spans.get(appointment.id)?.day !== range.from) {
      continue;
    }

    const existing = byStaff.get(appointment.staff.id);

    if (existing === undefined) {
      byStaff.set(appointment.staff.id, {
        name: appointment.staff.displayName,
        appointments: [appointment],
      });
    } else {
      existing.appointments.push(appointment);
    }
  }

  return [...byStaff.entries()]
    // Ordre alphabétique et non ordre d'arrivée : les colonnes doivent rester à
    // la même place d'un rafraîchissement à l'autre, sinon l'opérateur clique à
    // côté après chaque rechargement.
    .sort(([, left], [, right]) => left.name.localeCompare(right.name, 'fr-FR'))
    .map(([id, staff]) => ({
      id: `col-${id}`,
      name: staff.name,
      day: range.from,
      appointments: staff.appointments,
    }));
}

interface ColumnContext {
  readonly view: CalendarView;
  readonly firstSlot: number;
  readonly lastSlot: number;
  readonly timeZone: TimeZone;
  readonly now?: Date;
}

function buildColumn(
  input: ColumnInput,
  spans: ReadonlyMap<string, SlotSpan>,
  context: ColumnContext,
): CalendarColumn {
  const sorted = [...input.appointments].sort((left, right) =>
    left.startsAt === right.startsAt
      ? left.id.localeCompare(right.id)
      : left.startsAt.localeCompare(right.startsAt),
  );
  const columnSpans = sorted.map((appointment) => spans.get(appointment.id) as SlotSpan);
  const { lanes, laneCount } = assignLanes(columnSpans);

  const cells: CalendarCell[] = [];
  const occupied = new Set<number>();

  sorted.forEach((appointment, index) => {
    const span = columnSpans[index] as SlotSpan;
    const start = Math.max(span.startSlot, context.firstSlot);
    const end = Math.min(span.endSlot, context.lastSlot);

    for (let slot = start; slot < end; slot += 1) {
      occupied.add(slot);
    }

    cells.push({
      kind: 'event',
      key: appointment.id,
      slot: start - context.firstSlot,
      span: Math.max(end - start, 1),
      lane: lanes[index] ?? 0,
      appointment,
      timeLabel:
        context.view === 'semaine'
          ? slotClock(span.startSlot)
          : `${slotClock(span.startSlot)} – ${slotClock(span.endSlot)}`,
      clientLabel:
        context.view === 'semaine'
          ? shortClientName(appointment.client)
          : `${appointment.client.firstName} ${appointment.client.lastName}`,
      // La vue semaine masque la prestation en CSS faute de place ; ne pas
      // l'émettre du tout épargne autant de nœuds qu'il y a de rendez-vous.
      serviceLabel: context.view === 'semaine' ? null : appointment.service.name,
    });
  });

  const nowSlot = currentSlot(input.day, context);

  for (let slot = context.firstSlot; slot < context.lastSlot; slot += 1) {
    if (occupied.has(slot)) {
      continue;
    }

    cells.push({
      kind: 'free',
      key: `libre-${input.id}-${String(slot)}`,
      slot: slot - context.firstSlot,
      span: 1,
      timeLabel: spokenClock(slot),
      nowOffset: nowSlot !== null && nowSlot.slot === slot ? nowSlot.offset : null,
    });
  }

  // Ordre du document = ordre chronologique : la tabulation parcourt la journée
  // dans l'ordre où elle se déroule, sans motif ARIA inventé.
  cells.sort((left, right) =>
    left.slot === right.slot ? laneOf(left) - laneOf(right) : left.slot - right.slot,
  );

  return {
    id: input.id,
    name: input.name,
    meta: countLabel(input.appointments.length),
    laneCount,
    cells,
  };
}

function laneOf(cell: CalendarCell): number {
  return cell.kind === 'event' ? cell.lane : 0;
}

function countLabel(count: number): string {
  if (count === 0) {
    return 'Aucun rendez-vous';
  }

  return count === 1 ? '1 RDV' : `${String(count)} RDV`;
}

/** La rangée où tombe l'heure qu'il est, si elle tombe dans cette journée. */
function currentSlot(
  day: CalendarDate,
  context: ColumnContext,
): { slot: number; offset: string } | null {
  if (context.now === undefined) {
    return null;
  }

  const here = zonedFields(context.now.toISOString(), context.timeZone);

  if (here.date !== day) {
    return null;
  }

  const slot = Math.floor(here.minutes / SLOT_MINUTES);

  if (slot < context.firstSlot || slot >= context.lastSlot) {
    return null;
  }

  const within = here.minutes - slot * SLOT_MINUTES;

  return { slot, offset: `${String(Math.round((within / SLOT_MINUTES) * 100))}%` };
}

// ---------------------------------------------------------------------------
// Virtualisation — troisième critère de #49
// ---------------------------------------------------------------------------

export interface SlotWindow {
  /** Première rangée montée, relative à la première rangée affichée. */
  readonly first: number;
  /** Première rangée **exclue**. */
  readonly last: number;
}

interface WindowInput {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  /** Hauteur d'une rangée en pixels, telle que la mise en page la rend. */
  readonly slotHeight: number;
  readonly slotCount: number;
  readonly overscan?: number;
}

/**
 * La fenêtre de rangées à monter.
 *
 * Une vue semaine peut porter plusieurs centaines de blocs (CDC §1.4) : les
 * monter tous coûte un temps de rendu proportionnel à l'activité du salon, c'est
 * à dire que l'écran devient d'autant plus lent que le salon marche bien. Seules
 * les rangées visibles — plus une réserve de part et d'autre, pour que le défilé
 * ne montre pas de trou — entrent dans le DOM.
 *
 * Tant que la mise en page n'est pas mesurée (`viewportHeight` à zéro : rendu
 * serveur, premier rendu client, jsdom), une fenêtre de repli est montée plutôt
 * que rien du tout.
 */
export function computeSlotWindow(input: WindowInput): SlotWindow {
  const overscan = input.overscan ?? OVERSCAN_SLOTS;

  if (input.slotCount <= 0) {
    return { first: 0, last: 0 };
  }

  if (input.slotHeight <= 0) {
    return { first: 0, last: Math.min(input.slotCount, FALLBACK_VISIBLE_SLOTS) };
  }

  const visible =
    input.viewportHeight > 0
      ? Math.ceil(input.viewportHeight / input.slotHeight)
      : FALLBACK_VISIBLE_SLOTS;
  const first = Math.max(0, Math.floor(input.scrollTop / input.slotHeight) - overscan);

  return { first, last: Math.min(input.slotCount, first + visible + 2 * overscan) };
}

/** Les cellules qui coupent la fenêtre — celles-là seules sont montées. */
export function cellsInWindow(
  cells: readonly CalendarCell[],
  visible: SlotWindow,
): CalendarCell[] {
  return cells.filter((cell) => cell.slot < visible.last && cell.slot + cell.span > visible.first);
}
