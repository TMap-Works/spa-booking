import { DOMAIN_HTTP_STATUS, DomainError } from '../../common/errors';

/**
 * Erreurs du module `payments` — **le seul fichier d'erreurs du module** (#410).
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en
 * `{ code, message, details }`. Le front réagit sur `code`, jamais sur `message`.
 *
 * ## Pourquoi un seul fichier, et non trois
 *
 * Le tunnel public (#57), la réception des webhooks (#58) et le POS (#60) ont
 * chacun apporté le leur, parce qu'ils ont été écrits en parallèle sur des
 * branches qui ne se voyaient pas. Trois fichiers pour un module, ce n'était pas
 * une conception : c'était la trace d'un ordre de merge. Le coût était réel et
 * mesurable — `const SERVICE_UNAVAILABLE = 503` était écrit deux fois, et deux
 * tables de statuts qui dérivent, c'est un module qui répond autre chose que ce
 * que son contrat annonce.
 *
 * Le découpage qui vaut pour ce module est celui de la **surface** — un
 * repository par client Prisma, un service par règle métier —, pas celui du
 * catalogue d'erreurs, qui est un contrat unique et se lit d'un seul tenant.
 *
 * ## Ce qu'aucune de ces erreurs ne dit
 *
 * **Aucune ne parle d'un autre établissement.** Un rendez-vous, une prestation
 * ou un article du salon voisin est *introuvable*, point : c'est `NotFoundError`
 * du tronc commun qui répond, en 404. Un code dédié — ou un 403 — confirmerait
 * son existence (tenant-isolation §4).
 *
 * **Aucune ne cite Stripe.** Un message d'erreur de prestataire cite volontiers
 * un identifiant de compte, une clé tronquée ou la requête fautive. Le détail
 * part au journal ; le corps de réponse ne porte qu'un code stable et une phrase
 * que l'écran peut afficher.
 *
 * **Aucune ne porte de donnée de carte** — ni PAN, ni CVC, ni les quatre
 * derniers chiffres. Un `details` d'erreur est journalisé et traverse le réseau
 * public ; c'est exactement l'endroit où la frontière SAQ A se perd
 * (payments-stripe §1).
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared` quand `apps/api` en dépendra, comme ceux d'`identity`, de
 * `catalog` et d'`appointments`.
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const PAYMENT_ERROR_CODES = {
  // Encaissement en ligne et au comptoir (#57, #62, #63).
  APPOINTMENT_NOT_PAYABLE: 'APPOINTMENT_NOT_PAYABLE',
  APPOINTMENT_NOT_SETTLEABLE: 'APPOINTMENT_NOT_SETTLEABLE',
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  HISTORY_WINDOW_INVALID: 'HISTORY_WINDOW_INVALID',
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',

  // Réception des webhooks Stripe (#58).
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  WEBHOOK_PAYLOAD_TOO_LARGE: 'WEBHOOK_PAYLOAD_TOO_LARGE',

  // Rayon retail et ticket de caisse (#60).
  PRODUCT_SKU_TAKEN: 'PRODUCT_SKU_TAKEN',
  SALE_ITEM_UNAVAILABLE: 'SALE_ITEM_UNAVAILABLE',
  SALE_CURRENCY_MISMATCH: 'SALE_CURRENCY_MISMATCH',
  SALE_AMOUNT_OUT_OF_RANGE: 'SALE_AMOUNT_OUT_OF_RANGE',
} as const;

// Les valeurs viennent de `DOMAIN_HTTP_STATUS`, la table de correspondance
// d'api-module §5, et non d'un nombre recopié : deux tables de statuts qui
// dérivent, c'est un module qui répond autre chose que ce que le contrat annonce.
const CONFLICT = DOMAIN_HTTP_STATUS.CONFLICT;
const UNPROCESSABLE_ENTITY = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

/**
 * 400 — absent de `DOMAIN_HTTP_STATUS`, qui ne décrit que les refus métier :
 * une requête bien formée dont la règle refuse le contenu. Sur la route de
 * webhook, la requête elle-même n'est pas recevable, ce qui est la définition du
 * 400.
 */
const BAD_REQUEST = 400;

/** 413 — la borne du lecteur de corps brut, hors du parseur global et de sa limite. */
const PAYLOAD_TOO_LARGE = 413;

/** 503 — absent pour la même raison : `DOMAIN_HTTP_STATUS` ne connaît pas les dépendances externes. */
const SERVICE_UNAVAILABLE = 503;

