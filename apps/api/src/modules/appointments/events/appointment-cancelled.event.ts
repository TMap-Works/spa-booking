import type { AppointmentCancelledBy, OccupyingStatus } from '../appointment-status';

/**
 * L'événement de domaine `appointment.cancelled` — le cinquième critère de #40.
 *
 * ## Ce que l'aval en fait, et pourquoi un nom distinct
 *
 * `notifications` (S4) a **deux** choses à faire d'une annulation, et aucune ne
 * se déduit d'un `appointment.rescheduled` :
 *
 * 1. envoyer l'avis d'annulation — dont le texte dépend de `cancelledBy` : « vous
 *    avez annulé votre rendez-vous » et « le salon a annulé votre rendez-vous »
 *    ne se disent pas de la même façon, et la seconde appelle une excuse ;
 * 2. **déprogrammer le rappel J-1** déjà planifié. Sans cela, la cliente reçoit
 *    la veille un SMS pour un rendez-vous qui n'existe plus — le défaut le plus
 *    visible qu'une chaîne de notifications puisse produire.
 *
 * `reporting` (S4) s'en sert pour la troisième raison, celle que le contexte de
 * l'issue nomme : le taux d'annulation du CDC §1.4 ne veut rien dire s'il mêle
 * les clientes qui se décommandent et les journées que le salon a fermées.
 *
 * ## Ce que la charge utile porte, et ce qu'elle ne porte pas
 *
 * Des **identifiants**, des instants et une catégorie close. Jamais de
 * coordonnées — ni adresse, ni numéro, ni nom —, même discipline que ses deux
 * voisins : un événement circule, se journalise et se rejoue, et ce qu'il ne
 * contient pas ne peut pas fuiter par ces trois chemins.
 *
 * **Et jamais le motif.** `cancellation_reason` est un texte libre écrit par un
 * humain : il peut contenir n'importe quoi — un état de santé, le nom d'un
 * tiers, un jugement sur la cliente. Le faire voyager dans un événement le
 * déposerait dans les journaux de publication et, demain, dans une file SQS. Il
 * est **enregistré sur la ligne** ; qui a le droit de le lire l'y relit, avec
 * `appointmentId` pour seule clé (CDC §5.1).
 *
 * `tenantId` y est, pour la raison qui vaut partout : un abonné asynchrone
 * s'exécute hors de la portée de tenant de la requête qui a produit l'événement.
 */

/** Le nom sous lequel l'événement est publié. */
export const APPOINTMENT_CANCELLED = 'appointment.cancelled' as const;

/**
 * Un rendez-vous vient d'être annulé : son statut est `CANCELLED`, et son
 * créneau est **déjà** réservable — la ligne a quitté le filtre partiel de la
 * contrainte d'exclusion au `COMMIT`.
 *
 * Les instants du soin sont l'intervalle **facturé**, tampons exclus : c'est ce
 * qu'un avis d'annulation doit rappeler, et c'est l'heure que la cliente avait
 * notée.
 */
export interface AppointmentCancelledEvent {
  readonly name: typeof APPOINTMENT_CANCELLED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly clientId: string;
  readonly serviceId: string;
  readonly staffId: string;
  /** Début du soin annulé, ISO 8601 UTC — le créneau qui vient d'être rendu. */
  readonly startsAt: string;
  /** Fin du soin annulé, ISO 8601 UTC. */
  readonly endsAt: string;
  /**
   * Le statut **d'où** l'annulation part — `PENDING` ou `CONFIRMED`.
   *
   * Typé par `OccupyingStatus` et non par une union recopiée : ce sont
   * exactement les statuts depuis lesquels une annulation est possible, et les
   * deux listes ne peuvent donc pas diverger. L'aval s'en sert pour savoir s'il
   * y a un rappel à déprogrammer — un `PENDING` n'en a jamais eu.
   */
  readonly previousStatus: OccupyingStatus;
  /** De quel côté du comptoir la décision vient. */
  readonly cancelledBy: AppointmentCancelledBy;
  /** Instant de l'annulation, ISO 8601 UTC — celui qui est inscrit sur la ligne. */
  readonly cancelledAt: string;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
