/**
 * L'événement de domaine `appointment.created` — le cinquième critère de #37.
 *
 * ## Pourquoi un événement et pas un appel direct
 *
 * `appointments` ne doit rien savoir de l'existence des notifications
 * (api-module §3) : il annonce qu'un rendez-vous vient d'être posé, et c'est au
 * module `notifications` (S4) de décider qu'un tel fait mérite un e-mail de
 * confirmation et un rappel J-1. L'inverse — le service de réservation appelant
 * `NotificationsService` — ferait échouer une réservation parce qu'un SMS n'est
 * pas parti, ce qui est exactement le couplage que le découpage en modules
 * existe pour empêcher.
 *
 * ## Ce que la charge utile porte, et ce qu'elle ne porte pas
 *
 * Des **identifiants**, jamais des coordonnées : ni l'adresse e-mail, ni le
 * numéro de la cliente, ni son nom. Un abonné qui a besoin de la joindre relit
 * sa fiche dans le tenant nommé par l'événement — c'est la même discipline que
 * `packages/shared/src/schemas/notification.ts`, dont aucun schéma ne porte de
 * coordonnée de destination. Un événement circule, se journalise et se rejoue :
 * ce qu'il ne contient pas ne peut pas fuiter par ces trois chemins.
 *
 * `tenantId` en revanche y **est**, et il est indispensable : un abonné
 * asynchrone s'exécute hors de la portée de tenant de la requête qui a produit
 * l'événement — `AsyncLocalStorage` ne survit pas à une file ni à un
 * redémarrage. Sans lui, le consommateur n'aurait aucun établissement à rouvrir,
 * ou pire, en devinerait un.
 */

/** Le nom sous lequel l'événement est publié. */
export const APPOINTMENT_CREATED = 'appointment.created' as const;

/**
 * Un rendez-vous vient d'être posé, au statut `PENDING`.
 *
 * `startsAt` et `endsAt` sont l'intervalle **facturé** — le soin tel que la
 * cliente l'a réservé, tampons exclus. C'est ce qu'un e-mail de confirmation
 * doit annoncer : lui écrire l'heure occupée avancerait son rendez-vous du temps
 * de préparation de la cabine.
 */
export interface AppointmentCreatedEvent {
  readonly name: typeof APPOINTMENT_CREATED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly clientId: string;
  readonly staffId: string;
  readonly serviceId: string;
  /** Début du soin, ISO 8601 UTC. */
  readonly startsAt: string;
  /** Fin du soin, ISO 8601 UTC. */
  readonly endsAt: string;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
