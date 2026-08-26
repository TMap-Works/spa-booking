/**
 * Cycle de vie du rendez-vous — booking-engine §5.
 *
 * ```
 *                  ┌──────────► cancelled
 *                  │
 * pending ──► confirmed ──► completed
 *    │              │
 *    │              └──────────► no_show
 *    └──► cancelled
 * ```
 *
 * `cancelled` et `no_show` sont des **statuts**, pas des suppressions : le
 * reporting du CDC §1.4 compte les no-shows, et la contrainte d'exclusion
 * anti-double-réservation ne porte que sur `pending` et `confirmed` — un
 * rendez-vous annulé libère son créneau.
 */

export const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Statuts qui **occupent** le créneau du praticien.
 *
 * Le front s'en sert pour griser un créneau, le back pour le prédicat partiel
 * de la contrainte d'exclusion. Les deux doivent lire la même liste, sans quoi
 * l'agenda affiché et l'agenda réel divergent.
 */
export const BLOCKING_APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
] as const satisfies readonly AppointmentStatus[];

/** Statuts terminaux : plus aucune transition n'en part. */
export const TERMINAL_APPOINTMENT_STATUSES = [
  'completed',
  'cancelled',
  'no_show',
] as const satisfies readonly AppointmentStatus[];

/**
 * Transitions autorisées. Tout ce qui n'y figure pas est refusé par un
 * `INVALID_STATE_TRANSITION` (422) : en particulier le passage direct
 * `pending → completed` et tout retour en arrière depuis `completed`.
 */
export const APPOINTMENT_STATUS_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * Qui est à l'origine d'une annulation — booking-engine §5.
 *
 * `system` couvre l'annulation automatique (paiement jamais confirmé, tâche
 * planifiée). La distinction alimente le reporting : une annulation salon et un
 * no-show client ne se pilotent pas de la même manière.
 */
export const CANCELLATION_ACTORS = ['client', 'staff', 'system'] as const;

export type CancellationActor = (typeof CANCELLATION_ACTORS)[number];

/** `true` si `value` est un statut de rendez-vous connu. */
export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/** `true` si le rendez-vous occupe encore le créneau de son praticien. */
export function isBlockingAppointmentStatus(status: AppointmentStatus): boolean {
  return (BLOCKING_APPOINTMENT_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/**
 * `true` si la transition est autorisée par le cycle de vie.
 *
 * Ce n'est pas une autorisation : le droit de faire la transition relève du
 * rôle de l'appelant, la validité de la transition relève d'ici. Les deux se
 * vérifient, dans cet ordre.
 */
export function canTransitionAppointment(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return APPOINTMENT_STATUS_TRANSITIONS[from].includes(to);
}
