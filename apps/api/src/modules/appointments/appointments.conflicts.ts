import { Prisma } from '@prisma/client';

/**
 * Reconnaissance du refus de la contrainte d'exclusion anti-double-réservation.
 *
 * C'est la charnière entre la garantie de la base et le contrat de l'API : sans
 * elle, la perdante d'une course reçoit un 500 au lieu du 409 que le contrat
 * annonce (booking-engine §1, api-module §5).
 *
 * ## Pourquoi lire le message, et non un code d'erreur
 *
 * Prisma ne modélise pas la violation d'exclusion. Vérifié contre PostgreSQL 16
 * et `@prisma/client` 6.12 : l'erreur remonte en
 * `PrismaClientUnknownRequestError`, avec `code` et `meta` **indéfinis**, et le
 * SQLSTATE `23P01` comme le nom de la contrainte ne vivent que dans le texte du
 * message. Il n'y a donc rien d'autre à lire — ce n'est pas un raccourci, c'est
 * la seule information que le client expose.
 *
 * ## Pourquoi le nom de la contrainte, et non le SQLSTATE
 *
 * `23P01` dit « une contrainte d'exclusion a refusé cette ligne », pas
 * « ce créneau est pris ». Le jour où le schéma en portera une seconde — une
 * plage bloquée du personnel, un congé —, un test sur le seul SQLSTATE
 * traduirait n'importe laquelle en `SlotNoLongerAvailableError`, et le client
 * lirait « choisissez un autre créneau » sur un refus qui n'a rien à voir. Le
 * nom est ce qui identifie **notre** invariant.
 *
 * ## Ce qui n'est pas fait ici, délibérément
 *
 * Le message de PostgreSQL est **jeté**, jamais propagé. Il détaille la ligne en
 * conflit — `Key (tenant_id, staff_id, time_range)=(…) conflicts with existing
 * key (…)` —, c'est-à-dire l'identifiant de l'établissement, celui du praticien
 * et les bornes exactes d'un rendez-vous **qui n'appartient pas à l'appelant**.
 * Le remonter ferait de la réservation une sonde d'agenda. `DomainExceptionFilter`
 * n'a pas à s'en protéger : ce qu'il reçoit est une erreur de domaine construite
 * ici, dont `details` ne porte que ce que l'appelant a lui-même envoyé.
 */

/**
 * Le nom de la contrainte, tel que la migration
 * `20260827120000_add_appointment_exclusion` la déclare.
 *
 * Ce n'est pas une chaîne libre : c'est un couplage assumé entre ce fichier et
 * le SQL, et `__tests__/appointments.conflicts.spec.ts` relit la migration pour
 * vérifier qu'ils portent bien le même nom. Un renommage côté SQL sans son
 * pendant ici ferait retomber toutes les collisions de créneau en 500 — un
 * défaut silencieux qu'aucune suite fonctionnelle ne rattraperait, puisque le
 * cas nominal, lui, continuerait de passer.
 */
export const SLOT_EXCLUSION_CONSTRAINT = 'appointments_no_overlap';

/**
 * SQLSTATE des échecs **transitoires** d'écriture concurrente.
 *
 * - `40P01` *deadlock_detected* — le cas réellement observé, et il n'a rien
 *   d'exotique : quand plusieurs réservations concurrentes visent des
 *   intervalles **décalés mais mutuellement chevauchants** (ce que produit
 *   n'importe quelle grille de créneaux au quart d'heure pour un soin d'une
 *   heure), chaque insertion attend la transaction qui détient l'entrée d'index
 *   en conflit. Le cycle d'attente est un interblocage, et PostgreSQL en abat
 *   une victime — laquelle reçoit `40P01`, jamais `23P01`. Mesuré sur ce
 *   schéma : huit réservations décalées d'une minute produisent un succès et
 *   **sept victimes d'interblocage**.
 * - `40001` *serialization_failure* — impossible sous `READ COMMITTED`, mais un
 *   niveau d'isolation plus strict le rendrait possible, et le traitement est le
 *   même.
 *
 * Ce ne sont **pas** des conflits de créneau : la victime n'a rien appris de
 * l'agenda, elle a seulement perdu une course d'ordonnancement. La traduire en
 * `SlotNoLongerAvailableError` mentirait au client — le créneau peut être libre
 * — et lui ferait perdre une réservation. La conduite correcte est celle que
 * documente PostgreSQL : réessayer.
 */
const TRANSIENT_SQLSTATES: readonly string[] = ['40P01', '40001'];

/**
 * Code Prisma de l'écriture concurrente, pour le jour où le connecteur classera
 * `40P01` comme il classe déjà `40001`.
 */
const WRITE_CONFLICT_CODE = 'P2034';

/** Les valeurs de `meta` que Prisma remplirait s'il venait à mapper `23P01`. */
function metaMentionsConstraint(meta: Record<string, unknown> | undefined): boolean {
  if (meta === undefined) {
    return false;
  }

  return Object.values(meta).some((value) => {
    if (typeof value === 'string') {
      return value.includes(SLOT_EXCLUSION_CONSTRAINT);
    }
    return (
      Array.isArray(value) &&
      value.some((item) => typeof item === 'string' && item.includes(SLOT_EXCLUSION_CONSTRAINT))
    );
  });
}

/**
 * `true` si l'erreur est le refus de `appointments_no_overlap` par PostgreSQL.
 *
 * Tolérant sur la **forme** de l'erreur — n'importe quelle `Error` est
 * inspectée, ce qui couvre `PrismaClientUnknownRequestError` aujourd'hui et un
 * éventuel `PrismaClientKnownRequestError` demain — et strict sur son
 * **contenu** : le nom de la contrainte doit y figurer.
 */
export function isSlotExclusionViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && metaMentionsConstraint(error.meta)) {
    return true;
  }

  return error.message.includes(SLOT_EXCLUSION_CONSTRAINT);
}

/**
 * `true` si l'erreur est un échec **transitoire** d'écriture concurrente —
 * interblocage ou échec de sérialisation — que réessayer résout.
 *
 * Distinct de `isSlotExclusionViolation` et incompatible avec elle : l'une dit
 * « ce créneau est pris, définitivement », l'autre « recommence ». Les confondre
 * dans un sens perd des réservations sur des créneaux libres ; dans l'autre,
 * fait réessayer indéfiniment sur un créneau pris.
 *
 * Le SQLSTATE est ici un critère suffisant, là où il ne l'était pas pour
 * l'exclusion : `40P01` ne désigne aucun invariant métier particulier, il
 * décrit l'ordonnancement. Toute écriture qui en est victime se réessaie, quelle
 * que soit la table.
 */
export function isTransientWriteConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === WRITE_CONFLICT_CODE
  ) {
    return true;
  }

  // Même relevé que pour l'exclusion : le SQLSTATE ne vit que dans le texte du
  // message, sous la forme `code: "40P01"` que rend le connecteur.
  return TRANSIENT_SQLSTATES.some((sqlstate) => error.message.includes(`code: "${sqlstate}"`));
}
