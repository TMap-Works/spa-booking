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
 * 4. **Seul ce qui occupe le créneau le prend.** `pending` et `confirmed`
 *    occupent, les trois statuts terminaux non (`booking-engine` §5). Les
 *    seconds sont donc rendus sur un calque à part — voir `CalendarGhostCell`.
 */

import type {
  Appointment,
  AppointmentStatus,
  CalendarDate,
  OpeningHoursEntry,
  StaffMemberSummary,
  TimeZone,
} from '@spa/shared';
// `isoWeekdayOf` vient du contrat et non d'un calcul local : c'est lui qui
// numérote les plages d'ouverture (1 lundi … 7 dimanche, jamais le `0`-dimanche
// *falsy* de `Date.getUTCDay`), et deux lectures du jour de semaine finiraient
// par diverger sur l'écran où une divergence d'un jour se voit le moins.
//
// `isBlockingAppointmentStatus` vient du même contrat, et pour la même raison :
// c'est la liste que lit le prédicat partiel de la contrainte d'exclusion
// (`packages/shared/src/constants/appointment.ts`). La réécrire ici ferait
// diverger l'agenda affiché de l'agenda que le moteur sait honorer.
import { isBlockingAppointmentStatus, isoWeekdayOf } from '@spa/shared';

import { minutesOfClock } from './appointment-desk';
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
 * Ce n'est pas l'amplitude du salon : c'est un cadrage de confort, **toujours
 * élargi** pour contenir ce que la plage porte réellement — les rendez-vous, et
 * depuis #752 les plages d'ouverture de l'établissement. Élargi et jamais
 * resserré : une journée ouverte de 09 h à 19 h continue de montrer 08 h et
 * 19 h 30, en fond inactif. Resserrer sur les horaires masquerait un rendez-vous
 * pris hors horaires, et c'est le seul qu'un opérateur cherche des yeux.
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

/**
 * Les bornes d'un rendez-vous — en rangées pour le dessin, en minutes pour le dire.
 *
 * Les deux, et pas une seule : la grille est à 30 minutes, un rendez-vous ne
 * l'est pas. Le bloc doit se **caler** sur la rangée, sinon il ne s'aligne sur
 * rien ; son libellé doit porter l'heure **réelle**, sinon il ment. Confondre
 * les deux affichait « 09:00 – 10:30 » sur un rendez-vous de 09:15 à 10:15, et
 * le comptoir lisait une heure qui n'existait pas (#538).
 */