/* -------------------------------------------------------------------------- */
/*  Encaissement en ligne et au comptoir                                      */
/* -------------------------------------------------------------------------- */

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
 * Ce rendez-vous n'a plus rien à encaisser **au comptoir** (#62).
 *
 * Un seul statut le déclenche : `CANCELLED`. Le créneau a été rendu, la
 * prestation n'a pas été vendue — encaisser dessus créerait une recette sans
 * contrepartie, que rien ne viendrait justifier au rapprochement.
 *
 * ## Pourquoi le comptoir accepte ce que le tunnel refuse
 *
 * `AppointmentNotPayableError` exclut aussi `COMPLETED` et `NO_SHOW`, et c'est
 * juste **pour le tunnel public** : rouvrir un débit en ligne sur un dossier
 * clos est une opération que personne ne surveille. Au comptoir, ces deux
 * statuts sont au contraire le cas nominal — on encaisse un soin qui vient
 * d'être rendu, ou les frais d'un rendez-vous non honoré, devant la personne
 * concernée et sous l'identité d'un opérateur connu. Les refuser ici aurait
 * rendu la caisse inutilisable pour ce qu'elle sert le plus souvent.
 *
 * **422 et non 404** : le rendez-vous existe et l'appelant en connaît déjà
 * l'identifiant. `details.status` est le statut, jamais une donnée personnelle.
 */
export class AppointmentNotSettleableError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.APPOINTMENT_NOT_SETTLEABLE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(status: string) {
    super('Ce rendez-vous annulé ne peut plus être encaissé.', { status });
  }
}

/**
 * La fenêtre demandée à un historique ne contient aucun instant (#62).
 *
 * `from` est inclus et `to` **exclu** : `from >= to` décrit donc un intervalle
 * vide. Rendre une page vide aurait été défendable, mais trompeur — « aucune
 * transaction ce jour-là » et « la fenêtre est à l'envers » appellent deux
 * conduites différentes, et une caisse qui croit la première alors que c'est la
 * seconde conclut à une journée sans recette.
 *
 * **422 et non 400** : les deux bornes sont individuellement bien formées — le
 * `ValidationPipe` les a déjà acceptées. C'est leur *relation* qui est refusée,
 * et api-module §5 range cela dans la règle métier.
 */
export class HistoryWindowInvalidError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.HISTORY_WINDOW_INVALID;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor() {
    super('La fin de la fenêtre doit suivre son début.');
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
 * Cet encaissement ne peut pas être remboursé par le prestataire (#63).
 *
 * Trois situations, un seul code parce que le comptoir n'a qu'une conduite —
 * traiter le geste hors de cette route :
 *
 * - **encaissement en espèces** : il n'y a pas d'ordre à envoyer, et il ne doit
 *   pas y en avoir. Rendre un billet est un geste de caisse, pas un appel au
 *   prestataire ; le prétendre ici ferait apparaître un remboursement au relevé
 *   Stripe pour de l'argent qui n'y est jamais entré ;
 * - **rien n'a été capturé** : un encaissement `PENDING` ou `FAILED` n'a pas
 *   sorti d'argent. Le remède est l'annulation de l'intention, pas son
 *   remboursement ;
 * - **aucune référence d'intention** : la ligne existe sans `pi_…`, donc sans
 *   rien à désigner au prestataire.
 *
 * **422 et non 404** : l'encaissement existe et l'appelant en connaît déjà
 * l'identifiant — c'est lui qui vient de l'envoyer. `details.status` et
 * `details.method` sont ce dont l'écran a besoin pour choisir entre « ce
 * paiement n'a pas abouti » et « celui-ci s'est fait en espèces ». Ni l'un ni
 * l'autre n'est une donnée personnelle.
 */
export class PaymentNotRefundableError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.PAYMENT_NOT_REFUNDABLE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(method: string, status: string) {
    super('Cet encaissement ne peut pas être remboursé par le prestataire.', { method, status });
  }
}

/**
 * Le remboursement demandé ferait dépasser ce qui a été capturé (#63).
 *
 * C'est le deuxième critère du ticket, rendu à l'appelant : « le cumul des
 * remboursements ne peut jamais dépasser le montant capturé, vérifié côté
 * serveur ». Le refus tombe **avant** tout appel au prestataire — Stripe le
 * refuserait aussi, mais en faire un incident de prestataire aurait rendu 503
 * là où le comptoir a simplement demandé trop.
 *
 * `details.remainingAmountMinor` dit combien il restait, et `details.currency`
 * dans quelle monnaie. Sans ces deux valeurs, l'écran ne peut que faire
 * retâtonner l'opérateur montant après montant. Un entier et un code ISO 4217 :
 * aucune donnée personnelle, et jamais un flottant.
 *
 * **422 et non 400** : le montant est individuellement bien formé — le
 * `ValidationPipe` l'a déjà accepté. C'est sa relation à ce qui a été capturé
 * qui est refusée, et api-module §5 range cela dans la règle métier.
 */
export class RefundExceedsCapturedError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.REFUND_EXCEEDS_CAPTURED;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor(remainingAmountMinor: number, currency: string) {
    super('Le cumul des remboursements dépasserait le montant encaissé.', {
      remainingAmountMinor,
      currency,
    });
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
 *
 * C'est aussi ce que lève `StripeConfig` quand les clés manquent : une API sans
 * clés est un prestataire indisponible du point de vue de l'appelant, et son
 * corps de réponse ne doit rien dire de notre configuration.
 */
export class PaymentProviderUnavailableError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.PAYMENT_PROVIDER_UNAVAILABLE;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super('Le prestataire de paiement est momentanément indisponible.');
  }
}

