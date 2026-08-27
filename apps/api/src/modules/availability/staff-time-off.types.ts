/**
 * Formes de données des plages bloquées et congés — CDC §2.3 « plages
 * bloquées », #33.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/availability.ts` (`staffTimeOffSchema`,
 * `staffBusyIntervalSchema`, tenus à jour par ce même ticket) ; elles devront en
 * être importées le jour où `apps/api` dépendra du paquet. Même TODO que dans
 * `catalog.types.ts` et `identity.types.ts`.
 *
 * ## Aucune de ces formes ne porte de `tenantId`
 *
 * Ni en entrée — le tenant vient du contexte d'authentification et de nulle part
 * ailleurs (tenant-isolation §2) —, ni en sortie, où il n'apprendrait rien au
 * consommateur et inviterait aux essais (§4).
 */

import type { UtcRange } from './availability.time';

/**
 * Une indisponibilité telle que le back-office la lit.
 *
 * Les instants sortent en **chaînes ISO 8601 suffixées `Z`** et non en `Date` :
 * c'est le format de sortie du contrat, et le fixer ici plutôt qu'à la
 * sérialisation évite qu'un jour un `JSON.stringify` local ou un intercepteur ne
 * rende autre chose. Deux horodatages du même référentiel se comparent alors par
 * simple ordre lexicographique, jusque dans les assertions de test.
 */
export interface StaffTimeOffView {
  readonly id: string;
  readonly staffId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Motif interne — voir `StaffBusyRange` pour ce qui n'y a pas droit. */
  readonly reason: string | null;
}

/**
 * Une indisponibilité telle que le **calcul de créneaux** la consomme (#34).
 *
 * Deux différences avec `StaffTimeOffView`, et les deux comptent :
 *
 * 1. **Pas de `reason`.** Le motif d'une absence est une donnée de gestion du
 *    personnel : il regarde le back-office, jamais la page de réservation
 *    publique où le créneau manquant se manifeste. Ne pas le charger est plus
 *    sûr que se promettre de ne pas l'exposer — ce qui n'est pas lu ne peut pas
 *    fuiter. Ni `id` non plus : on soustrait des intervalles, on ne désigne
 *    aucune ligne.
 * 2. **Des `Date`, pas des chaînes.** La forme étend `UtcRange`, ce qui la rend
 *    directement consommable par `subtractRanges` sans réanalyse — et interdit
 *    au passage qu'une conversion de format se glisse entre la base et le
 *    calcul.
 */
export interface StaffBusyRange extends UtcRange {
  readonly staffId: string;
}

/** Fenêtre d'interrogation du planning d'absences — bornes en instants UTC. */
export interface TimeOffWindow {
  readonly from: Date;
  readonly to: Date;
}

/** Champs modifiables d'une absence. `staffId` n'en est pas : voir le DTO. */
export interface StaffTimeOffPatch {
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly reason?: string | null;
}