interface SlotSpan {
  readonly day: CalendarDate;
  readonly startSlot: number;
  readonly endSlot: number;
  /** Minutes depuis minuit, dans le fuseau du salon — l'heure du rendez-vous. */
  readonly startMinutes: number;
  /** Idem, écrêtée à minuit comme `endSlot` pour un soin qui déborde. */
  readonly endMinutes: number;
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
    // Non arrondies, elles : ce sont elles qu'on affiche. L'écrêtage à minuit
    // est le même que celui d'`endSlot`, faute de quoi un soin qui déborde
    // annoncerait une fin qui n'appartient pas à la journée qu'on regarde.
    startMinutes: start.minutes,
    endMinutes,
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

/**
 * Un rendez-vous **soldé** — honoré, annulé, non présenté (#753).
 *
 * Il n'occupe plus rien : le tableau du cycle de vie porte « Occupe le créneau :
 * non » pour les trois statuts terminaux, la contrainte d'exclusion les exclut
 * de son prédicat partiel, et le calcul des créneaux libres ne retranche que les
 * `pending` et les `confirmed` (`booking-engine` §1, §3 et §5). Son créneau est
 * donc réservable, et l'agenda doit le dire.
 *
 * Il était pourtant rendu comme n'importe quel bloc : ses rangées passaient pour
 * occupées, aucune cellule libre n'était émise dessous, et un après-midi
 * entièrement annulé ne laissait pas un seul point d'entrée vers le tiroir de
 * création — le comptoir ne pouvait pas reposer un client sur un créneau que le
 * moteur tenait pour libre. Deux annulés qui se chevauchaient scindaient en
 * outre la colonne en deux couloirs, au détriment des rendez-vous vivants.
 *
 * D'où un **calque à part** : la grille des cellules libres est peinte sur toute
 * la plage, et le soldé n'est plus qu'un repère posé au début de son créneau —
 * visible, daté, cliquable pour ouvrir sa fiche, mais sans prendre la place.
 * C'est le sens même de « ne pas occuper le créneau » ; un bloc pleine hauteur
 * dirait le contraire de ce que le statut signifie.
 */
export interface CalendarGhostCell {
  readonly kind: 'ghost';
  readonly key: string;
  readonly slot: number;
  readonly span: number;
  /**
   * Couloir **du calque des soldés**, indépendant de celui des vivants.
   *
   * Deux annulés qui se chevauchent se rangent côte à côte, comme deux soins
   * simultanés — mais sans jamais rétrécir un rendez-vous vivant : les deux
   * calques ne partagent pas leur compte de couloirs.
   */
  readonly lane: number;
  /** Couloirs de ce calque — la largeur d'un repère en est le quotient. */
  readonly laneCount: number;
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
   * La journée du salon où tombe ce créneau, et son heure civile « HH:MM ».
   *
   * Les deux sont portées par la cellule et non recalculées au clic (#50) : la
   * rangée seule ne dit pas la date en vue semaine, où chaque colonne est un
   * jour différent, et refaire la conversion dans le gestionnaire d'événement
   * la referait avec le fuseau du navigateur. Ici, elle a déjà été faite une
   * fois, avec celui de l'établissement.
   */
  readonly day: CalendarDate;
  readonly time: string;
  /**
   * Position du trait d'heure courante dans la rangée, en pourcentage, ou `null`
   * quand l'heure qu'il est n'y tombe pas.
   */
  readonly nowOffset: string | null;
}

/**
 * Une rangée que le salon ne travaille pas — fond inactif **nommé** (#752).
 *
 * Ni un créneau libre, ni un trou : c'est le `__blocked` de
 * `styles/admin/calendar.css`, hachuré et non cliquable, que
 * `mockups/admin/calendrier.html` montre depuis #30 et que la grille n'émettait
 * pas. Le planning peignait donc chaque demi-heure de 08 h à 19 h 30, tous les
 * jours, comme « libre — poser un rendez-vous à partir de cette heure » : avant
 * l'ouverture, pendant la coupure méridienne, après la fermeture, et les
 * journées entières où le salon est fermé. Le moteur, lui, refusait — le tiroir
 * ouvert depuis ces cellules répondait « Aucun créneau ce jour-là ».
 *
 * Les rangées contiguës sont **fusionnées** en une seule cellule : un libellé
 * par demi-heure serait illisible, et la maquette rend bien une journée fermée
 * d'un seul tenant.
 */
export interface CalendarClosedCell {
  readonly kind: 'closed';
  readonly key: string;
  readonly slot: number;
  readonly span: number;
  /** « Fermé », « Pause », « Hors horaires » — les libellés de la maquette. */
  readonly label: string;
  /**
   * Position du trait d'heure courante dans le **bloc entier**, en pourcentage.
   *
   * Le trait ne vit pas que sur les créneaux libres : l'heure qu'il est tombe
   * dans une fermeture chaque midi, chaque soir et tout un dimanche, et c'est
   * précisément là qu'un planning sans repère temporel se lit de travers. Le
   * pourcentage porte donc sur la hauteur des `span` rangées fusionnées, et non
   * sur une demi-heure.
   */
  readonly nowOffset: string | null;
}

export type CalendarCell =
  | CalendarEventCell
  | CalendarGhostCell
  | CalendarFreeCell
  | CalendarClosedCell;

export interface CalendarColumn {
  /** Identifiant stable — c'est lui qui relie la colonne à son en-tête. */
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  /**
   * Le praticien de la colonne en vue jour, `null` en vue semaine — où une
   * colonne est une journée de toute l'équipe.
   *
   * C'est ce qui permet au clic sur un créneau libre de proposer d'emblée le bon
   * praticien (#50, premier critère). En vue semaine il n'y en a pas à proposer,
   * et le tiroir laisse choisir plutôt que de deviner.
   */
  readonly staffId: string | null;
  /**
   * Nombre de couloirs occupés, `1` dans le cas courant.
   *
   * Compté sur les seuls rendez-vous qui **occupent** le créneau : un soldé vit
   * sur son propre calque (`CalendarGhostCell`) et ne rétrécit donc jamais un
   * rendez-vous vivant, ni la cellule libre qui s'étend sur tous les couloirs.
   */
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

/** « 09:15 » — des minutes depuis minuit, déjà locales : aucun fuseau ici. */
function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** « 09:30 » — l'heure d'une **rangée**, pour les cellules libres de la grille. */
function slotClock(slot: number): string {
  return clockOf(slot * SLOT_MINUTES);
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
  /** Praticien de la colonne en vue jour, `null` en vue semaine. */
  readonly staffId: string | null;
}

interface BuildOptions {
  readonly view: CalendarView;
  readonly range: CalendarRange;
  readonly appointments: readonly Appointment[];
  readonly timeZone: TimeZone;
  /**
   * Le répertoire des praticiens de l'établissement — les colonnes de la vue jour.
   *
   * Facultatif : sans lui, la vue jour retombe sur les seuls praticiens occupés,
   * ce qui reste juste et n'oblige pas chaque appelant à disposer du répertoire.
   */
  readonly staff?: readonly StaffMemberSummary[];
  /**
   * Les plages d'ouverture hebdomadaires de l'établissement (#752).
   *
   * Servies sans jeton par `GET /public/{slug}` — la vitrine que la page du
   * planning lit déjà pour son fuseau (#343). Ce sont bien les heures que le
   * salon **annonce**, et non les fenêtres de travail du moteur, qui partent des
   * horaires du personnel ; mais le moteur les retranche des siennes
   * (`booking-engine` §3, étape 2), si bien qu'une rangée hors ouverture n'est
   * jamais réservable. L'agenda peut donc le dire sans mentir.
   *
   * Vide ou absent, **rien n'est peint en fermé** : un salon qui n'a pas encore
   * saisi ses horaires n'est pas un salon fermé sept jours sur sept, et grimer
   * son planning en semaine close lui retirerait le seul point d'entrée vers le
   * tiroir de création. Un jour *absent* d'un tableau non vide, lui, est bien un
   * jour fermé — c'est la lecture qu'en font déjà la vitrine publique
   * (`components/salon/opening-hours.ts`) et l'écran de réglages (#764).
   */
  readonly openingHours?: readonly OpeningHoursEntry[];
  /** Instant de référence du trait d'heure courante. */
  readonly now?: Date;
}

/** Une plage d'ouverture ramenée à des minutes depuis minuit, borne haute exclue. */
interface OpeningWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Les plages d'ouverture par jour ISO, ou `null` quand on n'en sait rien.
 *
 * `null` et non une table vide : « le salon ferme tous les jours » et « le salon
 * n'a rien saisi » sont deux états différents, et un seul des deux autorise à
 * peindre une fermeture. C'est la même distinction que celle de la vitrine
 * publique, qui omet les horaires plutôt que de rendre une semaine vide.
 */
type OpeningWeek = ReadonlyMap<number, readonly OpeningWindow[]> | null;

/**
 * Minutes depuis minuit d'une heure d'ouverture.
 *
 * `minutesOfClock` refuse `24:00` — à raison, c'est une heure de départ qui
 * n'existe pas —, et `scheduleEndTimeSchema` l'admet pourtant comme **borne
 * haute** : c'est ainsi qu'un salon ouvert jusqu'à minuit s'écrit. Le cas est
 * traité ici plutôt qu'en relâchant le parseur partagé, qui sert aussi à lire
 * des heures de début.
 */
function wallMinutes(time: string): number | null {
  return time === '24:00' ? SLOTS_PER_DAY * SLOT_MINUTES : minutesOfClock(time);
}

/**
 * La semaine d'ouverture, rangée par jour et fusionnée.
 *
 * Fusionnée parce que « 09:00–12:00 » et « 12:00–19:00 » décrivent une journée
 * continue en deux morceaux — le contrat tolère explicitement l'adjacence — et
 * qu'une coupure de zéro minute entre les deux se peindrait en « Pause » de
 * hauteur nulle.
 *
 * Une plage illisible est **ignorée** plutôt que de faire tomber la grille : la
 * validation du contrat l'a déjà refusée à l'écriture, et l'écran le plus
 * regardé du back-office ne doit pas blanchir sur une donnée héritée.
 */
function openingWeekOf(entries: readonly OpeningHoursEntry[]): OpeningWeek {
  if (entries.length === 0) {
    return null;
  }

  const byWeekday = new Map<number, OpeningWindow[]>();

  for (const entry of entries) {
    const start = wallMinutes(entry.opensAt);
    const end = wallMinutes(entry.closesAt);

    if (start === null || end === null || end <= start) {
      continue;
    }

    byWeekday.set(entry.weekday, [...(byWeekday.get(entry.weekday) ?? []), { start, end }]);
  }

  if (byWeekday.size === 0) {
    // Des plages toutes illisibles ne disent pas « fermé sept jours sur sept » :
    // elles ne disent rien. Rendre la table vide ici aurait peint la semaine
    // entière en fermeture — exactement ce que le repli d'horaires inconnus
    // existe pour éviter, et sur la donnée la moins fiable qui soit.
    return null;
  }

  for (const [weekday, windows] of byWeekday) {
    byWeekday.set(weekday, mergeWindows(windows));
  }

  return byWeekday;
}

/** Fusionne les plages qui se touchent ou se recouvrent, dans l'ordre horaire. */
function mergeWindows(windows: readonly OpeningWindow[]): OpeningWindow[] {
  const merged: OpeningWindow[] = [];

  for (const window of [...windows].sort((left, right) => left.start - right.start)) {
    const last = merged[merged.length - 1];

    if (last !== undefined && window.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, window.end) };
      continue;
    }

