/**
 * Vocabulaire du cycle de vie du rendez-vous — CDC §2.4, booking-engine §5.
 *
 * ```
 *                  ┌──────────► CANCELLED
 *                  │
 * PENDING ──► CONFIRMED ──► COMPLETED
 *    │              │
 *    │              └──────────► NO_SHOW
 *    └──► CANCELLED
 * ```
 *
 * Les règles de transition ne vivent pas ici : elles appartiennent au service
 * qui les fait respecter — `AppointmentLifecycleService`, posé par #40. Ce
 * fichier ne porte qu'un vocabulaire et **la liste des statuts qui occupent
 * l'agenda** — la seule notion dont la contrainte d'exclusion de #31 a besoin.
 *
 * ## Pourquoi une liste locale plutôt que l'énumération générée par Prisma
 *
 * Même raison que `identity/roles.ts` : ce module est lu par des couches qui ne
 * doivent pas dépendre du client généré (api-module §2 réserve cet import au
 * repository), et une machine sans `prisma generate` verrait sinon échouer des
 * suites qui ne parlent pas du schéma. Le **témoin** est dans la suite de test —
 * `__tests__/appointment-status.spec.ts` compare cette liste à l'énumération
 * réellement générée, et compare `OCCUPYING_STATUSES` au filtre partiel écrit
 * dans la migration. Une divergence y rougit avant qu'une réservation ne la
 * découvre en production.
 */

/** Les cinq statuts, dans l'ordre de déclaration de `enum AppointmentStatus`. */
export const APPOINTMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/**
 * Les statuts qui **occupent** le créneau du praticien, et eux seuls.
 *
 * C'est le filtre partiel de `appointments_no_overlap` : hors de cette liste, un
 * rendez-vous ne bloque plus rien. Un rendez-vous annulé ou marqué no-show
 * libère donc son créneau (booking-engine §5) — c'est un critère d'acceptation
 * de #31, pas un effet de bord.
 *
 * `COMPLETED` n'y figure pas : le soin est passé, et rien ne justifie qu'un
 * intervalle historique interdise une écriture future.
 *
 * **Cette liste et la clause `WHERE` de la migration sont la même chose.** Les
 * faire diverger produirait le plus mauvais des mondes : un code qui croit un
 * créneau libre là où la base le refuse, ou l'inverse. Le témoin de
 * `__tests__/appointment-status.spec.ts` relit le SQL pour l'interdire.
 */
export const OCCUPYING_STATUSES = [
  'PENDING',
  'CONFIRMED',
] as const satisfies readonly AppointmentStatus[];

export type OccupyingStatus = (typeof OCCUPYING_STATUSES)[number];

/**
 * Les deux **issues** d'un rendez-vous : ce qui s'est passé quand l'heure est
 * venue (booking-engine §5 — `completed` « honoré, encaissé », `no_show`
 * « client absent »).
 *
 * Ce ne sont pas des statuts comme les autres, et c'est ce que cette liste
 * nomme : les trois premiers décrivent un rendez-vous **à venir** — pris, confirmé,
 * annulé —, ces deux-ci **constatent** le passé. Un constat ne s'écrit pas avant
 * le fait : c'est la règle que `AppointmentLifecycleService` fait respecter, et
 * elle a besoin d'une liste plutôt que de deux littéraux répétés d'un fichier à
 * l'autre (#1137).
 *
 * `CANCELLED` n'en fait pas partie, quoiqu'il soit terminal lui aussi : annuler
 * est une **décision**, et elle se prend précisément *avant* l'heure du soin.
 *
 * C'est aussi l'ensemble qu'annonce `appointment.status_changed`, dont
 * `AppointmentOutcomeStatus` est désormais l'alias : l'`Extract<>` qui le
 * dérivait était une seconde écriture de cette même liste.
 */
export const OUTCOME_STATUSES = [
  'COMPLETED',
  'NO_SHOW',
] as const satisfies readonly AppointmentStatus[];

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** `true` si la valeur est l'un des statuts connus — à utiliser avant tout transtypage. */
export function isAppointmentStatus(value: unknown): value is AppointmentStatus {
  return typeof value === 'string' && (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

/** `true` si un rendez-vous dans ce statut occupe encore le créneau du praticien. */
export function occupiesSlot(status: AppointmentStatus): status is OccupyingStatus {
  return (OCCUPYING_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/**
 * `true` si ce statut **constate** ce qui s'est passé pendant le rendez-vous —
 * honoré ou non présenté (#1137).
 *
 * Le seul prédicat par lequel la règle de cycle de vie et l'événement de domaine
 * reconnaissent ces deux statuts : les comparer à deux littéraux sur place, comme
 * le faisait `changeStatus`, laissait un troisième site d'écriture se périmer.
 */
export function recordsOutcome(status: AppointmentStatus): status is OutcomeStatus {
  return (OUTCOME_STATUSES as readonly AppointmentStatus[]).includes(status);
}

/**
 * De quel côté du comptoir vient la décision d'annuler — #40, booking-engine §5.
 *
 * Dans l'ordre de déclaration de `enum AppointmentCancelledBy`, et déclaré ici
 * plutôt qu'importé de Prisma pour la raison qui vaut au-dessus : les couches
 * qui lisent ce vocabulaire — DTO, contrôleurs, événements de domaine — ne
 * doivent pas dépendre du client généré (api-module §2). Le témoin est dans
 * `__tests__/appointment-status.spec.ts`.
 *
 * Ce n'est pas un rôle : un `MANAGER` qui annule est du côté du salon, comme un
 * `STAFF`, et `SYSTEM` n'est le rôle de personne.
 */
export const CANCELLATION_AUTHORS = ['CLIENT', 'STAFF', 'SYSTEM'] as const;

export type AppointmentCancelledBy = (typeof CANCELLATION_AUTHORS)[number];
