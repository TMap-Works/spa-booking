/**
 * Le comptoir — poser, déplacer et solder un rendez-vous depuis le planning (#50).
 *
 * Tout ce que le tiroir de rendez-vous calcule est ici, en fonctions pures : le
 * composant ne fait que rendre ce que ce module décrit, exactement comme
 * `calendar-grid.ts` porte le calcul de la grille. C'est ce qui rend testable
 * sans navigateur les trois choses qui coûtent le plus cher à rater sur cet
 * écran — un rendez-vous posé une heure à côté parce que le fuseau du navigateur
 * s'est glissé dans la conversion, un créneau perdu traité comme une panne, et
 * une action de statut proposée alors que le cycle de vie l'interdit.
 *
 * ## Le fuseau, et la seule conversion qui soit correcte ici
 *
 * L'opérateur saisit **une date civile et une heure civile du salon** — c'est ce
 * que le calendrier vient de lui montrer, et c'est ce qu'il répète au téléphone.
 * Le contrat, lui, attend un instant à offset explicite (`offsetDateTimeSchema`,
 * #297). Entre les deux il y a une conversion, et il n'y en a qu'une de juste :
 * celle qui prend l'offset **de l'établissement** à cette date-là.
 *
 * La tentation est d'écrire `new Date('2026-08-26T14:30')` et de laisser le
 * moteur faire. Elle est fausse : ce constructeur applique le fuseau du
 * navigateur, et une gérante qui consulte son salon d'Antananarivo depuis Paris
 * poserait tous ses rendez-vous avec une heure de décalage. C'est ce que l'en-tête
 * de `schemas/appointment.ts` demande d'éviter, et `offsetInTenant` est la
 * réponse — l'offset y est **mesuré** sur `Intl`, jamais deviné.
 */

import {
  APPOINTMENT_STATUS_TRANSITIONS,
  ERROR_CODES,
  canTransitionAppointment,
  type Appointment,
  type AppointmentStatus,
  type CalendarDate,
  type Service,
  type TimeZone,
} from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '../format';
import { fillMessage, planningWords, CALENDAR_FALLBACK_LOCALE } from './calendar-messages';
import { zonedFields } from './calendar-grid';

/** Le repli d'affichage de ce module — voir `lib/format.ts`, même arbitrage. */
const FALLBACK_DISPLAY: DisplayLocale = { locale: CALENDAR_FALLBACK_LOCALE };

// ---------------------------------------------------------------------------
// Le verdict d'un refus — la cause, jamais la phrase
// ---------------------------------------------------------------------------

/**
 * `true` si le refus est un créneau perdu sous concurrence, et non une panne.
 *
 * Sous concurrence, ce n'est **pas** une panne : c'est le cas normal d'un salon
 * à plusieurs postes (web-frontend §3). D'où, chez les deux appelants, un ton
 * `warning` plutôt que `danger`, et un rechargement de la période plutôt qu'un
 * formulaire vidé.
 *
 * ## Ce module dit ce qu'**est** le refus, plus comment l'écrire (#1187)
 *
 * Les phrases correspondantes vivent dans `messages/{fr,en}/admin-planning.json`
 * depuis #848, et les deux composants qui les rendent les y lisent avec leur
 * traducteur : `appointment-panel.tsx` pour le tiroir — `desk.conflictBody`,
 * `desk.routeMissing`, `desk.cancelConflict` — et `calendar-board.tsx` pour le
 * glisser-déposer — `move.conflictBody`, `move.goneBody`. Les avoir gardées ici
 * en double laissait la copie morte diverger du catalogue sans qu'aucun test ne
 * le dise : corriger une faute de frappe dans les JSON ne l'aurait pas touchée.
 *
 * Le verdict, lui, reste ici : c'est un fait sur un code d'erreur, pas un mot —
 * et les deux appelants doivent le lire de la même façon. Le **pourquoi** de la
 * formulation qui en découle est écrit à l'en-tête du namespace,
 * `messages/admin-planning.d.ts`.
 */
export function isSlotConflict(code: string): boolean {
  return code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE || code === ERROR_CODES.CONFLICT;
}

// ---------------------------------------------------------------------------
// Le fuseau du salon — civil ⇄ instant
// ---------------------------------------------------------------------------

/**
 * Décalage de `timeZone` par rapport à UTC **à cet instant-là**, en minutes.
 *
 * Mesuré et non tabulé : `Intl` connaît les règles de changement d'heure de
 * chaque fuseau, une table écrite ici serait périmée à la première réforme. Le
 * principe est de lire l'instant à l'horloge du fuseau, de relire ces champs
 * comme s'ils étaient UTC, et de prendre l'écart.
 */
