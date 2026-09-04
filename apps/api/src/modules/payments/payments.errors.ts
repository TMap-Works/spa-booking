import { DOMAIN_HTTP_STATUS, DomainError } from '../../common/errors';

/**
 * Erreurs du module `payments`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur
 * `code`, jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared`, comme ceux d'`identity`, de `catalog` et d'`appointments`.
 * `apps/api` ne dépend pas encore du paquet partagé ; l'import se substituera à
 * ces constantes sans changer une seule valeur.
 *
 * **Aucune de ces erreurs ne parle d'un autre établissement.** Un rendez-vous
 * d'un autre tenant est introuvable, point : c'est `NotFoundError` du tronc
 * commun qui répond, en 404. Un code dédié — ou un 403 — confirmerait son
 * existence (tenant-isolation §4).
 *
 * **Aucune ne cite Stripe non plus**, et c'est délibéré : un message d'erreur
 * de prestataire cite volontiers un identifiant de compte, une clé tronquée ou
 * la requête fautive. Le détail part au journal ; le corps de réponse ne porte
 * qu'un code stable et une phrase que le tunnel peut afficher.
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const PAYMENT_ERROR_CODES = {
  APPOINTMENT_NOT_PAYABLE: 'APPOINTMENT_NOT_PAYABLE',
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
} as const;

// Les valeurs viennent de `DOMAIN_HTTP_STATUS`, la table de correspondance
// d'api-module §5, et non d'un nombre recopié : deux tables de statuts qui
// dérivent, c'est un module qui répond autre chose que ce que le contrat annonce.
const CONFLICT = DOMAIN_HTTP_STATUS.CONFLICT;
const UNPROCESSABLE_ENTITY = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

/** 503 — absent de `DOMAIN_HTTP_STATUS`, qui ne connaît pas encore les dépendances externes. */
const SERVICE_UNAVAILABLE = 503;

/**
 * Ce rendez-vous n'a plus rien à encaisser en ligne.
 *
 * Le cas courant est le rendez-vous annulé : le créneau est rendu, il n'y a
 * plus de prestation à payer. `COMPLETED` et `NO_SHOW` sont là pour la même
 * raison — l'encaissement d'un soin déjà rendu passe par le comptoir (#60), pas
 * par le tunnel public, et une intention créée après coup rouvrirait un débit
 * sur un dossier clos.
 *
 * **422 et non 404** : le rendez-vous existe et l'appelant en connaît déjà
 * l'identifiant — c'est lui qui vient de l'envoyer. Le lui cacher ne
 * protégerait rien et laisserait son écran sans conduite à tenir.
 *
 * `details.status` est le statut du rendez-vous, jamais une donnée personnelle :
 * c'est ce dont le tunnel a besoin pour choisir entre « ce rendez-vous a été
 * annulé » et « ce rendez-vous est déjà passé ».
 */
export class AppointmentNotPayableError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.APPOINTMENT_NOT_PAYABLE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(status: string) {
    super('Ce rendez-vous n’attend plus de paiement en ligne.', { status });
  }
}

/**
 * Un encaissement existe déjà pour ce rendez-vous, et il n'attend plus rien.
 *
 * Trois situations, un seul code parce que le tunnel n'a qu'une conduite —
 * réafficher le dossier plutôt que redemander une carte :
 *
 * - le paiement est **abouti** (`SUCCEEDED`) ou **remboursé** : rien à
 *   recollecter, et créer une seconde intention débiterait une deuxième fois ;
 * - la vente a été **encaissée au comptoir** en espèces (#62) : il n'y a pas
 *   d'intention Stripe à reprendre, et il ne doit pas y en avoir ;
 * - **Stripe dit « payé » alors que notre ligne dit encore `PENDING`** — un
 *   webhook en retard (#58). C'est la source de vérité qui tranche, pas notre
 *   copie : rendre un formulaire ici ferait ressaisir une carte pour un
 *   rendez-vous déjà réglé.
 *
 * Ce que ce code **ne couvre pas**, et c'est délibéré : une carte refusée
 * (`FAILED`). Une intention Stripe refusée redevient `requires_payment_method`
 * et attend une autre carte ; la traiter comme close rendrait le rendez-vous
 * définitivement impayable, `@@unique([tenantId, appointmentId])` interdisant
 * d'en inscrire une seconde. Un refus de carte est un incident ordinaire, il ne
 * doit pas coûter la vente.
 *
 * `@@unique([tenantId, appointmentId])` sur `payments` est ce qui rend cette
 * situation détectable : un rendez-vous n'a qu'un encaissement, et c'est la
 * base qui le tient — pas la vigilance de ce service.
 */
export class PaymentAlreadySettledError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.PAYMENT_ALREADY_SETTLED;
  public override readonly status = CONFLICT;

  public constructor(status: string) {
    super('Ce rendez-vous a déjà été encaissé.', { status });
  }
}

/**
 * Stripe a refusé l'appel, ou n'a pas répondu.
 *
 * **503 et non 500** : ce n'est pas un défaut de notre code, c'est une
 * dépendance indisponible, et la conduite du front n'est pas la même — un 503
 * se retente, un 500 se signale. Le corps ne porte **aucun** détail du
 * prestataire : ni message Stripe, ni identifiant de requête, ni fragment de
 * clé. Ces éléments-là partent au journal, où ils servent au diagnostic sans
 * traverser le réseau public.
 */
export class PaymentProviderUnavailableError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super('Le prestataire de paiement est momentanément indisponible.');
  }
}
