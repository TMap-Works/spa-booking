import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `crm`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, comme ceux d'`identity` et de `catalog`. Les déclarer ici suit
 * le précédent des modules voisins — `apps/api` ne dépend pas encore du paquet
 * partagé — et l'import se substituera à ces constantes sans changer une valeur.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement**, et aucune ne
 * recopie une donnée personnelle. Une fiche d'un autre tenant est introuvable,
 * point : c'est `NotFoundError` du tronc commun qui répond, en 404. Un code
 * dédié — ou un 403 — confirmerait son existence (tenant-isolation §4).
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const CRM_ERROR_CODES = {
  CUSTOMER_EMAIL_TAKEN: 'CUSTOMER_EMAIL_TAKEN',
} as const;

const CONFLICT = 409;

/**
 * Une fiche de cet établissement porte déjà cette adresse.
 *
 * Traduit la violation de `@@unique([tenantId, email])`. Le conflit vient de la
 * base et non d'un contrôle préalable : deux saisies concurrentes au comptoir
 * passeraient toutes les deux le contrôle, et la perdante recevrait un 500.
 *
 * **`details` ne porte pas l'adresse**, contrairement au `slug` des conflits du
 * catalogue. Un slug de prestation est une donnée de catalogue ; une adresse
 * e-mail est une donnée personnelle (CDC §5.1), et le corps d'erreur est
 * précisément l'endroit d'où elle repart vers un journal d'accès, un outil de
 * supervision ou une capture d'écran de ticket. Celui qui vient de la saisir la
 * connaît déjà et n'a pas besoin qu'on la lui renvoie.
 *
 * Ce que ce 409 apprend, et qu'il faut assumer : il dit qu'une fiche existe déjà
 * sous cette adresse **dans cet établissement**. C'est une information que
 * l'appelant — un membre du personnel du salon, authentifié — obtiendrait de
 * toute façon en cherchant l'adresse dans son propre fichier client. Elle ne
 * traverse aucune frontière de tenant.
 */
export class CustomerEmailTakenError extends DomainError {
  public override readonly code = CRM_ERROR_CODES.CUSTOMER_EMAIL_TAKEN;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Une fiche de cet établissement porte déjà cette adresse e-mail.');
  }
}
