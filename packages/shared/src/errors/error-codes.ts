/**
 * Codes d'erreur de l'API — l'énumération sur laquelle le front branche son
 * comportement.
 *
 * Le contrat de sortie est unique pour toute l'API (api-module §5) :
 *
 * ```json
 * { "code": "SLOT_NO_LONGER_AVAILABLE", "message": "…", "details": {} }
 * ```
 *
 * **Le front réagit sur `code`, jamais sur `message`** : le message est
 * traduisible, réécrit, expurgé par le filtre d'exception, et peut changer sans
 * préavis. Le code, lui, est un contrat : retirer ou renommer une valeur de ce
 * fichier casse un front déployé.
 *
 * Ce que ce fichier n'est **pas** : une table de correspondance vers des statuts
 * HTTP. Le statut est décidé par le serveur et lu sur la réponse ; le dupliquer
 * ici créerait une seconde source de vérité qui divergerait au premier code
 * ajouté.
 *
 * ## Le découpage : une famille par module du CDC §2.3
 *
 * Depuis #536, les familles suivent **exactement** le découpage modulaire
 * d'`apps/api` — `identity`, `catalog`, `availability`, `appointments`, `crm`,
 * `payments`, `notifications`, `reporting` — plus les deux familles qui
 * n'appartiennent à aucun module : le transport HTTP et les refus transverses.
 *
 * C'est ce découpage qui rend le rapatriement possible. Tant que le contrat
 * mêlait les codes de deux modules dans un même `BOOKING_ERROR_CODES`, un module
 * qui aurait importé sa famille depuis ici en aurait emprunté la moitié à son
 * voisin, sans que rien ne dise lequel des deux en était propriétaire — c'est la
 * raison pour laquelle #510 a renoncé à substituer et a renuméroté ses marqueurs
 * vers #536.
 *
 * Chaque `apps/api/src/modules/<m>/<m>.errors.ts` importe désormais sa famille
 * d'ici et la **réexporte** : aucun module ne déclare plus de littéral de code,
 * et le contrat est la seule écriture de chacun.
 *
 * ## Ce qui a été tranché en rapatriant, et dans quel sens
 *
 * Les deux écritures avaient divergé. Le sens retenu est celui de l'ADR 0008 sur
 * `uuidSchema` : **on resserre le contrat sur ce que l'API émet réellement, on
 * ne relâche pas l'API sur ce que le contrat annonçait.** Un contrat qui déclare
 * un code que l'API n'émet jamais est plus dangereux qu'un code manquant : le
 * front écrit une branche de comportement qui ne se déclenchera pas, et le refus
 * réel tombe dans la branche générique.
 *
 * ### Les quatre paires divergentes
 *
 * | Contrat, avant | `apps/api` | Retenu |
 * |---|---|---|
 * | `PAYMENT_ALREADY_CAPTURED` | `PAYMENT_ALREADY_SETTLED` | **`PAYMENT_ALREADY_SETTLED`** |
 * | `REFUND_EXCEEDS_CAPTURED_AMOUNT` | `REFUND_EXCEEDS_CAPTURED` | **`REFUND_EXCEEDS_CAPTURED`** |
 * | `PAYMENT_PROVIDER_ERROR` | `PAYMENT_PROVIDER_UNAVAILABLE` | **`PAYMENT_PROVIDER_UNAVAILABLE`** |
 * | `CURRENCY_MISMATCH` | `SALE_CURRENCY_MISMATCH` | **les deux** — voir ci-dessous |
 *
 * Les trois premières sont bien deux noms pour un seul refus, et c'est le nom
 * servi qui gagne. La quatrième n'en était pas une : `SALE_CURRENCY_MISMATCH`
 * est le 422 d'une **ligne de ticket** libellée dans une autre devise que celle
 * du salon, avec sa `position` ; `CURRENCY_MISMATCH` est le code porté par
 * `CurrencyMismatchError`, la garde arithmétique de `Money` que ce paquet
 * exporte lui-même (`common/money.ts`) et que `contract-surface.spec.ts` tient
 * pour un membre du contrat. Les confondre aurait fait disparaître une garde qui
 * n'a rien à voir avec la caisse.
 *
 * ### Les codes orphelins retirés
 *
 * Onze codes que le contrat déclarait et qu'aucune sous-classe de `DomainError`
 * d'`apps/api` ne porte :
 *
 * - `identity` — `ACCESS_TOKEN_EXPIRED`, `INVALID_TOKEN`,
 *   `REFRESH_TOKEN_REVOKED`, `ACCOUNT_DISABLED`, `INSUFFICIENT_ROLE`,
 *   `TENANT_UNAVAILABLE`. L'authentification refuse par des `HttpException` du
 *   framework, que `DomainExceptionFilter` traduit en `UNAUTHORIZED` et
 *   `FORBIDDEN` — jamais en l'un de ces six ;
 * - réservation — `SLOT_OUTSIDE_WORKING_HOURS`, `BOOKING_TOO_LATE`,
 *   `STAFF_NOT_ELIGIBLE_FOR_SERVICE`, `CANCELLATION_WINDOW_CLOSED`. Ces refus
 *   existent, mais sortent aujourd'hui en `BUSINESS_RULE_VIOLATION` ;
 * - paiements — `REFUND_EXCEEDS_CAPTURED_AMOUNT`, remplacé par le nom servi.
 *
 * Les rétablir se fait à l'endroit qui les émettrait : une sous-classe de
 * `DomainError` d'abord, sa ligne ici ensuite. Pas l'inverse — c'est l'inverse
 * qui a produit la divergence.
 *
 * ### Les deux orphelins qui restent, et jusqu'à quand
 *
 * `PAYMENT_ALREADY_CAPTURED` et `PAYMENT_PROVIDER_ERROR` sont encore déclarés,
 * marqués `@deprecated`. Ils ne sont **pas** émis. Ils sont lus par
 * `apps/web/lib/admin/checkout-summary.ts`, qui les range dans le même `case`
 * que les noms servis, et les retirer d'ici casserait la compilation du front.
 * Ce fichier est hors de l'empreinte du ticket qui a fait ce rapatriement : les
 * deux lignes partent ensemble dans l'issue de suivi.
 *
 * ## Le garde qui empêche la divergence de se rouvrir
 *
 * `src/__tests__/api-error-codes.spec.ts` relit les sources d'`apps/api` et
 * échoue si une sous-classe de `DomainError` porte un code absent de
 * `ERROR_CODES`, ou si un module réintroduit un littéral. C'est ce qui manquait :
 * les deux écritures ont divergé pendant des mois sans qu'aucune barrière ne le
 * dise.
 */

