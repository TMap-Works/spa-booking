/**
 * L'événement de domaine `appointment.rescheduled` — le cinquième critère de
 * #39.
 *
 * ## Pourquoi un second nom d'événement plutôt qu'un `appointment.created`
 *
 * Un report **est** une création — c'est même toute sa définition — et il serait
 * tentant de le publier comme telle. Ce serait faire perdre à l'aval la seule
 * information qui change sa conduite : la cliente a déjà été prévenue une fois.
 *
 * `notifications` (S4) n'envoie pas la même chose dans les deux cas. Une
 * création demande une confirmation ; un report demande un avis de déplacement,
 * qui rappelle l'ancienne heure — et il demande surtout d'**annuler le rappel
 * J-1 déjà planifié** sur l'ancien créneau, faute de quoi la cliente reçoit un
 * SMS la veille d'un rendez-vous qui n'existe plus. Cette annulation-là ne se
 * déduit pas d'un `appointment.created` : il faut l'identifiant du rendez-vous
 * remplacé, que seul cet événement porte.
 *
 * Publier les deux — une création *et* un report — serait pire : l'aval devrait
 * dédupliquer, et une chaîne asynchrone qui reçoit les deux dans le désordre
 * enverrait la confirmation après l'avis de déplacement.
 *
 * ## Ce que la charge utile porte, et ce qu'elle ne porte pas
 *
 * Des **identifiants** et des instants, jamais des coordonnées : ni l'adresse
 * e-mail, ni le numéro de la cliente, ni son nom. Même discipline que
 * `appointment-created.event.ts` — un événement circule, se journalise et se
 * rejoue, et ce qu'il ne contient pas ne peut pas fuiter par ces trois chemins.
 *
 * `tenantId` y est, pour la même raison qu'ailleurs : un abonné asynchrone
 * s'exécute hors de la portée de tenant de la requête qui a produit
 * l'événement.
 */

/** Le nom sous lequel l'événement est publié. */
export const APPOINTMENT_RESCHEDULED = 'appointment.rescheduled' as const;

/**
 * Un rendez-vous vient d'être déplacé : l'ancien est `CANCELLED`, le nouveau
 * porte son identifiant dans `rescheduled_from_id`.
 *
 * Tous les instants sont l'intervalle **facturé** — le soin tel que la cliente
 * le lit, tampons exclus. C'est ce qu'un avis de déplacement doit annoncer, des
 * deux côtés : lui écrire les heures occupées avancerait ses deux rendez-vous du
 * temps de préparation de la cabine.
 */
export interface AppointmentRescheduledEvent {
  readonly name: typeof APPOINTMENT_RESCHEDULED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  /** Le rendez-vous **créé** — celui qui vaut désormais. */
  readonly appointmentId: string;
  /** Le rendez-vous remplacé, désormais `CANCELLED`. */
  readonly previousAppointmentId: string;
  readonly clientId: string;
  readonly serviceId: string;
  /** Praticien du nouveau rendez-vous — pas forcément celui d'avant. */
  readonly staffId: string;
  /** Praticien du rendez-vous remplacé. */
  readonly previousStaffId: string;
  /** Début du soin, ISO 8601 UTC. */
  readonly startsAt: string;
  /** Fin du soin, ISO 8601 UTC. */
  readonly endsAt: string;
  /** Début du soin **remplacé**, ISO 8601 UTC — ce que l'avis doit rappeler. */
  readonly previousStartsAt: string;
  /** Fin du soin **remplacé**, ISO 8601 UTC. */
  readonly previousEndsAt: string;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