export function offsetInTenant(instant: Date, timeZone: TimeZone): number {
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

  const asIfUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );

  // Arrondi à la minute : certains fuseaux historiques portent des secondes, et
  // un offset non entier ne s'écrit pas en `±HH:MM`.
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/** « +03:00 » — un décalage en minutes, tel qu'ISO 8601 l'écrit. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);

  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/**
 * La date et l'heure civiles du salon, écrites en ISO 8601 **avec l'offset de
 * l'établissement** — la forme que `offsetDateTimeSchema` attend.
 *
 * ## Pourquoi deux passes
 *
 * L'offset dépend de l'instant, et l'instant dépend de l'offset : c'est
 * circulaire. La première passe prend les champs civils comme s'ils étaient UTC
 * et en tire un offset approché — juste à moins d'un jour près, donc exact sauf
 * si un changement d'heure tombe dans cet intervalle. La seconde le remesure sur
 * l'instant corrigé, et converge.
 *
 * Dans le trou d'un passage à l'heure d'été — une heure civile qui n'existe pas —
 * la valeur rendue est celle de l'un des deux côtés du saut. Il n'y a pas de
 * bonne réponse à une heure qui n'existe pas, et c'est de toute façon le serveur
 * qui juge le créneau : il tombera sur `SLOT_OUTSIDE_WORKING_HOURS` ou sur le
 * créneau voisin, et l'opérateur verra le récapitulatif avant d'enregistrer.
 */
export function offsetDateTimeInTenant(
  date: CalendarDate,
  time: string,
  timeZone: TimeZone,
): string {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const approximate = offsetInTenant(new Date(naive), timeZone);
  const offset = offsetInTenant(new Date(naive - approximate * 60_000), timeZone);

  return `${date}T${time}:00${formatOffset(offset)}`;
}

/** L'inverse : un instant UTC ramené aux champs des contrôles `date` et `time`. */
export function tenantFields(
  instant: string,
  timeZone: TimeZone,
): { readonly date: CalendarDate; readonly time: string } {
  const { date, minutes } = zonedFields(instant, timeZone);

  return {
    date,
    time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
  };
}

// ---------------------------------------------------------------------------
// Le récapitulatif calculé
// ---------------------------------------------------------------------------

/**
 * Ce que le pavé de récapitulatif affiche — fin, tampon et montant.
 *
 * Aucun de ces champs ne se saisit, et c'est le point que la maquette
 * (`mockups/admin/rendez-vous.html`) insiste à rendre visible : les rendre
 * saisissables ouvrirait la porte à une fin incohérente avec le début, donc à un
 * chevauchement que la contrainte d'exclusion refuserait **après** la saisie.
 *
 * Le tampon rendu est celui d'**après** le soin : c'est le seul qui explique à
 * l'opérateur pourquoi le créneau suivant n'est pas libre à l'heure qu'il
 * attend. Le tampon d'avant est déjà écoulé quand la question se pose.
 *
 * Aucune arithmétique sur le montant : il est repris tel quel de la prestation,
 * et le total qui fait foi reste celui que le serveur fige à la réservation
 * (`appointmentSchema.price`).
 */
export interface DeskSummary {
  readonly startTime: string;
  readonly endTime: string;
  readonly bufferMinutes: number;
  /** Heure à laquelle le praticien redevient libre, tampon compris. */
  readonly freeAtTime: string;
  readonly durationMinutes: number;
}

/** « 14:30 » — des minutes depuis minuit, en heure civile. */
function clockOf(minutes: number): string {
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);

  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** Minutes depuis minuit d'une heure civile « HH:MM ». Rend `null` si illisible. */
export function minutesOfClock(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);

  if (match === null) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

/**
 * Ce dont le récapitulatif a besoin d'une prestation, et rien de plus.
 *
 * Une `Service` du catalogue le satisfait, mais aussi la copie figée que porte
 * un rendez-vous (`appointmentSchema.service`) : c'est elle qu'il faut quand la
 * prestation a été retirée du catalogue depuis la réservation, et exiger la
 * `Service` entière interdirait ce cas-là pour des champs — slug, catégorie,
 * activation — dont ce calcul ne fait rien.
 */
export type SummarizableService = Pick<Service, 'durationMinutes' | 'bufferAfterMinutes'>;