/**
 * Codes émis par l'infrastructure HTTP — `ValidationPipe`, route absente,
 * garde d'authentification, plafond de débit. Ils ne portent aucune sémantique
 * métier.
 *
 * Ils sont le miroir exact de `CODE_BY_STATUS` du `DomainExceptionFilter`, plus
 * le `VALIDATION_ERROR` que le pipe d'entrée produit.
 */
export const TRANSPORT_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_ACCEPTABLE: 'NOT_ACCEPTABLE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Corps de requête refusé par la validation ; `details.violations` liste les champs. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

/**
 * Codes de domaine transverses, levés par n'importe quel module — ceux que porte
 * le tronc commun d'`apps/api` (`common/errors/domain-error.ts`) et qui
 * n'appartiennent donc à aucun module en particulier.
 *
 * `NOT_FOUND` couvre aussi la ressource **d'un autre tenant** : un 403 y
 * confirmerait son existence, ce qui est une fuite d'information
 * (tenant-isolation §4). Le front ne doit donc jamais interpréter un
 * `NOT_FOUND` comme « cet identifiant n'existe nulle part ». Il est déclaré dans
 * la famille de transport, où le filtre le produit aussi par le statut.
 */
export const DOMAIN_ERROR_CODES = {
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
} as const;

/**
 * Authentification, comptes et invitations — module `identity` (#21, #22, #55).
 *
 * Ce que cette famille **ne** contient pas, et c'est le résultat du
 * rapatriement : les refus de jeton et de rôle. Ils ne passent pas par une
 * `DomainError` mais par les gardes de Nest, et sortent donc en `UNAUTHORIZED`
 * ou `FORBIDDEN`.
 */
