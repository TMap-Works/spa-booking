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

import { zonedFields } from './calendar-grid';

// ---------------------------------------------------------------------------
// Les routes que l'API ne sert pas encore
// ---------------------------------------------------------------------------

/**
 * Ce que le tiroir affiche quand une écriture tombe sur une route absente.
 *
 * `apps/api` sert l'agenda (`GET /appointments`, #444) et l'annulation
 * (`POST /appointments/:id/cancel`, #40), mais **aucune écriture de comptoir** :
 * ni `POST /appointments`, ni `/:id/reschedule`, ni `/:id/status`. Le contrat
 * partagé les décrit pourtant — `createAppointmentRequestSchema.clientId` est
 * annoté « réservé au back-office », `changeAppointmentStatusRequestSchema` dit
 * « changement de statut par le back-office ».
 *
 * L'écran est donc écrit contre le contrat et **dégrade**, comme la grille de
 * #49 a dégradé jusqu'à ce que #444 serve sa route : il s'affiche, il valide, il
 * dit ce qui manque, et il fonctionnera sans une ligne à changer ici le jour où
 * les routes existeront. Un message générique aurait masqué un manque
 * parfaitement identifié derrière une phrase qui n'aide personne — même
 * raisonnement que `CALENDAR_ROUTE_MISSING_MESSAGE`.
 */
export const DESK_ROUTE_MISSING_MESSAGE =
  'L’écriture de rendez-vous au comptoir n’est pas encore servie par l’API : le formulaire est complet, l’enregistrement suivra.';

/**
 * Ce qu'on montre quand l'API refuse le créneau en `SLOT_NO_LONGER_AVAILABLE`.
 *
 * Sous concurrence, ce n'est **pas** une panne : c'est le cas normal que le
 * quatrième critère du ticket demande de traiter (web-frontend §3). D'où un ton
 * `warning` et non `danger`, et d'où le rechargement de la période plutôt qu'un
 * formulaire vidé.
 *
 * ## Ce message n'affirme plus une cause qu'il ne connaît pas (#611)
 *
 * Il a longtemps dit « vient d'être pris depuis un autre poste ». C'était une
 * **déduction**, et elle était fausse la plupart du temps : le contrôleur
 * annonce noir sur blanc que ce seul code « couvre toutes les façons dont le
 * créneau n'est pas réservable — pris entre l'affichage et la validation, hors
 * des heures du praticien, pendant un congé, sous le préavis, ou chez un
 * praticien qui ne pratique pas ce soin »
 * (`apps/api/src/modules/appointments/appointments.controller.ts`). Rien dans le
 * corps du refus ne permet de trancher — `details` ne rend que le `staffId` et
 * le `startsAt` que l'appelant vient d'envoyer, délibérément, pour ne pas faire
 * de ce 409 une sonde d'agenda.
 *
 * La campagne de QA a mesuré ce que coûte cette invention : six refus
 * consécutifs au comptoir, tous annoncés comme une course perdue entre postes,
 * sur une journée qui ne portait **aucun** rendez-vous. L'opératrice cherchait
 * une collègue qui n'avait rien réservé.
 *
 * Le message énumère donc les causes possibles sans en désigner une, et se
 * termine par le seul geste qui débloque : reprendre une heure dans la liste.
 */
export const SLOT_CONFLICT_MESSAGE =
  'Ce créneau n’est pas — ou n’est plus — réservable : il a pu être pris depuis un autre poste, sortir des heures du praticien, ou ne plus être proposé pour cette prestation. Le planning a été rechargé ; reprenez une heure dans la liste — vos autres saisies sont conservées.';

/**
 * `HTTP_404` est le repli du client d'API quand le corps d'erreur ne suit pas le
 * contrat — un 404 servi par le cadre HTTP plutôt que par le filtre d'exception
 * de Nest. Sur les routes d'écriture du comptoir, les deux disent la même chose.
 *
 * Le `NOT_FOUND` du filtre, lui, est **ambigu** sur `/:id/reschedule` et
 * `/:id/status` : il peut désigner la route absente comme le rendez-vous
 * introuvable. Il n'y a pas moyen de trancher depuis le front, et c'est assumé —
 * tant qu'aucune des deux routes n'existe, l'absence est la seule lecture
 * possible ; quand elles existeront, ce module n'aura plus à le dire du tout.
 */
