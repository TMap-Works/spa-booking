import { DomainError } from '../../common/errors';

/**
 * Erreurs du point d'entrée des webhooks Stripe.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en
 * `{ code, message, details }`.
 *
 * **Aucune ne cite Stripe ni la cause exacte du refus.** Le seul appelant
 * légitime de cette route est Stripe lui-même, qui n'a que faire du détail ; le
 * seul autre appelant possible est quelqu'un qui sonde, et lui apprendre si
 * c'est l'en-tête, l'horodatage ou le condensat qui a échoué lui donnerait le
 * fil à tirer. Le détail part au journal, où il sert au diagnostic d'une
 * intégration qui ne prend pas.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared` quand `apps/api` en dépendra, comme ceux d'`identity`, de
 * `catalog` et d'`appointments`.
 */

export const WEBHOOK_ERROR_CODES = {
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  WEBHOOK_PAYLOAD_TOO_LARGE: 'WEBHOOK_PAYLOAD_TOO_LARGE',
} as const;

/**
 * 400 — absent de `DOMAIN_HTTP_STATUS`, qui ne décrit que les refus métier :
 * une requête bien formée dont la règle refuse le contenu. Ici la requête
 * elle-même n'est pas recevable, ce qui est la définition du 400.
 */
const BAD_REQUEST = 400;

/** 413 — la borne du lecteur de corps brut, hors du parseur global et de sa limite. */
const PAYLOAD_TOO_LARGE = 413;

/** 503 — absent pour la même raison : `DOMAIN_HTTP_STATUS` ne connaît pas les dépendances externes. */
const SERVICE_UNAVAILABLE = 503;

/**
 * Le corps dépasse la borne du lecteur brut.
 *
 * En sortant du parseur JSON global, la route sort de sa limite par défaut
 * (100 Kio) : cette erreur est ce qui la remplace. Elle est levée **avant**
 * toute vérification de signature — accumuler des octets non authentifiés est
 * précisément ce qu'il ne faut pas faire sur le seul point d'entrée public non
 * gardé de l'API.
 */
export class WebhookPayloadTooLargeError extends DomainError {
  public override readonly code = WEBHOOK_ERROR_CODES.WEBHOOK_PAYLOAD_TOO_LARGE;
  public override readonly status = PAYLOAD_TOO_LARGE;

  public constructor() {
    super('Corps de webhook trop volumineux.');
  }
}

/**
 * Le corps reçu n'est pas signé par Stripe, ou ne l'est plus.
 *
 * **400 immédiat, aucun traitement** (payments-stripe §3). C'est la propriété
 * la plus importante de cette route : elle est ouverte sur l'internet, sans
 * jeton, et la signature est la seule chose qui distingue Stripe de n'importe
 * qui. Un corps non vérifié ne doit donc franchir aucune ligne de code métier —
 * ni être désérialisé en événement, ni être journalisé, ni toucher la base.
 *
 * **400 et non 401** : un 401 invite à réessayer avec d'autres informations
 * d'authentification, et Stripe n'en a pas d'autres à présenter. Un 400 dit ce
 * qui est vrai — cette livraison-là est irrecevable — et Stripe la marquera en
 * échec dans son tableau de bord, ce qui est exactement le signal attendu.
 */
export class InvalidWebhookSignatureError extends DomainError {
  public override readonly code = WEBHOOK_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE;
  public override readonly status = BAD_REQUEST;

  public constructor() {
    super('Signature de webhook invalide.');
  }
}

/**
 * Le secret de terminaison n'est pas configuré sur ce déploiement.
 *
 * **503 et non 400** : le corps est peut-être parfaitement valide, c'est nous
 * qui ne savons pas le vérifier. Le distinguer a une conséquence pratique —
 * Stripe **rejoue** les 5xx, et rejouera donc les livraisons reçues pendant la
 * fenêtre de mauvaise configuration une fois le secret posé. Un 400 les aurait
 * perdues définitivement.
 *
 * Ce cas ne peut se produire qu'en `development` et en `test` : en déployé,
 * `StripeWebhookConfig` refuse de démarrer sans secret plutôt que de servir une
 * route qui ne vérifie rien (api-module §7).
 */
export class WebhookNotConfiguredError extends DomainError {
  public override readonly code = WEBHOOK_ERROR_CODES.WEBHOOK_NOT_CONFIGURED;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super('La réception des webhooks de paiement n’est pas configurée.');
  }
}