export const IDENTITY_ERROR_CODES = {
  /** Couple e-mail / mot de passe refusé. Ne distingue **jamais** lequel des deux est faux. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Inscription sur une adresse déjà prise **dans ce tenant**. */
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  /**
   * Jeton de rafraîchissement absent, illisible, expiré, révoqué — ou rejoué.
   *
   * Un seul code pour les cinq causes : à la nuance près, un porteur de jeton
   * volé apprendrait si la session est encore vivante.
   */
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  /**
   * Invitation de personnel refusée — jeton contrefait, expiré, ou désignant un
   * compte supprimé ou désactivé. Le point d'entrée n'étant pas authentifié,
   * distinguer les cas en ferait un oracle sur l'annuaire du salon.
   */
  INVALID_INVITATION: 'INVALID_INVITATION',
  /** Réémission demandée sur un compte déjà activé, par un administrateur authentifié. */
  INVITATION_ALREADY_ACCEPTED: 'INVITATION_ALREADY_ACCEPTED',
} as const;

/**
 * Prestations, catégories et affectations de praticiens — module `catalog`.
 *
 * Aucun de ces codes ne parle d'un autre établissement : une prestation d'un
 * tenant voisin est *introuvable*, et c'est `NOT_FOUND` qui répond
 * (tenant-isolation §4).
 */
export const CATALOG_ERROR_CODES = {
  /** Slug de prestation déjà pris **dans cet établissement** ; `details.slug` le rend. */
  SERVICE_SLUG_TAKEN: 'SERVICE_SLUG_TAKEN',
  /** Slug de catégorie déjà pris dans cet établissement. */
  SERVICE_CATEGORY_SLUG_TAKEN: 'SERVICE_CATEGORY_SLUG_TAKEN',
  /**
   * Ce praticien pratique déjà cette prestation — l'unicité
   * `(tenant_id, service_id, staff_id)` refusée par la base, jamais par un
   * contrôle préalable que deux clics concurrents passeraient tous les deux.
   */
  SERVICE_STAFF_ALREADY_ASSIGNED: 'SERVICE_STAFF_ALREADY_ASSIGNED',
} as const;

/**
 * Calcul de créneaux, semaines de travail et absences — module `availability`.
 *
 * Les trois premiers codes sont des refus de **temps civil** : ils n'existent
 * que parce qu'un fuseau n'est pas une simple addition d'heures, et qu'un
 * rendez-vous décalé en silence est un bug de sévérité haute (CLAUDE.md).
 */
export const AVAILABILITY_ERROR_CODES = {
  /**
   * Heure locale sautée par l'avance de l'horloge — elle n'a pas eu lieu.
   * `details` porte l'heure de repli et la durée du saut, pour que le front
   * puisse proposer l'heure voisine plutôt qu'un échec sec.
   */
  NON_EXISTENT_LOCAL_TIME: 'NON_EXISTENT_LOCAL_TIME',
  /**
   * Heure locale vécue deux fois par le recul de l'horloge. `details` porte les
   * deux occurrences : le front pose la question plutôt que de trancher.
   */
  AMBIGUOUS_LOCAL_TIME: 'AMBIGUOUS_LOCAL_TIME',
  /** Fuseau IANA inconnu du moteur ICU — une faute de frappe sur `tenants.timezone`. */
  UNKNOWN_TIME_ZONE: 'UNKNOWN_TIME_ZONE',
  /**
   * Deux plages du même jour se recouvrent dans une semaine de travail (#32).
   * La base porte la même règle en `EXCLUDE USING gist` ; ce refus la **nomme**
   * plutôt que de la laisser sortir en violation brute, donc en 500.
   */
  OVERLAPPING_SCHEDULE_RANGES: 'OVERLAPPING_SCHEDULE_RANGES',
  /**
   * Plage bloquée ou congé dont les bornes ne tiennent pas : fin avant début,
   * ou fenêtre au-delà de `MAX_TIME_OFF_RANGE_DAYS` (#33). **422**.
   *
   * Un seul code pour les deux refus, `details.rule` les distingue
   * (`ends_before_starts` / `range_too_wide`) : le front affiche le même
   * message sur le même champ, et un second code lui aurait fait écrire deux
   * branches pour une seule correction à faire par l'utilisateur.
   */
  TIME_OFF_RANGE_INVALID: 'TIME_OFF_RANGE_INVALID',
  /** Plage de disponibilité trop large — voir `MAX_AVAILABILITY_RANGE_DAYS`. */
  AVAILABILITY_RANGE_TOO_WIDE: 'AVAILABILITY_RANGE_TOO_WIDE',
} as const;