/** Le récapitulatif d'une prestation posée à une heure donnée. */
export function summarize(service: SummarizableService, time: string): DeskSummary | null {
  const start = minutesOfClock(time);

  if (start === null) {
    return null;
  }

  const end = start + service.durationMinutes;

  return {
    startTime: clockOf(start),
    endTime: clockOf(end),
    bufferMinutes: service.bufferAfterMinutes,
    freeAtTime: clockOf(end + service.bufferAfterMinutes),
    durationMinutes: service.durationMinutes,
  };
}

// ---------------------------------------------------------------------------
// Les créneaux réellement proposables — #611
// ---------------------------------------------------------------------------

/**
 * Pourquoi le tiroir ne laisse plus saisir une heure libre.
 *
 * La création de rendez-vous ne réussit que sur un créneau que le moteur de
 * disponibilité a **lui-même rendu** : `AppointmentsService.offeredStaffAt`
 * rejoue `slotsFor` et exige l'égalité stricte de l'instant demandé avec l'un
 * des créneaux offerts, sans quoi il lève `SlotNoLongerAvailableError`. Ce n'est
 * pas un excès de zèle — c'est ce qui garantit qu'un rendez-vous posé au
 * comptoir est aussi honorable qu'un autre : dans les heures du praticien, hors
 * congé, tampons compris.
 *
 * Or le planning dessine une grille de trente minutes depuis minuit, et le
 * moteur aligne ses créneaux sur le **début de plage du praticien**, au pas de
 * quinze minutes. Les deux ne coïncident qu'accidentellement : un praticien qui
 * ouvre à 07:10 n'a pas un seul créneau à la minute 00 de la journée, et chaque
 * case du planning menait alors à un refus (#611).
 *
 * D'où ce module : la rangée cliquée n'est plus une heure de réservation, c'est
 * une **intention** — « vers 10 h, chez Hasina ». Le tiroir la résout en un
 * créneau réel, et n'offre à choisir que ceux-là.
 */
export interface DeskSlotOption {
  /** Heure civile du salon, « HH:MM » — la valeur du sélecteur. */
  readonly time: string;
  /**
   * L'instant exact rendu par le moteur, tel quel.
   *
   * C'est **lui** qu'on renvoie à l'API, et non une reconversion de l'heure
   * civile : l'égalité que `offeredStaffAt` exige porte sur la chaîne ISO, et
   * refaire le trajet `civil → instant` rouvrirait sans raison la question du
   * changement d'heure — une heure murale qui n'existe pas dans le trou d'un
   * passage à l'heure d'été n'a pas de conversion juste (voir
   * `offsetDateTimeInTenant`).
   */
  readonly startsAt: string;
}

/**
 * Les créneaux d'une journée, dédoublonnés par heure civile et ordonnés.
 *
 * Le dédoublonnage n'est pas cosmétique : sans praticien désigné — l'option
 * « premier disponible » —, le moteur rend un créneau **par praticien libre**,
 * et le sélecteur afficherait trois fois « 09:25 » sans que rien ne les
 * distingue. L'un d'eux suffit : c'est le serveur qui affecte, et il refera
 * l'affectation à l'écriture (#36).
 *
 * Le tri se fait sur l'heure civile en `HH:MM`, où l'ordre lexicographique est
 * l'ordre chronologique — la fenêtre demandée étant d'une seule journée.
 */
export function deskSlotOptions(
  slots: readonly { readonly startsAt: string }[],
  timeZone: TimeZone,
): readonly DeskSlotOption[] {
  const byTime = new Map<string, DeskSlotOption>();

  for (const slot of slots) {
    const { time } = tenantFields(slot.startsAt, timeZone);

    if (!byTime.has(time)) {
      byTime.set(time, { time, startsAt: slot.startsAt });
    }
  }

  return [...byTime.values()].sort((left, right) => left.time.localeCompare(right.time));
}

/**
 * Le créneau à préselectionner pour une heure visée : le **premier à partir
 * d'elle**, et le dernier de la journée s'il n'y en a plus après.
 *
 * « À partir de » et non « le plus proche », parce que c'est exactement ce que
 * la case du planning annonce désormais — « poser un rendez-vous à partir de
 * cette heure ». Cliquer la rangée de 10 h et voir s'ouvrir 09:55 ferait
 * remonter le rendez-vous au-dessus de l'endroit visé, et l'opératrice a
 * rarement envie de le poser *avant* ce qu'elle a montré du doigt.
 *
 * Le repli sur le dernier créneau évite le cas contraire : une fin de journée
 * cliquée trop bas doit proposer ce qui reste, pas rien du tout.
 *
 * Rend `null` sur une liste vide — la journée est complète, ou le praticien ne
 * travaille pas : c'est au tiroir de le dire, pas à cette fonction d'inventer
 * une heure.
 *
 * La liste est supposée triée, ce que `deskSlotOptions` garantit.
 */
