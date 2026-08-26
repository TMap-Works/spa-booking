import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `catalog`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, comme ceux d'`identity`. Les déclarer ici suit le précédent du
 * module voisin — `apps/api` ne dépend pas encore du paquet partagé — et
 * l'import se substituera à ces constantes sans changer une seule valeur.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement.** Une prestation ou
 * une catégorie d'un autre tenant est introuvable, point : c'est `NotFoundError`
 * du tronc commun qui répond, en 404. Un code dédié — ou un 403 — confirmerait
 * son existence (tenant-isolation §4).
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const CATALOG_ERROR_CODES = {
  SERVICE_SLUG_TAKEN: 'SERVICE_SLUG_TAKEN',
  SERVICE_CATEGORY_SLUG_TAKEN: 'SERVICE_CATEGORY_SLUG_TAKEN',
  SERVICE_STAFF_ALREADY_ASSIGNED: 'SERVICE_STAFF_ALREADY_ASSIGNED',
} as const;

const CONFLICT = 409;

/**
 * Slug de prestation déjà pris **dans cet établissement**.
 *
 * L'unicité est par tenant : deux salons ont chacun droit à leur
 * `massage-60-min`, et l'un ne doit rien pouvoir déduire de l'autre. Ce conflit
 * ne dit donc rien de plus que « ici, ce slug est pris » — ce que la personne
 * qui administre le catalogue voit déjà dans sa propre liste.
 *
 * `details.slug` est renseigné parce que le slug est **ce que l'appelant vient
 * d'envoyer** ou ce que le serveur en a dérivé : le lui rendre ne lui apprend
 * rien qu'il ne sache, et lui évite de deviner lequel des deux a fauté quand il
 * ne l'a pas fourni lui-même.
 */
export class ServiceSlugTakenError extends DomainError {
  public override readonly code = CATALOG_ERROR_CODES.SERVICE_SLUG_TAKEN;
  public override readonly status = CONFLICT;

  public constructor(slug: string) {
    super('Une prestation de cet établissement porte déjà ce slug.', { slug });
  }
}

/** Slug de catégorie déjà pris dans cet établissement — même raisonnement. */
export class ServiceCategorySlugTakenError extends DomainError {
  public override readonly code = CATALOG_ERROR_CODES.SERVICE_CATEGORY_SLUG_TAKEN;
  public override readonly status = CONFLICT;

  public constructor(slug: string) {
    super('Une catégorie de cet établissement porte déjà ce slug.', { slug });
  }
}

/**
 * Ce praticien pratique déjà cette prestation.
 *
 * Traduit l'unicité `(tenant_id, service_id, staff_id)`. Le conflit vient de la
 * base et non d'un contrôle préalable : deux clics concurrents sur la même case
 * passeraient tous les deux le contrôle, et le perdant recevrait un 500.
 *
 * **409 et non 200** : le geste n'est pas idempotent par accident, il est refusé
 * sciemment. Un écran qui reçoit 200 sur une affectation qu'il croyait créer ne
 * peut pas distinguer « c'était déjà fait » de « quelqu'un vient de le faire »,
 * et l'un des deux mérite d'être rafraîchi.
 *
 * Les deux identifiants sont rendus dans `details` parce que ce sont **ceux que
 * l'appelant vient d'envoyer** : ils ne lui apprennent rien, et lui évitent de
 * deviner quelle case de sa liste a fauté.
 */
export class ServiceStaffAlreadyAssignedError extends DomainError {
  public override readonly code = CATALOG_ERROR_CODES.SERVICE_STAFF_ALREADY_ASSIGNED;
  public override readonly status = CONFLICT;

  public constructor(serviceId: string, staffId: string) {
    super('Ce praticien est déjà affecté à cette prestation.', { serviceId, staffId });
  }
}
