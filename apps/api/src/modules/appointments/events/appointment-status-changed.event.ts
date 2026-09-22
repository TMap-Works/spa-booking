/**
 * L'événement de domaine `appointment.status_changed` — honoré ou non présenté.
 *
 * ## Pourquoi il existe
 *
 * Les quatre autres événements du bus nomment chacun un geste que l'aval traite
 * à part : la réservation, la confirmation, le report, l'annulation. Restaient
 * les deux issues d'un rendez-vous — `COMPLETED` et `NO_SHOW` — que
 * `AppointmentsService.changeStatus` écrivait **sans rien annoncer**, parce
 * qu'aucun abonné n'en avait l'usage : aucun message ne part à la cliente quand
 * elle est venue.
 *
 * Le planning temps réel en a l'usage. Une praticienne qui marque « honoré » sur
 * son téléphone change ce que la gérante voit sur l'écran du comptoir, et ce
 * que la cliente voit dans son espace (« à venir » devient « passé »). Sans
 * événement, ces deux écrans restaient faux jusqu'à leur prochain
 * rafraîchissement manuel.
 *
 * ## Ce qu'il ne couvre pas
 *
 * `CONFIRMED` et `CANCELLED` ont leur événement dédié — `appointment.confirmed`
 * et `appointment.cancelled` — et ne passent **pas** par celui-ci : un abonné
 * qui écouterait les deux recevrait deux fois le même fait.
 *
 * ## Ce que la charge utile porte
 *
 * Des identifiants, un statut, un instant — même discipline que ses voisins.
 */

import type { AppointmentStatus } from '../appointment-status';

/** Le nom sous lequel l'événement est publié. */
export const APPOINTMENT_STATUS_CHANGED = 'appointment.status_changed' as const;

/** Les statuts que cet événement annonce — les deux issues d'un rendez-vous. */
export type AppointmentOutcomeStatus = Extract<AppointmentStatus, 'COMPLETED' | 'NO_SHOW'>;

/** Un rendez-vous vient d'être dit honoré, ou non présenté. */
export interface AppointmentStatusChangedEvent {
  readonly name: typeof APPOINTMENT_STATUS_CHANGED;
  /** L'établissement — sans lui, aucun abonné asynchrone ne sait où regarder. */
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly clientId: string;
  readonly staffId: string;
  /** Le statut **d'arrivée**. */
  readonly status: AppointmentOutcomeStatus;
  /** Instant d'émission, ISO 8601 UTC. */
  readonly occurredAt: string;
}