export function nearestDeskSlot(
  options: readonly DeskSlotOption[],
  wanted: string,
): DeskSlotOption | null {
  const last = options[options.length - 1];

  if (last === undefined) {
    return null;
  }

  const target = minutesOfClock(wanted);

  if (target === null) {
    return options[0] ?? null;
  }

  return (
    options.find((option) => {
      const minutes = minutesOfClock(option.time);

      return minutes !== null && minutes >= target;
    }) ?? last
  );
}

// ---------------------------------------------------------------------------
// Ce que le pied du tiroir propose — cinquième critère
// ---------------------------------------------------------------------------

/**
 * Une action de statut offerte par le pied du tiroir.
 *
 * Elle porte la transition et l'allure du bouton, **pas son libellé** : celui-ci
 * se compose dans l'écran qui le rend, à partir du catalogue et dans la langue
 * de la session — `appointment-panel.tsx` au comptoir, `my-planning-client.tsx`
 * sur « Mon planning ». Les deux le faisaient déjà depuis #848 ; le champ
 * `label` qui subsistait ici n'était plus lu que par son propre test (#1187).
 */
export interface DeskStatusAction {
  readonly status: AppointmentStatus;
  /** Variante du bouton, telle que `components/ui/button.tsx` la nomme. */
  readonly variant: 'danger' | 'quiet' | 'neutral';
}

/**
 * Les transitions que le comptoir déclenche par la route de statut.
 * `cancelled` n'y est pas, et n'a pas à y être : l'annulation a sa propre route
 * (`POST /appointments/:id/cancel`, #40), son propre corps — un motif — et sa
 * propre confirmation. Ce sont ces trois choses que le pied du tiroir rend
 * désormais (#754), par `isCancellable` et `cancelDeskAppointmentAction` ; ce
 * qui manquait n'était pas une entrée de plus dans cette table, c'était l'écran.
 *
 * ## `confirmed` y est entré, et c'était la **première** marche (#973)
 *
 * La table n'avait pas d'entrée pour lui, si bien que `deskStatusActions` ne
 * rendait rien sur un rendez-vous `pending` : le tiroir n'y offrait que
 * l'annulation, la fermeture et le report, et aucun écran du back-office ne
 * portait de bouton de confirmation. Or `pending` est l'état où **naît tout
 * rendez-vous** (`appointments.repository.ts`), et le cycle de vie refuse
 * `pending → completed` en `INVALID_STATE_TRANSITION` : un rendez-vous que le
 * salon n'avait pas confirmé ne pouvait donc jamais être marqué honoré ni non
 * honoré, et le suivi des no-shows (CDC §1.4) lui échappait pour de bon. La
 * boucle de valeur du produit — « réserver → confirmer → honorer le rendez-vous
 * → encaisser » (CDC §1.3) — était coupée à son deuxième maillon, du côté du
 * comptoir.
 *
 * Rien d'autre n'a eu à changer : la route est servie depuis #50
 * (`POST /appointments/:id/status`, seuil `STAFF`), `APPOINTMENT_STATUS_TRANSITIONS`
 * autorise `pending → confirmed` depuis l'origine, et
 * `markDeskAppointmentStatusAction` passe n'importe quel statut que
 * `changeAppointmentStatusRequestSchema` accepte. Il manquait la ligne qui
 * déclare la marche offerte.
 *
 * ## Le nom de la table a survécu à ses libellés (#1187)
 *
 * Elle n'en porte plus : depuis #848 les boutons composent leur mot dans la
 * langue de la session, et ce qui reste ici est la table des transitions que le
 * comptoir **offre** — sa clé et l'allure du bouton. Le nom est conservé tel
 * quel parce que trois scénarios de bout en bout le citent dans leurs en-têtes
 * pour expliquer ce que le pied du tiroir propose ; le renommer y laisserait
 * des renvois vers un symbole qui n'existe plus.
 */