const MISSING_ROUTE_CODES: readonly string[] = [ERROR_CODES.NOT_FOUND, 'HTTP_404'];

/** `true` si le refus est un créneau perdu sous concurrence, et non une panne. */
export function isSlotConflict(code: string): boolean {
  return code === ERROR_CODES.SLOT_NO_LONGER_AVAILABLE || code === ERROR_CODES.CONFLICT;
}

/** Le message à afficher pour un refus d'écriture du comptoir. */
export function deskFailureMessage(code: string, message: string): string {
  if (isSlotConflict(code)) {
    return SLOT_CONFLICT_MESSAGE;
  }

  return MISSING_ROUTE_CODES.includes(code) ? DESK_ROUTE_MISSING_MESSAGE : message;
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

/**
 * Ce que le tiroir dit quand la liste des créneaux n'a pas pu être lue.
 *
 * Le sélecteur retombe alors sur une saisie libre plutôt que de se bloquer :
 * une lecture de disponibilité en panne ne doit pas fermer le comptoir, et
 * l'API reste de toute façon le juge du créneau. Le ton est celui d'un
 * avertissement, pas d'une panne — ce qui suit est possible, seulement moins
 * sûr.
 */
export const DESK_SLOTS_UNREADABLE_MESSAGE =
  'Les créneaux proposés par le planning n’ont pas pu être lus : saisissez l’heure à la main, elle sera vérifiée à l’enregistrement.';

/** Ce que le sélecteur affiche à la place d'une liste vide. */
export const DESK_NO_SLOT_MESSAGE =
  'Aucun créneau ce jour-là pour cette prestation. Changez de date, de praticien, ou de prestation.';

// ---------------------------------------------------------------------------
// Ce que le pied du tiroir propose — cinquième critère
// ---------------------------------------------------------------------------

/** Une action de statut offerte par le pied du tiroir. */
export interface DeskStatusAction {
  readonly status: AppointmentStatus;
  readonly label: string;
  /** Variante du bouton, telle que `components/ui/button.tsx` la nomme. */
  readonly variant: 'danger' | 'quiet' | 'neutral';
}

/**
 * Libellés des transitions que le comptoir déclenche. `cancelled` n'y est pas :
 * l'annulation a sa propre route (`POST /appointments/:id/cancel`, #40), son
 * propre corps — un motif — et sa propre confirmation.
 */
const DESK_STATUS_LABELS: Partial<Record<AppointmentStatus, DeskStatusAction>> = {
  completed: { status: 'completed', label: 'Marquer honoré', variant: 'neutral' },
  no_show: { status: 'no_show', label: 'Marquer non présenté', variant: 'quiet' },
};

/**
 * Les actions de statut réellement atteignables depuis ce rendez-vous.
 *
 * Lues dans `APPOINTMENT_STATUS_TRANSITIONS` du contrat partagé, jamais
 * réécrites : le serveur refuse en `INVALID_STATE_TRANSITION` ce qui n'y figure
 * pas, et un bouton qui mène à un 422 est un bouton qui ment. Un rendez-vous
 * `pending` n'offre donc rien — on ne solde pas un soin qui n'a pas été confirmé
 * —, et un rendez-vous terminal n'offre plus rien du tout.
 */
export function deskStatusActions(status: AppointmentStatus): readonly DeskStatusAction[] {
  return APPOINTMENT_STATUS_TRANSITIONS[status]
    .map((target) => DESK_STATUS_LABELS[target])
    .filter((action): action is DeskStatusAction => action !== undefined);
}

/** `true` si le rendez-vous peut encore être déplacé — un soldé ne bouge plus. */
export function isReschedulable(status: AppointmentStatus): boolean {
  return canTransitionAppointment(status, 'cancelled');
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

/** « mercredi 26 août à 09:00 » — un instant UTC dit à l'heure du salon. */
export function deskMoment(instant: string, timeZone: TimeZone): string {
  const { date, time } = tenantFields(instant, timeZone);
  // La date civile est mise en forme **en UTC** : elle est déjà celle du salon,
  // et la reprojeter dans son fuseau la décalerait d'un jour à l'est de
  // Greenwich. Même raison que `rangeLabel` de `calendar-range.ts`.
  const day = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T00:00:00Z`));

  return `${day} à ${time}`;
}

/**
 * Le créneau refusé, dit pour un **report** et non pour une saisie.
 *
 * `SLOT_CONFLICT_MESSAGE` promet que « vos autres saisies sont conservées » : vrai
 * dans le tiroir, où un formulaire attend ; hors sujet sur un glisser-déposer, où
 * il n'y a rien de saisi et où la seule chose à dire est qu'il faut viser
 * ailleurs.
 *
 * Même correction de fond que lui (#611) : le code ne dit pas *pourquoi* le
 * créneau est refusé, et l'affirmer envoyait chercher une course entre postes
 * qui n'avait pas eu lieu. Le lâcher vise en outre une **rangée de la grille**,
 * qui n'est pas un créneau du moteur — d'où le renvoi explicite vers le tiroir,
 * seul endroit où la liste des créneaux réellement proposés est offerte.
 */
export const MOVE_CONFLICT_MESSAGE =
  'Ce créneau n’est pas — ou n’est plus — réservable : il a pu être pris depuis un autre poste, ou sortir des heures du praticien. Ouvrez le rendez-vous pour choisir parmi les créneaux proposés.';

/**
 * Le rendez-vous a disparu sous le geste.
 *
 * `deskFailureMessage` lit encore `NOT_FOUND` comme « la route n'existe pas » —
 * c'était vrai du tiroir de #50, écrit avant que l'API serve les écritures du
 * comptoir. Elle les sert depuis #464, et sur un report ce code ne peut plus
 * dire qu'une chose : le rendez-vous qu'on vient de saisir n'est plus là. Le
 * message d'absence de route parlerait ici d'un formulaire qui n'existe pas et
 * promettrait un enregistrement qui ne viendra jamais.
 */
export const MOVE_GONE_MESSAGE =
  'Ce rendez-vous n’existe plus : il vient d’être déplacé ou annulé depuis un autre poste. Rechargez le planning.';

/** Ce que la bannière de retour arrière annonce. */
export interface DeskMoveRefusal {
  readonly title: string;
  readonly body: string;
  /** `warning` pour un créneau perdu, `danger` pour un refus qui ne se rejoue pas. */
  readonly tone: 'warning' | 'danger';
}

/**
 * Le retour arrière rendu lisible — troisième critère, et le cœur du ticket.
 *
 * Replacer le bloc ne suffit pas : un rendez-vous qui saute à sa place d'origine
 * sans un mot passe pour un bug de l'écran, et l'opérateur recommence le même
 * geste. La bannière dit donc **les deux** choses qu'il lui faut — où le
 * rendez-vous est revenu, et pourquoi il n'a pas pu aller ailleurs.
 *
 * Le ton distingue le passager du définitif, comme le fait le tiroir : un créneau
 * pris depuis un autre poste est le cas normal de la concurrence (web-frontend
 * §3), un autre horaire le lève. Un praticien qui ne pratique pas la prestation,
 * un rendez-vous déjà soldé ou une session expirée, non.
 */
export function moveRefusal(
  previous: Appointment,
  timeZone: TimeZone,
  code: string,
  message: string,
): DeskMoveRefusal {
  const transient = isSlotConflict(code);
  const client = `${previous.client.firstName} ${previous.client.lastName}`;
  // « Le rendez-vous de X est resté le … » plutôt que « X est resté au … » : la
  // phrase s'accorde alors sur le rendez-vous, et non sur une cliente dont le
  // contrat ne porte pas le genre — `userSummarySchema` n'a qu'un nom.
  const restored = `Le rendez-vous de ${client} est resté le ${deskMoment(previous.startsAt, timeZone)}, chez ${previous.staff.displayName}.`;
  // `MISSING_ROUTE_CODES` porte les deux façons dont un 404 remonte. Sur un
  // report, il ne dit plus l'absence de route mais l'absence du rendez-vous.
  const reason = transient
    ? MOVE_CONFLICT_MESSAGE
    : MISSING_ROUTE_CODES.includes(code)
      ? MOVE_GONE_MESSAGE
      : deskFailureMessage(code, message);

  return {
    title: transient
      ? // « Indisponible » et non « déjà pris » : le titre est la première chose
        // que l'opératrice lit, et c'est là que l'ancienne version affirmait le
        // plus fort une cause que le refus ne donne pas (#611).
        'Créneau indisponible — rendez-vous remis en place'
      : 'Report refusé — rendez-vous remis en place',
    body: `${restored} ${reason}`,
    tone: transient ? 'warning' : 'danger',
  };
}