/** Cycle de vie des rendez-vous — module `appointments`, le cœur de la boucle de valeur. */
export const APPOINTMENTS_ERROR_CODES = {
  /**
   * Le créneau a été pris entre l'affichage et la validation. **409**, jamais
   * 500 : le front réaffiche les créneaux et invite à en choisir un autre
   * (booking-engine §1).
   *
   * Elle n'est jamais levée sur la foi d'une lecture préalable : elle traduit le
   * refus de `appointments_no_overlap` par PostgreSQL, le seul arbitre qui ne
   * puisse pas se tromper sous concurrence (ADR 0002).
   */
  SLOT_NO_LONGER_AVAILABLE: 'SLOT_NO_LONGER_AVAILABLE',
  /**
   * Plage de l'agenda de back-office trop large, ou inversée — voir
   * `MAX_APPOINTMENT_RANGE_DAYS` (#444). **422** : chaque date est bien écrite,
   * c'est leur écart qui n'est pas servable.
   *
   * Distinct d'`AVAILABILITY_RANGE_TOO_WIDE` parce que les deux plages ne
   * bornent pas la même chose — un calcul de créneaux d'un côté, le volume d'une
   * liste de rendez-vous de l'autre — et qu'un front qui les confondrait
   * afficherait « aucun créneau disponible » là où il faut réduire la fenêtre du
   * calendrier.
   */
  APPOINTMENT_RANGE_TOO_WIDE: 'APPOINTMENT_RANGE_TOO_WIDE',
} as const;

/**
 * Fichier client — module `crm`.
 *
 * Aucun de ces refus ne recopie l'adresse en cause dans `details` : une adresse
 * e-mail est une donnée personnelle (CDC §5.1), et un corps d'erreur repart vers
 * un journal d'accès ou une capture d'écran de ticket.
 */
export const CRM_ERROR_CODES = {
  /**
   * Une fiche **de cet établissement** porte déjà cette adresse — l'unicité
   * `(tenant_id, email)` refusée par la base. Ne traverse aucune frontière de
   * tenant : la même personne peut être cliente de deux salons.
   */
  CUSTOMER_EMAIL_TAKEN: 'CUSTOMER_EMAIL_TAKEN',
  /**
   * L'adresse envoyée ne peut pas porter une réservation **en ligne** dans cet
   * établissement (#313). **409**.
   *
   * ## Pourquoi le front doit le distinguer
   *
   * C'est l'autre 409 du parcours public, et il n'a de commun avec
   * `SLOT_NO_LONGER_AVAILABLE` que son statut. Le créneau perdu est **passager** :
   * un autre horaire le lève. Celui-ci est **définitif pour cette adresse** —
   * aucun créneau ne le lèvera jamais. Un front qui les confondrait renverrait la
   * visiteuse au calendrier pour se heurter au même refus à chaque essai (#452).
   *
   * ## Pourquoi dans la famille `crm`
   *
   * Il est levé par `crm`, qui résout la fiche cliente, mais il sort par une
   * route d'`appointments` — la réservation publique. Il a longtemps vécu dans
   * `DOMAIN_ERROR_CODES` pour cette raison, avec la note que sa place définitive
   * suivrait le regroupement par domaine ; c'est fait ici (#536). Le module qui
   * le **lève** est celui qui le porte : c'est la seule règle qui ne dépende pas
   * de la route par laquelle il se trouve sortir aujourd'hui.
   *
   * ## Ce que le message affiché n'a pas le droit de dire
   *
   * *Pourquoi* l'adresse est refusée. La cause, côté serveur, est qu'elle porte
   * un compte non client de l'établissement ; l'écrire à l'écran ferait de ce
   * refus un **oracle sur l'annuaire du personnel**, interrogeable adresse par
   * adresse depuis une route publique et non authentifiée. Le front constate le
   * refus et invite à en saisir une autre, sans qualifier celle-ci.
   *
   * `details` est vide, et le reste.
   */
  CLIENT_EMAIL_NOT_BOOKABLE: 'CLIENT_EMAIL_NOT_BOOKABLE',
  /**
   * La fiche a encore des rendez-vous à venir : elle ne peut pas être anonymisée
   * maintenant (#81). **422** — la voie est ouverte, honorer ou annuler.
   * `details` ne porte que leur **nombre**, ni date, ni prestation, ni praticien.
   */
  CUSTOMER_HAS_UPCOMING_APPOINTMENTS: 'CUSTOMER_HAS_UPCOMING_APPOINTMENTS',
} as const;