const DESK_STATUS_LABELS: Partial<Record<AppointmentStatus, DeskStatusAction>> = {
  confirmed: {
    status: 'confirmed',
    // `neutral`, et non `accent` : le design system réserve l'accent à l'action
    // principale (`styles/README.md`, « Variantes »), et le pied en porte déjà
    // une — le report. Deux accents côte à côte ne hiérarchisent plus rien.
    // C'est aussi la variante de « Marquer honoré », qui est la marche suivante
    // du même escalier.
    variant: 'neutral',
  },
  completed: {
    status: 'completed',
    variant: 'neutral',
  },
  no_show: {
    status: 'no_show',
    variant: 'quiet',
  },
};

/**
 * Les actions de statut réellement atteignables depuis ce rendez-vous.
 *
 * Lues dans `APPOINTMENT_STATUS_TRANSITIONS` du contrat partagé, jamais
 * réécrites : le serveur refuse en `INVALID_STATE_TRANSITION` ce qui n'y figure
 * pas, et un bouton qui mène à un 422 est un bouton qui ment. Un rendez-vous
 * `pending` n'offre donc que la confirmation — on ne solde pas un soin qui n'a
 * pas été confirmé (#973) —, et un rendez-vous terminal n'offre plus rien du
 * tout.
 *
 * L'ordre est celui de la table du contrat, et c'est celui dans lequel le pied
 * du tiroir les rend : les marches se lisent dans le sens où on les monte.
 */
export function deskStatusActions(status: AppointmentStatus): readonly DeskStatusAction[] {
  return APPOINTMENT_STATUS_TRANSITIONS[status]
    .map((target) => DESK_STATUS_LABELS[target])
    .filter((action): action is DeskStatusAction => action !== undefined);
}

/**
 * `true` si le rendez-vous peut encore être annulé par le salon — #754.
 *
 * La table du contrat partagé tranche, et elle seule : un rendez-vous terminé,
 * déjà annulé ou marqué non présenté est dans un état **terminal**, et l'API le
 * refuserait en `INVALID_STATE_TRANSITION`. Offrir le bouton quand même serait
 * offrir un 422 — un bouton qui mène à un refus est un bouton qui ment, c'est la
 * règle que `deskStatusActions` applique déjà à ses propres transitions.
 */
export function isCancellable(status: AppointmentStatus): boolean {
  return canTransitionAppointment(status, 'cancelled');
}

/**
 * `true` si le rendez-vous peut encore être déplacé — un soldé ne bouge plus.
 *
 * C'est exactement la même condition que l'annulation, et ce n'est pas une
 * coïncidence : côté serveur, un report **est** une annulation suivie d'une
 * création liée, dans une seule transaction (booking-engine §5). Ce que le
 * cycle de vie refuse d'annuler, il refuse donc de le déplacer.
 */
export function isReschedulable(status: AppointmentStatus): boolean {
  return isCancellable(status);
}

// ---------------------------------------------------------------------------
// Le report par glisser-déposer — #51
// ---------------------------------------------------------------------------

/**
 * La colonne et la rangée où le bloc vient d'être lâché.
 *
 * Ce sont les champs que porte déjà la cellule libre du planning
 * (`CalendarFreeCell`) : une journée et une heure **civiles du salon**, converties
 * une seule fois par `calendar-grid.ts`. Les recalculer au moment du lâcher les
 * referait avec le fuseau du navigateur — l'erreur exacte que l'en-tête de ce
 * module met en garde de commettre.
 */
export interface DeskMoveTarget {
  readonly day: CalendarDate;
  /** Heure civile de la rangée visée, « HH:MM ». */
  readonly time: string;
  /**
   * Praticien de la colonne visée, `null` en vue semaine — où une colonne est une
   * journée de toute l'équipe et ne désigne donc personne. Le report garde alors
   * le praticien du rendez-vous, et ne demande aucune confirmation.
   */
  readonly staff: Appointment['staff'] | null;
}

/** Un report projeté : ce qu'on affiche, ce qu'on envoie, ce qu'on remet en place. */
export interface DeskMove {
  /** Le rendez-vous tel qu'il était — c'est lui qu'un refus replace. */
  readonly previous: Appointment;
  /**
   * Le même, à sa nouvelle heure. C'est l'état optimiste du deuxième critère :
   * l'écran l'affiche sans attendre l'API, et il porte **l'identifiant d'origine**
   * — le report en rendra un neuf, qui prendra sa place au succès.
   */
  readonly optimistic: Appointment;
  /**
   * Le corps de `POST /appointments/:id/reschedule`.
   *
   * Un report passe par cette route et jamais par une mise à jour des dates en
   * place : côté serveur c'est une annulation suivie d'une création liée par
   * `rescheduled_from_id`, dans une seule transaction (booking-engine §5). C'est
   * le premier critère du ticket, et il se joue ici — le geste change, le
   * mécanisme non.
   */
  readonly request: { readonly startsAt: string; readonly staffId?: string };
  /** `true` quand le report change de praticien — la confirmation du 4e critère. */
  readonly changesStaff: boolean;
}