/**
 * Le prestataire a **refusé** l'appel — et son refus est définitif (#63).
 *
 * ## Ce qu'elle ajoute, et pourquoi elle n'ajoute rien au contrat
 *
 * Le corps de réponse est **identique** à celui de sa classe mère : même code,
 * même 503, même absence de détail. C'est délibéré — distinguer les deux dans la
 * réponse ferait de cette route une sonde de l'état de notre compte chez le
 * prestataire, et l'appelant n'a de toute façon qu'une conduite pour les deux.
 * La sous-classe existe pour le **serveur**, pas pour le client.
 *
 * ## Ce que le serveur en fait, lui
 *
 * Elle porte la seule distinction qui compte sur le chemin d'un remboursement :
 * savoir si de l'argent a pu bouger.
 *
 * | Issue de l'appel | Erreur | La réservation |
 * |---|---|---|
 * | refus explicite du prestataire (4xx avec corps d'erreur) | celle-ci | **relâchée** — rien n'est sorti, la somme reste remboursable |
 * | délai dépassé, coupure, 5xx, corps illisible | la mère | **conservée** — le sort de l'ordre est inconnu |
 *
 * Relâcher une réservation dont on ignore le sort est ce qui rendrait l'argent
 * deux fois : la reprise repartirait avec une **autre** clé d'idempotence, et le
 * prestataire n'aurait aucun moyen de reconnaître le doublon. Conserver la
 * réservation immobilise la somme jusqu'à un rapprochement manuel — coûteux,
 * mais réparable, là où un double remboursement ne l'est pas.
 *
 * Elle **hérite** de `PaymentProviderUnavailableError` plutôt que d'en être la
 * sœur : tout code qui attrape la mère continue de l'attraper, y compris le
 * tunnel public de #57, qui n'a pas à connaître la nuance.
 */
export class PaymentProviderRefusedError extends PaymentProviderUnavailableError {}

/* -------------------------------------------------------------------------- */
/*  Réception des webhooks Stripe                                             */
/* -------------------------------------------------------------------------- */

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
  public override readonly code = PAYMENT_ERROR_CODES.WEBHOOK_PAYLOAD_TOO_LARGE;
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
 *
 * Le message ne dit jamais **ce qui** a échoué — l'en-tête, l'horodatage ou le
 * condensat. Le seul appelant légitime de cette route est Stripe, qui n'a que
 * faire du détail ; le seul autre appelant possible est quelqu'un qui sonde, et
 * lui apprendre où cela a cassé lui donnerait le fil à tirer.
 */
export class InvalidWebhookSignatureError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.INVALID_WEBHOOK_SIGNATURE;
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
 * `StripeConfig` refuse de démarrer sans secret plutôt que de servir une route
 * qui ne vérifie rien (api-module §7).
 */
export class WebhookNotConfiguredError extends DomainError {
  public override readonly code = PAYMENT_ERROR_CODES.WEBHOOK_NOT_CONFIGURED;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super('La réception des webhooks de paiement n’est pas configurée.');
  }
}

/* -------------------------------------------------------------------------- */
/*  Rayon retail et ticket de caisse                                          */
/* -------------------------------------------------------------------------- */

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
  public override readonly code = PAYMENT_ERROR_CODES.PRODUCT_SKU_TAKEN;
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
  public override readonly code = PAYMENT_ERROR_CODES.SALE_ITEM_UNAVAILABLE;
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
  public override readonly code = PAYMENT_ERROR_CODES.SALE_CURRENCY_MISMATCH;
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
  public override readonly code = PAYMENT_ERROR_CODES.SALE_AMOUNT_OUT_OF_RANGE;
  public override readonly status = UNPROCESSABLE_ENTITY;

  public constructor() {
    super('Le total de ce ticket dépasse le montant maximal admis.');
  }
}