    merged.push(window);
  }

  return merged;
}

/**
 * Ce que le salon ouvre une journée donnée — `null` quand on n'en sait rien.
 *
 * Un jour **absent** d'une semaine renseignée rend un tableau vide : c'est une
 * journée de fermeture, pas une journée inconnue.
 */
function windowsOfDay(week: OpeningWeek, day: CalendarDate): readonly OpeningWindow[] | null {
  return week === null ? null : (week.get(isoWeekdayOf(day)) ?? []);
}

/**
 * Le planning complet, prêt à rendre.
 *
 * En vue jour, les colonnes viennent du **répertoire des praticiens**
 * (`GET /v1/staff`) et non des seuls rendez-vous du jour. Déduire les colonnes de
 * l'agenda laissait une journée creuse sans une seule case cliquable : le tiroir
 * de création ne s'ouvre que par un clic sur un créneau libre, si bien qu'un
 * salon ne pouvait pas poser depuis le planning le **premier** rendez-vous d'une
 * journée — précisément le geste qu'on attend d'un jour vide (#507).
 *
 * Le répertoire ne remplace pas l'agenda, il s'y ajoute : un praticien qui porte
 * un rendez-vous ce jour-là garde sa colonne même s'il ne figure pas dans la
 * liste reçue — une fiche désactivée depuis, ou un répertoire que l'appelant
 * n'a pas pu lire. Un rendez-vous ne doit jamais disparaître de l'écran parce que
 * la fiche de son praticien a changé d'état.
 */
export function buildCalendarBoard(options: BuildOptions): CalendarBoard {
  const { view, range, appointments, timeZone, staff = [], openingHours = [] } = options;
  const spans = new Map<string, SlotSpan>();

  for (const appointment of appointments) {
    spans.set(appointment.id, slotSpanOf(appointment, timeZone));
  }

  const week = openingWeekOf(openingHours);
  const { firstSlot, lastSlot } = displayedSlots([...spans.values()], daysOf(range), week);
  const columns = columnInputs(view, range, appointments, spans, staff).map((input) =>
    buildColumn(input, spans, {
      view,
      firstSlot,
      lastSlot,
      timeZone,
      windows: windowsOfDay(week, input.day),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
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
 * pour contenir tout ce que la plage porte — ses rendez-vous, et les heures que
 * le salon annonce ouvrir.
 *
 * Les horaires élargissent, ils ne resserrent pas. Un salon ouvert de 07 h à
 * 21 h doit voir ses deux extrémités ; un salon ouvert de 09 h à 19 h garde ses
 * rangées de 08 h et de 19 h 30, peintes en fond inactif — c'est ce que #752
 * demande explicitement, « sans les masquer ».
 */
function displayedSlots(
  spans: readonly SlotSpan[],
  days: readonly CalendarDate[],
  week: OpeningWeek,
): { firstSlot: number; lastSlot: number } {
  let first = DEFAULT_FIRST_HOUR * SLOTS_PER_HOUR;
  let last = DEFAULT_LAST_HOUR * SLOTS_PER_HOUR;

  for (const span of spans) {
    first = Math.min(first, span.startSlot);
    last = Math.max(last, span.endSlot);
  }

  for (const day of days) {
    for (const window of windowsOfDay(week, day) ?? []) {
      first = Math.min(first, Math.floor(window.start / SLOT_MINUTES));
      last = Math.max(last, Math.ceil(window.end / SLOT_MINUTES));
    }
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
  staff: readonly StaffMemberSummary[],
): ColumnInput[] {
  if (view === 'semaine') {
    return daysOf(range).map((day) => ({
      id: `col-${day}`,
      name: weekdayLabel(day),
      day,
      staffId: null,
      appointments: appointments.filter((item) => spans.get(item.id)?.day === day),
    }));
  }

  const byStaff = new Map<string, { name: string; appointments: Appointment[] }>();

  // Le répertoire d'abord : chaque praticien ouvre sa colonne, occupée ou non.
  // C'est ce qui donne à une journée creuse une grille de créneaux libres, donc
  // un point d'entrée vers le tiroir de création (#507).
  for (const member of staff) {
    byStaff.set(member.id, { name: member.displayName, appointments: [] });
  }

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
      // Un praticien absent du répertoire garde sa colonne dès qu'il porte un
      // rendez-vous : fiche désactivée depuis, ou répertoire illisible. Un
      // rendez-vous ne disparaît pas de l'écran pour un état de fiche.
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
      staffId: id,
      appointments: staff.appointments,
    }));
}

interface ColumnContext {
  readonly view: CalendarView;
  readonly firstSlot: number;
  readonly lastSlot: number;
  readonly timeZone: TimeZone;
  /** Ce que le salon ouvre ce jour-là, `null` si ses horaires sont inconnus. */
  readonly windows: readonly OpeningWindow[] | null;
  readonly now?: Date;
}

/** Les rangées d'un rendez-vous, écrêtées à l'amplitude affichée. */
function clampSpan(span: SlotSpan, context: ColumnContext): { start: number; end: number } {
  return {
    start: Math.max(span.startSlot, context.firstSlot),
    end: Math.min(span.endSlot, context.lastSlot),
  };
}

/**
 * Les trois libellés d'un rendez-vous, vivant ou soldé.
 *
 * L'heure affichée est celle du **rendez-vous**, pas celle de la rangée où il
 * est posé : le bloc se cale sur la grille, son libellé non (#538). La vue
 * semaine masque la prestation en CSS faute de place — ne pas l'émettre du tout
 * épargne autant de nœuds qu'il y a de rendez-vous.
 */
function labelsOf(
  appointment: Appointment,
  span: SlotSpan,
  view: CalendarView,
): { timeLabel: string; clientLabel: string; serviceLabel: string | null } {
  return {
    timeLabel:
      view === 'semaine'
        ? clockOf(span.startMinutes)
        : `${clockOf(span.startMinutes)} – ${clockOf(span.endMinutes)}`,
    clientLabel:
      view === 'semaine'
        ? shortClientName(appointment.client)
        : `${appointment.client.firstName} ${appointment.client.lastName}`,
    serviceLabel: view === 'semaine' ? null : appointment.service.name,
  };
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
  // Les deux calques, séparés une fois pour toutes. `booked` prend le créneau et
  // ses couloirs ; `settled` ne prend rien — c'est tout le sujet de #753.
  const booked = sorted.filter((appointment) => isBlockingAppointmentStatus(appointment.status));
  const settled = sorted.filter((appointment) => !isBlockingAppointmentStatus(appointment.status));

  const bookedSpans = booked.map((appointment) => spans.get(appointment.id) as SlotSpan);
  const { lanes, laneCount } = assignLanes(bookedSpans);
  const settledSpans = settled.map((appointment) => spans.get(appointment.id) as SlotSpan);
  const settledLanes = assignLanes(settledSpans);

  const cells: CalendarCell[] = [];
  const occupied = new Set<number>();

  booked.forEach((appointment, index) => {
    const span = bookedSpans[index] as SlotSpan;
    const { start, end } = clampSpan(span, context);

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
      ...labelsOf(appointment, span, context.view),
    });
  });

  // L'ordre d'insertion ne décide de rien ici : c'est `laneOf` qui range les
  // trois étages à rangée égale — trame libre et fond inactif dessous, repère du
  // soldé au milieu, bloc du vivant devant.
  settled.forEach((appointment, index) => {
    const span = settledSpans[index] as SlotSpan;
    const { start, end } = clampSpan(span, context);

    cells.push({
      kind: 'ghost',
      key: appointment.id,
      slot: start - context.firstSlot,
      span: Math.max(end - start, 1),
      lane: settledLanes.lanes[index] ?? 0,
      laneCount: settledLanes.laneCount,
      appointment,
      ...labelsOf(appointment, span, context.view),
    });
  });

  const nowSlot = currentSlot(input.day, context);
  // La rangée où commence la fermeture courante, tant qu'elle dure. Les rangées
  // fermées se fusionnent (`CalendarClosedCell`) : on ne ferme la cellule qu'à
  // la première rangée qui ne l'est pas — ouverte, occupée, ou hors amplitude.
  let closedFrom: number | null = null;

  const closeRun = (until: number): void => {
    if (closedFrom === null) {
      return;
    }

    cells.push({
      kind: 'closed',
      key: `ferme-${input.id}-${String(closedFrom)}`,
      slot: closedFrom - context.firstSlot,
      span: until - closedFrom,
      label: closedLabel(closedFrom, context.windows ?? []),
      nowOffset: nowOffsetWithin(nowSlot, closedFrom, until),
    });

    closedFrom = null;
  };

  for (let slot = context.firstSlot; slot < context.lastSlot; slot += 1) {
    if (occupied.has(slot)) {
      closeRun(slot);
      continue;
    }

    if (isClosed(slot, context.windows)) {
      closedFrom ??= slot;
      continue;
    }

    closeRun(slot);

    cells.push({
      kind: 'free',
      key: `libre-${input.id}-${String(slot)}`,
      slot: slot - context.firstSlot,
      span: 1,
      timeLabel: spokenClock(slot),
      day: input.day,
      time: slotClock(slot),
      nowOffset: nowOffsetWithin(nowSlot, slot, slot + 1),
    });
  }

  closeRun(context.lastSlot);

  // Ordre du document = ordre chronologique : la tabulation parcourt la journée
  // dans l'ordre où elle se déroule, sans motif ARIA inventé.
  cells.sort((left, right) =>
    left.slot === right.slot ? laneOf(left) - laneOf(right) : left.slot - right.slot,
  );

  return {
    id: input.id,
    name: input.name,
    meta: columnMeta(input.appointments.length, context.windows),
    staffId: input.staffId,
    laneCount,
    cells,
  };
}

/**
 * `true` si le salon ne travaille pas cette rangée.
 *
 * C'est l'**heure de départ** de la rangée qui décide, et non son recouvrement :
 * le bouton d'un créneau libre promet « poser un rendez-vous à partir de cette
 * heure » (#611), et une rangée de 12 h 30 dont le salon ferme à 12 h 45 ne
 * permet de poser aucun rendez-vous.
 *
 * Horaires inconnus (`null`) : rien n'est fermé. Voir `BuildOptions.openingHours`.
 */
function isClosed(slot: number, windows: readonly OpeningWindow[] | null): boolean {
  if (windows === null) {
    return false;
  }

  const minutes = slot * SLOT_MINUTES;

  return !windows.some((window) => minutes >= window.start && minutes < window.end);
}

/**
 * Le nom du fond inactif — les trois libellés de `mockups/admin/calendrier.html`.
 *
 * Nommer plutôt que griser : une rangée grise sans mot ne distingue pas une
 * fermeture d'un défaut d'affichage, et l'opérateur qui cherche pourquoi il ne
 * peut pas poser à 13 h doit lire la réponse sur la rangée même.
 */
function closedLabel(slot: number, windows: readonly OpeningWindow[]): string {
  if (windows.length === 0) {
    return 'Fermé';
  }

  const minutes = slot * SLOT_MINUTES;
  // Une fermeture encadrée par deux plages du même jour est la coupure
  // méridienne — « Pause » —, jamais la fermeture du salon.
  const enclosed =
    windows.some((window) => window.end <= minutes) &&
    windows.some((window) => window.start > minutes);

  return enclosed ? 'Pause' : 'Hors horaires';
}

/**
 * L'en-tête de colonne : le compte de rendez-vous, ou « Fermé ».
 *
 * « Fermé » l'emporte sur « Aucun rendez-vous », qui se lit comme une journée
 * ouverte et creuse — celle qu'on propose de remplir. Un jour fermé qui porte
 * malgré tout un rendez-vous garde son compte : c'est lui l'information.
 */
function columnMeta(count: number, windows: readonly OpeningWindow[] | null): string {
  return count === 0 && windows !== null && windows.length === 0 ? 'Fermé' : countLabel(count);
}

/**
 * Le rang d'une cellule à rangée égale — donc son ordre de peinture.
 *
 * Les cellules sont posées les unes sur les autres sans `z-index` : à rangée
 * égale, c'est l'ordre du document qui décide, et la dernière écrite passe
 * devant. Trois étages, du fond vers la surface (#753) :
 *
 * 1. la trame libre et le fond inactif — transparents ou opaques, mais toujours
 *    dessous ;
 * 2. le repère d'un rendez-vous soldé, qui doit rester lisible par-dessus un
 *    « Pause » opaque commençant sur sa propre rangée ;
 * 3. le bloc d'un rendez-vous vivant, opaque, lane par lane : reposer un client
 *    sur l'heure qu'une annulation vient de libérer est précisément le geste
 *    que ce ticket rend possible, et c'est le vivant qui doit s'y lire.
 */
function laneOf(cell: CalendarCell): number {
  if (cell.kind === 'event') {
    return 2 + cell.lane;
  }

  return cell.kind === 'ghost' ? 1 : 0;
}

function countLabel(count: number): string {
  if (count === 0) {
    return 'Aucun rendez-vous';
  }

  return count === 1 ? '1 RDV' : `${String(count)} RDV`;
}

/**
 * La rangée où tombe l'heure qu'il est, si elle tombe dans cette journée — et la
 * minute exacte, que le placement du trait demande.
 */
function currentSlot(
  day: CalendarDate,
  context: ColumnContext,
): { slot: number; minutes: number } | null {
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

  return { slot, minutes: here.minutes };
}

/**
 * Où poser le trait d'heure courante dans une cellule qui couvre `[from, until)`,
 * en pourcentage de sa hauteur — `null` si l'heure qu'il est n'y tombe pas.
 *
 * Écrit sur un intervalle de rangées et non sur une rangée : une cellule fermée
 * en fusionne plusieurs, et un pourcentage calculé sur une demi-heure y placerait
 * le trait au sommet du bloc, quelle que soit l'heure.
 */
function nowOffsetWithin(
  now: { slot: number; minutes: number } | null,
  from: number,
  until: number,
): string | null {
  if (now === null || now.slot < from || now.slot >= until) {
    return null;
  }

  const within = now.minutes - from * SLOT_MINUTES;
  const height = (until - from) * SLOT_MINUTES;

  return `${String(Math.round((within / height) * 100))}%`;
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