/**
 * Le report que ce lâcher décrit, ou `null` s'il n'y a rien à déplacer.
 *
 * Rend `null` dans trois cas, et c'est ce qui évite d'écrire l'agenda pour rien :
 * un rendez-vous soldé — honoré, annulé, non présenté — ne bouge plus ; un
 * lâcher sur sa propre heure chez son propre praticien ne déplace rien ; une
 * heure illisible ne se convertit pas. Le troisième cas ne devrait pas arriver,
 * les cellules portant des heures qu'on a écrites, mais une conversion muette qui
 * rendrait `Invalid Date` partirait sinon jusqu'à l'API.
 *
 * La durée est **conservée** : c'est celle du rendez-vous d'origine, prestation
 * figée comprise (`appointmentSchema.service`). Un report ne change pas le soin,
 * donc ne change pas sa durée — et le serveur recalculera de toute façon
 * l'intervalle occupé à partir de la prestation, tampons compris.
 */
export function planDeskMove(
  appointment: Appointment,
  target: DeskMoveTarget,
  timeZone: TimeZone,
): DeskMove | null {
  if (!isReschedulable(appointment.status)) {
    return null;
  }

  const startsAt = offsetDateTimeInTenant(target.day, target.time, timeZone);
  const start = Date.parse(startsAt);
  const previousStart = Date.parse(appointment.startsAt);

  if (Number.isNaN(start) || Number.isNaN(previousStart)) {
    return null;
  }

  const staff = target.staff ?? appointment.staff;
  const changesStaff = staff.id !== appointment.staff.id;

  if (!changesStaff && start === previousStart) {
    return null;
  }

  const duration = Date.parse(appointment.endsAt) - previousStart;

  return {
    previous: appointment,
    optimistic: {
      ...appointment,
      staff,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + (Number.isNaN(duration) ? 0 : duration)).toISOString(),
    },
    request: {
      startsAt,
      // Le praticien n'est nommé que quand la colonne en désigne un. En vue
      // semaine il n'y en a pas, et l'omettre laisse le serveur garder celui du
      // rendez-vous — ce que `reschedule` fait explicitement (`input.staffId ??
      // previous.staffId`).
      ...(target.staff === null ? {} : { staffId: target.staff.id }),
    },
    changesStaff,
  };
}

/**
 * « mercredi 26 août à 09:00 », « Wednesday, August 26 at 09:00 » — un instant
 * UTC dit à l'heure du salon.
 *
 * La langue vient de la session et la région de l'établissement (#848) : ce
 * libellé est **inséré dans des phrases traduites** — la question du changement
 * de praticien et la bannière de retour arrière du planning —, et une date
 * française au milieu d'une phrase anglaise s'y lisait comme un défaut
 * d'affichage. Le fuseau, lui, reste `timeZone` : il décide de l'heure, jamais
 * de son écriture.
 */
export function deskMoment(
  instant: string,
  timeZone: TimeZone,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  const { date, time } = tenantFields(instant, timeZone);
  // La date civile est mise en forme **en UTC** : elle est déjà celle du salon,
  // et la reprojeter dans son fuseau la décalerait d'un jour à l'est de
  // Greenwich. Même raison que `rangeLabel` de `calendar-range.ts`.
  const day = new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));

  // Le joint des deux — « à » en français, « at » en anglais — vient du
  // catalogue : `Intl` ne sait pas dire ce mot-là.
  return fillMessage(planningWords(display.locale).move.moment, { day, time });
}

/**
 * Ce que la bannière de retour arrière annonce.
 *
 * La **composition** de ces trois champs vit dans `calendar-board.tsx`, seul
 * endroit où un traducteur est disponible (#848) ; ce module n'en garde que la
 * forme et le verdict qui l'alimente, `isSlotConflict`.
 */
export interface DeskMoveRefusal {
  readonly title: string;
  readonly body: string;
  /** `warning` pour un créneau perdu, `danger` pour un refus qui ne se rejoue pas. */
  readonly tone: 'warning' | 'danger';
}