/**
 * Encaissement, remboursement, webhooks et caisse — module `payments`
 * (payments-stripe).
 *
 * **Aucun de ces refus ne cite Stripe** — ni message de prestataire, ni
 * identifiant de requête, ni fragment de clé — et **aucun ne porte de donnée de
 * carte** : ni PAN, ni CVC, ni les quatre derniers chiffres. Un `details`
 * d'erreur est journalisé et traverse le réseau public ; c'est exactement
 * l'endroit où la frontière SAQ A se perd (payments-stripe §1).
 */
export const PAYMENT_ERROR_CODES = {
  /* --- Encaissement en ligne et au comptoir (#57, #62, #63) --------------- */

  /**
   * Ce rendez-vous n'a plus rien à encaisser **en ligne** — annulé, terminé ou
   * non honoré. `details.status` porte le statut du rendez-vous.
   */
  APPOINTMENT_NOT_PAYABLE: 'APPOINTMENT_NOT_PAYABLE',
  /**
   * Ce rendez-vous n'a plus rien à encaisser **au comptoir** (#62) : il est
   * annulé. Plus permissif que son jumeau du tunnel, qui exclut aussi
   * `COMPLETED` et `NO_SHOW` — au comptoir, ces deux statuts sont le cas
   * nominal.
   */
  APPOINTMENT_NOT_SETTLEABLE: 'APPOINTMENT_NOT_SETTLEABLE',
  /**
   * Un encaissement existe déjà pour ce rendez-vous, et il n'attend plus rien —
   * abouti, remboursé, réglé en espèces, ou donné pour payé par Stripe pendant
   * que notre ligne dit encore `PENDING`.
   *
   * Ne couvre **pas** la carte refusée : une intention refusée redevient
   * `requires_payment_method` et attend une autre carte. La traiter comme close
   * rendrait le rendez-vous définitivement impayable.
   *
   * A remplacé `PAYMENT_ALREADY_CAPTURED` du contrat (#536) — c'est ce nom-ci
   * que l'API a toujours servi.
   */
  PAYMENT_ALREADY_SETTLED: 'PAYMENT_ALREADY_SETTLED',
  /**
   * Stripe a refusé l'appel, ou n'a pas répondu. **503 et non 500** : ce n'est
   * pas un défaut de notre code, c'est une dépendance indisponible, et un 503 se
   * retente là où un 500 se signale.
   *
   * A remplacé `PAYMENT_PROVIDER_ERROR` du contrat (#536).
   */
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  /**
   * La fenêtre demandée à un historique d'encaissements ne contient aucun
   * instant : `from` est inclus, `to` exclu. Rendre une page vide aurait laissé
   * la caisse conclure à une journée sans recette.
   */
  HISTORY_WINDOW_INVALID: 'HISTORY_WINDOW_INVALID',
  /**
   * Cet encaissement ne peut pas être remboursé par le prestataire (#63) :
   * réglé en espèces, jamais capturé, ou sans référence d'intention.
   */
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  /**
   * Le remboursement demandé ferait dépasser ce qui a été capturé (#63). Le
   * refus tombe **avant** tout appel au prestataire. `details` porte le restant
   * et sa devise — un entier et un code ISO 4217, jamais un flottant.
   *
   * A remplacé `REFUND_EXCEEDS_CAPTURED_AMOUNT` du contrat (#536).
   */
  REFUND_EXCEEDS_CAPTURED: 'REFUND_EXCEEDS_CAPTURED',

  /* --- Réception des webhooks Stripe (#58) -------------------------------- */

  /**
   * Le corps reçu n'est pas signé par Stripe. **400 immédiat, aucun
   * traitement** : cette route est le seul point d'entrée public non gardé de
   * l'API, et la signature est la seule chose qui distingue Stripe de n'importe
   * qui (payments-stripe §3).
   */
  INVALID_WEBHOOK_SIGNATURE: 'INVALID_WEBHOOK_SIGNATURE',
  /**
   * Le secret de terminaison n'est pas configuré sur ce déploiement. **503 et
   * non 400** : Stripe rejoue les 5xx, donc les livraisons reçues pendant la
   * fenêtre de mauvaise configuration reviendront une fois le secret posé.
   */
  WEBHOOK_NOT_CONFIGURED: 'WEBHOOK_NOT_CONFIGURED',
  /**
   * Le corps dépasse la borne du lecteur brut — levée **avant** toute
   * vérification de signature : accumuler des octets non authentifiés est
   * précisément ce qu'il ne faut pas faire ici.
   */
  WEBHOOK_PAYLOAD_TOO_LARGE: 'WEBHOOK_PAYLOAD_TOO_LARGE',

  /* --- Rayon retail et ticket de caisse (#60) ----------------------------- */

  /**
   * Ce code d'article est déjà pris dans cet établissement. `details` ne porte
   * **pas** le code : un conflit qui recopie la valeur rend le refus
   * distinguable, de quoi sonder le rayon d'un salon code par code.
   */
  PRODUCT_SKU_TAKEN: 'PRODUCT_SKU_TAKEN',
  /**
   * Un article du ticket existe mais n'est plus vendable. `details.position`
   * désigne **le rang de la ligne**, jamais l'identifiant de l'article.
   */
  SALE_ITEM_UNAVAILABLE: 'SALE_ITEM_UNAVAILABLE',
  /**
   * Un article du ticket est libellé dans une autre devise que celle de
   * l'établissement. Le serveur **refuse** plutôt que de convertir : une
   * conversion sans taux daté se figerait dans une pièce comptable.
   *
   * Distinct de `CURRENCY_MISMATCH`, qui est la garde arithmétique de `Money` et
   * ne désigne aucune ligne de ticket (#536).
   */
  SALE_CURRENCY_MISMATCH: 'SALE_CURRENCY_MISMATCH',
  /**
   * Le ticket dépasse ce qu'un montant du schéma peut porter — les colonnes sont
   * des entiers 32 bits signés. Vérifié **avant** l'écriture, pour que le refus
   * soit celui que le front sait lire et non le 500 d'une erreur de type.
   */
  SALE_AMOUNT_OUT_OF_RANGE: 'SALE_AMOUNT_OUT_OF_RANGE',

  /* --- Garde arithmétique du contrat lui-même ----------------------------- */

  /**
   * Devises différentes de part et d'autre d'une opération sur des montants.
   *
   * Porté par `CurrencyMismatchError` (`common/money.ts`), que `addMoney`,
   * `subtractMoney`, `compareMoney` et `assertSameCurrency` lèvent. **Aucune
   * conversion implicite** n'est faite — un taux de change choisi en silence est
   * une perte d'argent qui ne se voit qu'au rapprochement.
   *
   * Il vit dans la famille `payments` parce que c'est ce module qui laisserait
   * remonter la classe telle quelle, mais il ne décrit **pas** le même refus que
   * `SALE_CURRENCY_MISMATCH` : celui-ci désigne une ligne de ticket, celui-là une
   * addition impossible.
   */
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',

  /* --- Orphelins en sursis ------------------------------------------------ */

  /**
   * @deprecated Jamais émis. Le refus réel est `PAYMENT_ALREADY_SETTLED`.
   *
   * Conservé le temps que `apps/web/lib/admin/checkout-summary.ts` cesse de le
   * lire — le retirer d'ici casse aujourd'hui la compilation du front (#536).
   */
  PAYMENT_ALREADY_CAPTURED: 'PAYMENT_ALREADY_CAPTURED',
  /**
   * @deprecated Jamais émis. Le refus réel est `PAYMENT_PROVIDER_UNAVAILABLE`.
   *
   * Même sursis que `PAYMENT_ALREADY_CAPTURED`, et il part avec lui.
   */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
} as const;

