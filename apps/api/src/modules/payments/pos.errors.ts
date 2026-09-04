import { DOMAIN_HTTP_STATUS, DomainError } from '../../common/errors';

/**
 * Erreurs du POS (#60).
 *
 * Même régime que `payments.errors.ts` : un service ne lève jamais
 * d'`HttpException` (api-module §5), et le front réagit sur `code`, jamais sur
 * `message`.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement.** Une prestation,
 * un article ou un rendez-vous du salon voisin est *introuvable*, point : c'est
 * `NotFoundError` du tronc commun qui répond, en 404. Un code dédié — ou un 403
 * — confirmerait son existence (tenant-isolation §4).
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, comme ceux des modules voisins.
 */

/** Codes d'erreur du POS, tels qu'ils partent au client. */
export const POS_ERROR_CODES = {
  PRODUCT_SKU_TAKEN: 'PRODUCT_SKU_TAKEN',
  SALE_ITEM_UNAVAILABLE: 'SALE_ITEM_UNAVAILABLE',
  SALE_CURRENCY_MISMATCH: 'SALE_CURRENCY_MISMATCH',
  SALE_AMOUNT_OUT_OF_RANGE: 'SALE_AMOUNT_OUT_OF_RANGE',
} as const;

const CONFLICT = DOMAIN_HTTP_STATUS.CONFLICT;
const UNPROCESSABLE_ENTITY = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

/**
 * Ce code d'article est déjà pris dans cet établissement.
 *
 * **409 et non 400** : le corps est valide, c'est l'état du rayon qui s'y
 * oppose. L'unicité est portée par `@@unique([tenantId, sku])`, donc par la
 * base — deux salons gardent le droit de coder chacun son `SH-01`.
 *
 * `details` ne porte **pas** le code en cause. Il n'apprendrait rien à
 * l'appelant, qui vient de l'envoyer, et un corps de conflit qui recopie la
 * valeur rend le refus distinguable d'un autre — de quoi sonder, code par code,
 * le rayon d'un salon dont on connaîtrait un jeton.
 */
export class ProductSkuTakenError extends DomainError {
  public override readonly code = POS_ERROR_CODES.PRODUCT_SKU_TAKEN;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Ce code article est déjà utilisé dans cet établissement.');
  }
}

/**
 * Un article du ticket existe mais n'est plus vendable — prestation ou produit
 * retiré du catalogue.
 *
 * **422 et non 404** : l'appelant a le droit de savoir que la référence existe,
 * puisqu'il vient de la lire dans une liste de son propre établissement. Ce qui
 * ne va pas n'est pas l'identifiant, c'est l'état de l'article — et l'écran de
 * caisse a une conduite à tenir, celle de retirer la ligne.
 *
 * `details.position` désigne **le rang de la ligne** sur le ticket, jamais
 * l'identifiant de l'article : c'est ce dont l'écran a besoin pour surligner la
 * ligne fautive, et cela ne dit rien de plus que ce que l'appelant a envoyé.
 */
export class SaleItemUnavailableError extends DomainError {
  public override readonly code = POS_ERROR_CODES.SALE_ITEM_UNAVAILABLE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(position: number) {
    super('Cet article n’est plus vendable.', { position });
  }
}

/**
 * Un article du ticket est libellé dans une autre devise que celle de
 * l'établissement.
 *
 * Le serveur **refuse** plutôt que de convertir. Une conversion sans taux daté
 * n'est pas une conversion, c'est une approximation — et elle se figerait dans
 * une pièce comptable que le rapprochement relira des mois plus tard.
 *
 * Le cas est rare et signale presque toujours une donnée de catalogue à
 * corriger : un article importé avec la devise d'un autre établissement, ou un
 * salon dont la devise par défaut a changé après coup.
 */
export class SaleCurrencyMismatchError extends DomainError {
  public override readonly code = POS_ERROR_CODES.SALE_CURRENCY_MISMATCH;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(position: number) {
    super('Cet article n’est pas libellé dans la devise de l’établissement.', { position });
  }
}

/**
 * Le ticket dépasse ce qu'un montant du schéma peut porter.
 *
 * Les colonnes de montant sont des entiers 32 bits signés — le choix du schéma,
 * et il tient pour tout ticket réel. Un total qui les dépasse ne se tronque pas
 * en silence : PostgreSQL refuserait l'écriture par une erreur de type, remontée
 * en 500 là où le contrat annonce autre chose. La borne est donc vérifiée par le
 * service, **avant** l'écriture, pour que le refus soit celui que le front sait
 * lire.
 *
 * Ce n'est pas une précaution théorique : cent lignes de mille unités à un prix
 * quelconque y suffisent, et rien dans le corps de la requête ne coûte cher à
 * fabriquer.
 */
export class SaleAmountOutOfRangeError extends DomainError {
  public override readonly code = POS_ERROR_CODES.SALE_AMOUNT_OUT_OF_RANGE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor() {
    super('Le total de ce ticket dépasse le montant maximal admis.');
  }
}
