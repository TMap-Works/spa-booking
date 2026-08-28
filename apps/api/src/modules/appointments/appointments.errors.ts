import { DOMAIN_HTTP_STATUS, DomainError } from '../../common/errors';

/**
 * Erreurs du module `appointments`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en réponse
 * `{ code, message, details }`. Le front réagit sur `code`, jamais sur
 * `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront venir de
 * `@spa/shared`, où `BOOKING_ERROR_CODES.SLOT_NO_LONGER_AVAILABLE` porte déjà la
 * **même valeur**. Les déclarer ici suit le précédent des modules voisins —
 * `apps/api` ne dépend pas encore du paquet partagé, et l'y ajouter touche
 * `apps/api/package.json`, hors de l'empreinte de ce ticket. L'import se
 * substituera à cette constante sans changer un seul caractère.
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const APPOINTMENTS_ERROR_CODES = {
  SLOT_NO_LONGER_AVAILABLE: 'SLOT_NO_LONGER_AVAILABLE',
} as const;

/**
 * 409 et non 422 : la requête est parfaitement valide, c'est **l'état du monde**
 * qui a changé entre l'affichage des créneaux et la validation.
 *
 * La valeur vient de `DOMAIN_HTTP_STATUS`, la table de correspondance
 * d'api-module §5, et non d'un `409` recopié : deux tables de statuts qui
 * dérivent, c'est un module qui répond autre chose que ce que le contrat annonce.
 */
const CONFLICT = DOMAIN_HTTP_STATUS.CONFLICT;

/**
 * Le créneau a été pris entre l'affichage et la validation.
 *
 * ## Ce que cette erreur signifie exactement
 *
 * Elle n'est **jamais** levée sur la foi d'une lecture préalable. Elle traduit
 * le refus de `appointments_no_overlap` par PostgreSQL — c'est-à-dire le seul
 * arbitre qui ne puisse pas se tromper sous concurrence (ADR 0002,
 * booking-engine §1). Une vérification applicative « ce créneau est-il libre ? »
 * suivie d'un `INSERT` laisserait passer deux réservations simultanées ; la
 * contrainte, elle, en refuse une des deux, quelle que soit l'origine de
 * l'écriture.
 *
 * ## Pourquoi 409, et pourquoi cela compte
 *
 * Sans cette traduction, la perdante d'une course reçoit un **500** : un défaut
 * de programmation, du point de vue de l'appelant, là où il s'agit du
 * fonctionnement normal d'un agenda partagé. Le front ne peut alors rien faire
 * de mieux que d'afficher une erreur générique, quand un 409 lui dit exactement
 * quoi faire — réafficher les créneaux et inviter à en choisir un autre.
 *
 * ## Ce que `details` porte, et ce qu'il ne porte pas
 *
 * `staffId` et `startsAt` sont **ce que l'appelant vient d'envoyer** : les lui
 * rendre ne lui apprend rien qu'il ne sache, et lui évite de deviner lequel de
 * ses choix a fauté quand il en a soumis plusieurs.
 *
 * `staffId` vaut donc `null` quand la cliente n'a désigné personne — l'option
 * « premier disponible » de #36. Y écrire le dernier praticien tenté par
 * l'affectation apprendrait à un appelant anonyme l'identifiant d'un praticien
 * qu'il n'a jamais nommé, et ferait de ce 409 une sonde d'agenda : c'est
 * exactement ce que le paragraphe suivant interdit.
 *
 * Rien du rendez-vous **concurrent** n'est rendu — ni son identifiant, ni son
 * client, ni ses bornes exactes. Le message d'erreur de PostgreSQL les contient
 * pourtant (`Key (tenant_id, staff_id, time_range)=(…) conflicts with existing
 * key (…)`), et les recopier ferait de cet endpoint une sonde d'agenda : qui
 * peut réserver pourrait cartographier les rendez-vous d'un praticien en tirant
 * sur tous les créneaux. C'est précisément pour cela que le message d'origine
 * n'est jamais propagé — voir `appointments.conflicts.ts`.
 */
export class SlotNoLongerAvailableError extends DomainError {
  public override readonly code = APPOINTMENTS_ERROR_CODES.SLOT_NO_LONGER_AVAILABLE;
  public override readonly status = CONFLICT;

  public constructor(staffId: string | null, startsAt: Date) {
    super('Ce créneau vient d’être réservé. Choisissez-en un autre.', {
      staffId,
      // ISO 8601 avec offset explicite — le contrat n'emporte jamais une date
      // en heure murale, et un `Date` sérialisé en JSON le serait de toute façon.
      startsAt: startsAt.toISOString(),
    });
  }
}