/**
 * Chaîne d'envoi des messages — module `notifications`.
 *
 * Ces codes ne sortent aujourd'hui que par les routes de modèles ; les autres
 * sont lus par le consommateur de file, pour qui ils disent s'il faut rejouer le
 * message ou l'abandonner. **Aucun ne porte de donnée personnelle** : ni
 * adresse, ni numéro, ni nom de cliente (notifications §7).
 */
export const NOTIFICATION_ERROR_CODES = {
  /**
   * Aucun expéditeur n'est branché pour ce canal. **503** : une capacité absente,
   * pas une requête fautive — la ligne reste `FAILED` et SQS réessaie.
   */
  NOTIFICATION_SENDER_NOT_CONFIGURED: 'NOTIFICATION_SENDER_NOT_CONFIGURED',
  /**
   * Aucun modèle n'existe pour ce type de message, vu depuis la chaîne d'envoi.
   * **503** : le refus vaut mieux qu'un repli sur le modèle de confirmation — un
   * rappel qui annoncerait « votre rendez-vous est confirmé » serait pire qu'un
   * rappel absent.
   */
  NOTIFICATION_NOT_RENDERABLE: 'NOTIFICATION_NOT_RENDERABLE',
  /**
   * Le rendez-vous que ce message annonce n'existe plus. **404** : rien ne se
   * répare en réessayant, et le consommateur de file doit cesser de le rejouer.
   */
  NOTIFICATION_CONTEXT_GONE: 'NOTIFICATION_CONTEXT_GONE',
  /**
   * Aucun jeton d'appel interne n'est configuré sur cette API. Défaut **fermé** :
   * sans jeton attendu, aucun appel n'est reconnu.
   */
  INTERNAL_CALLER_NOT_CONFIGURED: 'INTERNAL_CALLER_NOT_CONFIGURED',
  /**
   * Le jeton d'appel interne présenté n'est pas celui attendu — ou il manque.
   * **401 et non 403** : la question n'est pas le droit mais l'identité, et la
   * Lambda d'envoi classe ce refus comme transitoire.
   */
  INTERNAL_CALLER_REJECTED: 'INTERNAL_CALLER_REJECTED',
  /**
   * Le modèle soumis nomme des variables inconnues, laisse une section ouverte,
   * ou omet un champ que son canal exige (#69). **400** : le champ en cause est
   * nommable, et `details` le nomme.
   */
  NOTIFICATION_TEMPLATE_INVALID: 'NOTIFICATION_TEMPLATE_INVALID',
  /**
   * Le modèle de SMS dépasse le plafond de segments (#69). Refusé, jamais
   * tronqué. `details` porte l'encodage et le nombre de segments mesurés — un
   * accent hors GSM-7 bascule le message en UCS-2 et double la facture.
   */
  NOTIFICATION_TEMPLATE_TOO_LONG: 'NOTIFICATION_TEMPLATE_TOO_LONG',
  /**
   * Aucun modèle — ni personnalisé, ni par défaut — pour ce message. **404** :
   * mieux vaut ne rien servir que le modèle d'un autre type.
   */
  NOTIFICATION_TEMPLATE_NOT_FOUND: 'NOTIFICATION_TEMPLATE_NOT_FOUND',
} as const;

