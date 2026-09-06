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
 * Ce qu'on montre quand le créneau a été pris pendant la saisie.
 *
 * Sous concurrence, ce n'est **pas** une panne : c'est le cas normal que le
 * quatrième critère du ticket demande de traiter (web-frontend §3). D'où un ton
 * `warning` et non `danger`, et d'où le rechargement de la période plutôt qu'un
 * formulaire vidé.
 */
export const SLOT_CONFLICT_MESSAGE =
  'Ce créneau vient d’être pris depuis un autre poste. Le planning a été rechargé ; vos autres saisies sont conservées.';

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
 * Le créneau perdu, dit pour un **report** et non pour une saisie.
 *
 * `SLOT_CONFLICT_MESSAGE` promet que « vos autres saisies sont conservées » : vrai
 * dans le tiroir, où un formulaire attend ; hors sujet sur un glisser-déposer, où
 * il n'y a rien de saisi et où la seule chose à dire est qu'il faut viser
 * ailleurs.
 */
export const MOVE_CONFLICT_MESSAGE =
  'Ce créneau vient d’être pris depuis un autre poste : visez-en un autre.';

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
      ? 'Créneau déjà pris — rendez-vous remis en place'
      : 'Report refusé — rendez-vous remis en place',
    body: `${restored} ${reason}`,
    tone: transient ? 'warning' : 'danger',
  };
}