/**
 * Tableau de bord et exports — module `reporting`.
 *
 * Un rapport ne désigne aucune ressource : ces deux refus sont des **422**, les
 * bornes étant individuellement bien formées. `details` ne contient que des
 * nombres de jours.
 */
export const REPORTING_ERROR_CODES = {
  /**
   * La fenêtre demandée ne contient aucun instant — `from` inclus, `to` exclu.
   * Rendre un rapport à zéro aurait fait conclure à une journée blanche.
   */
  REPORT_WINDOW_INVALID: 'REPORT_WINDOW_INVALID',
  /**
   * La fenêtre dépasse `MAX_REPORT_WINDOW_DAYS`. Un plafond **serveur**, non
   * négociable : sans lui, `?from=1970-01-01` est un déni de service à une
   * requête sur les trois routes à la fois.
   */
  REPORT_WINDOW_TOO_WIDE: 'REPORT_WINDOW_TOO_WIDE',
} as const;

/**
 * L'ensemble des codes stables du contrat, tous domaines confondus.
 *
 * L'objet est figé à l'exécution : un module qui écrirait dedans changerait le
 * contrat pour tout le processus.
 */
export const ERROR_CODES = Object.freeze({
  ...TRANSPORT_ERROR_CODES,
  ...DOMAIN_ERROR_CODES,
  ...IDENTITY_ERROR_CODES,
  ...CATALOG_ERROR_CODES,
  ...AVAILABILITY_ERROR_CODES,
  ...APPOINTMENTS_ERROR_CODES,
  ...CRM_ERROR_CODES,
  ...PAYMENT_ERROR_CODES,
  ...NOTIFICATION_ERROR_CODES,
  ...REPORTING_ERROR_CODES,
});

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

/**
 * `true` si `value` est l'un des codes stables ci-dessus.
 *
 * Un corps d'erreur peut porter un code **inconnu** de cette liste : le filtre
 * d'exception retombe sur `HTTP_<statut>` pour un statut qu'il ne sait pas
 * nommer. Le front traite ce cas comme une erreur générique — d'où ce garde,
 * plutôt qu'un transtypage optimiste.
 */
export function isKnownErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value);
}
