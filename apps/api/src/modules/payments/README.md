# Module `payments`

Encaissement et tokenisation (CDC §2.3). C'est l'étape « encaisser » de la
boucle de valeur du MVP, et le module dont la conception est **contrainte par la
conformité** autant que par le métier : tout ce qui suit existe pour maintenir
notre périmètre PCI en SAQ A.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #57 | L'intention de paiement Stripe, la clé publiable, et la frontière qui les sépare de la clé secrète |
| #58 | La réception des webhooks Stripe — signature sur corps brut, idempotence en base, et le passage du rendez-vous en `CONFIRMED` |
| #60 | Le POS de base — rayon retail, ticket de caisse et ses lignes, total recalculé côté serveur |
| #62 | Le règlement en espèces, l’historique des ventes et celui des transactions — la matière du rapprochement |
| #63 | Le remboursement total et partiel : l’ordre au prestataire, le cumul borné côté serveur, la trace « qui, quand, pourquoi » |
| #410 | La consolidation de #57 et #58 : une seule `StripeConfig`, un seul fichier d’erreurs, un critère de découpage des dépôts, et la marque d’idempotence conditionnée à l’effet |

À venir : le montage d’Elements côté tunnel (#59).

## Ce qui décide du découpage interne (#410)

#57 et #58 ont été écrites en parallèle, à partir du même `develop`, et aucune
n’était mergée quand l’autre a été ouverte. Elles ont laissé le module en deux
moitiés qui ne se connaissaient pas : deux fournisseurs de configuration Stripe,
deux fichiers d’erreurs, deux dépôts. Ce n’était pas une conception, c’était un
ordre de merge.

Deux de ces trois duplications ont été fondues, parce que rien ne les portait :

- **une seule `StripeConfig`**, portant les trois valeurs — les deux clés et le
  secret de terminaison. #57 l’avait déjà annoncé en l’exportant, « parce que #58
  aura besoin du secret de webhook au même endroit » ;
- **un seul `payments.errors.ts`**, qui absorbe `stripe-webhook.errors.ts` et
  `pos.errors.ts`. Le coût de la séparation était réel : `const
  SERVICE_UNAVAILABLE = 503` était écrit deux fois, et deux tables de statuts qui
  dérivent, c’est un module qui répond autre chose que ce que son contrat annonce.

Le découpage des **dépôts**, lui, survit — mais adossé à un critère, et non à
l’historique des branches :

| Dépôt | Ce qui le sépare des autres |
|---|---|
| `stripe-webhook.repository.ts` | le **seul** à recevoir `PRISMA_UNSCOPED` — l’unique dérogation inter-tenant du module (tenant-isolation §3) |
| `refunds.repository.ts` | un « lire, décider, écrire » qui doit se sérialiser |
| `pos.repository.ts` | le ticket et ses lignes, écrits d’un seul geste transactionnel |
| `payments.repository.ts` | tout le reste, et **rien qui ne soit scopé** |

La première ligne est celle qui compte : fondre le dépôt du webhook dans
`PaymentsRepository` mettrait le client non scopé dans le constructeur qui sert
le tunnel public et le comptoir. `__tests__/payments.boundaries.spec.ts` échoue
si un second fichier du module cite ce jeton — le critère est vérifié, pas
seulement écrit.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `POST` | `/api/v1/public/:tenantSlug/payments/intents` | — (ouverte) |
| `POST` | `/api/v1/stripe/webhook` | — (signature Stripe) |
| `GET` | `/api/v1/products` | `STAFF` |
| `POST` | `/api/v1/products` | `MANAGER` |
| `PATCH` | `/api/v1/products/:id` | `MANAGER` |
| `POST` | `/api/v1/sales` | `STAFF` |
| `GET` | `/api/v1/sales` | `STAFF` |
| `GET` | `/api/v1/sales/:id` | `STAFF` |
| `POST` | `/api/v1/payments/cash` | `STAFF` |
| `GET` | `/api/v1/payments` | `MANAGER` |
| `POST` | `/api/v1/payments/:paymentId/refunds` | `MANAGER` |

Les routes du comptoir sont gardées et **n'ont aucune surface publique** : un
ticket de caisse est une pièce comptable du salon, son rayon une donnée
commerciale. La ligne entre `STAFF` et `MANAGER` passe où le CDC la met —
composer une addition, lire le rayon, encaisser un billet et faire la relève de
caisse sont des gestes de comptoir ; fixer un prix de vente et rapprocher les
relevés du prestataire sont des décisions de gestion.

La route du tunnel n'est pas gardée, et c'est délibéré : on réserve sans compte (#37),
donc on paie sans compte. Ce qui autorise l'appel est la **connaissance de
l'identifiant** du rendez-vous — un UUID v4 remis à la cliente sur son écran de
confirmation et dans son e-mail. C'est exactement le régime du report et de
l'annulation du même tunnel.

Ce qui la tient, faute de garde :

1. le `ValidationPipe` global, `whitelist` **et** `forbidNonWhitelisted` — le
   corps ne porte qu'un `appointmentId`, tout le reste fait rejeter la requête ;
2. `TenantScopeMiddleware`, qui résout le `:tenantSlug` contre la table
   `tenants` avant le contrôleur ;
3. le scoping Prisma, qui rend le rendez-vous d'un autre salon **introuvable**,
   pas interdit ;
4. `ThrottlerGuard` — cette route écrit et appelle un tiers ; sans quota, notre
   API deviendrait un amplificateur d'appels vers Stripe.

## La frontière PCI, en un coup d'œil

**Aucune donnée de carte n'atteint ce module**, et cela se vérifie en trois
endroits plutôt que dans un commentaire :

| Où | Ce qui l'empêche |
|---|---|
| `dto/create-payment-intent.dto.ts` | un seul champ déclaré ; un PAN dans le corps est un 400 avant tout code métier |
| `payments.types.ts` | le domaine n'a aucune notion de carte — pas de champ où en ranger une |
| `stripe/stripe.gateway.ts` | le port n'a pas de paramètre pour en recevoir ; `automatic_payment_methods` délègue la saisie aux iframes de Stripe |

Ce que nous conservons, et rien d'autre : l'identifiant Stripe, le montant, la
devise, le statut. La marque et les quatre derniers chiffres viendront du
webhook (#58), s'ils viennent.

## Les deux clés, et laquelle sort

| Clé | Où elle vit | Qui la voit |
|---|---|---|
| `STRIPE_SECRET_KEY` | AWS Secrets Manager → variable de tâche ECS | le conteneur d'API, pour l'en-tête `Authorization` et rien d'autre |
| `STRIPE_PUBLISHABLE_KEY` | la même source | le navigateur, rendue **par l'API** avec l'intention |

`stripe.config.ts` vérifie les préfixes `sk_`/`pk_` : l'inversion des deux
variables est l'erreur de déploiement la plus banale, et la seule qui envoie un
accès complet au compte Stripe du salon dans une réponse HTTP publique.

| | Clé mal préfixée | Configuration incomplète | Aucune clé |
|---|---|---|---|
| `staging`, `production` | refus de démarrer | refus de démarrer | refus de démarrer |
| `development`, `test` | refus de démarrer | démarre, paiements 503 | démarre, paiements 503 |

Le préfixe est la seule faute refusée **partout** : c'est celle qui expose le
compte. L'incomplétude, elle, n'immobilise que le déploiement — en local, elle
décrit un poste qui n'encaisse pas, ou dont l'environnement porte une variable
`STRIPE_*` héritée d'un autre projet. Refuser de démarrer pour cela aurait coûté
les sept autres modules, `AppModule` les montant tous.

## Ce que ce module ne fait pas

- **Il ne confirme pas un paiement carte.** Il crée une intention et rend de quoi
  la payer. Le passage du rendez-vous en `CONFIRMED` et du paiement en
  `SUCCEEDED` est l'affaire du webhook signé (#58) : la source de vérité du
  paiement par carte est Stripe reçue côté serveur, jamais la réponse du
  navigateur (payments-stripe §2). L'encaissement en **espèces**, lui, naît
  abouti — voir plus bas, il n'a pas de tiers à attendre.
- **Il ne passe pas un encaissement en `REFUNDED` non plus.** Il *ordonne* le
  remboursement (#63) et inscrit la trace du geste ; le statut et le cumul de la
  ligne `payments` restent écrits par `charge.refunded`, et par lui seul.

## Idempotence — trois mécanismes, du plus rapide au plus sûr

1. la ligne `payments` déjà présente, reprise en relisant son intention chez
   Stripe (le `client_secret` n'est pas conservé : rien côté serveur n'a à le
   relire) ;
2. la clé d'idempotence Stripe, dérivée du couple (établissement, rendez-vous),
   qui rend l'intention déjà créée quand deux requêtes se croisent ;
3. `@@unique([tenantId, appointmentId])`, qui tranche la course perdue par
   l'insertion et renvoie le perdant sur la ligne du gagnant.

Un double clic ne produit donc jamais deux débits, et ce n'est pas la vigilance
du service qui le garantit — c'est la base et le prestataire. Quand Stripe
refuse la clé parce qu'une requête portant la même est encore en vol
(`409 idempotency_error`), le service relit la ligne avant de conclure : le
deuxième clic reprend l'intention du premier au lieu de recevoir un 503.

## Reprise — ce qui se rejoue et ce qui est clos

| État de la ligne | Reprise |
|---|---|
| `PENDING` | oui — tunnel abandonné, onglet rouvert |
| `FAILED` | **oui** — la carte a été refusée, l'intention Stripe attend l'autre |
| `SUCCEEDED`, `REFUNDED`, `PARTIALLY_REFUNDED` | non, 409 |
| espèces au comptoir (pas d'intention) | non, 409 |

`FAILED` est le cas qui compte : `@@unique([tenantId, appointmentId])` interdit
d'inscrire une seconde ligne, donc le traiter comme clos rendrait le rendez-vous
impayable pour toujours — au comptoir compris.

La relecture chez Stripe ne sert d'ailleurs pas qu'à récupérer le
`client_secret` : si Stripe répond `succeeded` ou `canceled` pendant que notre
ligne dit encore `PENDING` — un webhook en retard —, c'est Stripe qui fait foi et
la reprise est refusée.


## La route de webhook

```
POST /api/v1/payments/webhooks/stripe
```

Non gardée, et c'est voulu : Stripe ne présente ni jeton, ni cookie, ni slug
d'établissement. **La signature du corps est la seule authentification**, et
tout le reste du module en découle.

| En-tête | |
|---|---|
| `Stripe-Signature` | `t=<horodatage>,v1=<hmac-sha256>` — obligatoire |

| Réponse | Quand |
|---|---|
| `200 {"received":true}` | livraison signée — traitée ou volontairement ignorée |
| `400 INVALID_WEBHOOK_SIGNATURE` | en-tête absent, illisible, hors tolérance, ou condensat qui ne correspond pas |
| `413 WEBHOOK_PAYLOAD_TOO_LARGE` | corps au-delà de 1 Mio |
| `503 WEBHOOK_NOT_CONFIGURED` | `STRIPE_WEBHOOK_SECRET` absent — impossible en déployé, l'application refuse alors de démarrer |

Le corps de réponse est **le même pour les quatre refus de signature**. La
différence ne renseignerait que celui qui sonde ; le motif exact part au journal.

## Les quatre points qui tiennent ce module

### 1. Le corps brut, donc l'exclusion du parseur JSON global

La signature porte sur les **octets**, pas sur l'objet qu'ils décrivent. Un
aller-retour par `JSON.parse` suffit à la faire échouer systématiquement.

`stripeWebhookRawBody()` est monté par `configureApp` — donc avant que Nest
n'enregistre `express.json()` dans `init()` — et borné à ce seul chemin. Il lit
la requête jusqu'à `end` ; `body-parser` sort alors sur son propre garde-fou
« body already parsed ». C'est la voie par laquelle body-parser cède la place à
un lecteur amont, pas un contournement.

Le montage vit dans `configureApp` et non dans `main.ts` parce que les tests
d'intégration câblent l'application par la même fonction : une exclusion qu'ils
n'auraient pas ferait passer au vert une vérification de signature qui n'existe
pas en production.

### 2. L'idempotence est une contrainte d'unicité

`processed_webhook_events(tenant_id, event_id)` est inséré **dans la même
transaction** que l'effet métier, et **avant** lui. Deux livraisons concurrentes
— Stripe n'en exclut aucune — se sérialisent sur l'unique : la première valide,
la seconde repart sans rien appliquer.

Ce n'est donc pas « ai-je déjà vu cet événement ? » suivi d'une écriture : entre
la lecture et l'écriture, l'autre livraison passe. Même conduite qu'ADR 0002
impose au moteur de réservation, et pour la même raison.

La table porte `tenant_id` là où payments-stripe §3 décrit `event_id PRIMARY
KEY` : tenant-isolation §1 n'admet d'exception que par ADR, et une table sans
colonne discriminante serait de toute façon refusée par l'extension de scoping.

**La marque enregistre ce qui a été appliqué, pas ce qui a été reçu** (#410).
C'est le point que #58 avait laissé en suspens, faute de connaître l'ordre
d'écriture que #57 allait fixer. Cet ordre est maintenant établi :
`PaymentsService.createIntentForAppointment` **crée l'intention chez Stripe
avant** d'inscrire la ligne `payments`. Il existe donc un état où Stripe connaît
un `pi_…` dont nous n'avons aucune trace — par une panne entre les deux
écritures, par une intention créée hors de notre tunnel (tableau de bord, lien de
paiement, Terminal), ou par un `charge.refunded` émis à la main.

Marquer un tel événement traité serait la perte silencieuse d'une confirmation
d'encaissement : le 200 est déjà parti, Stripe ne rejoue rien de lui-même, et le
renvoi manuel — seul recours — serait avalé comme un rejeu. La règle est donc :

| Cas | Marque | Pourquoi |
|---|---|---|
| aucune ligne `payments` ne porte la référence | **annulée avec la transaction** | l'événement reste applicable ; un renvoi l'appliquera |
| la ligne existe, le garde de statut décline | **posée** | ce n'est pas un événement sans destinataire, c'est une décision |
| `charge.dispute.created` sans ligne | **posée** | l'alerte *est* l'effet ; l'annuler ferait ré-alerter à chaque rejeu |

L'ordre d'écriture ne change pas : la marque s'insère toujours **avant** l'effet,
parce que c'est ce qui sérialise deux livraisons concurrentes. C'est l'annulation
de la transaction qui la retire, jamais un test préalable — un test préalable
aurait relâché le verrou et laissé l'effet s'appliquer deux fois. Le cas non
rattaché se journalise en `warn` : c'est le seul signal qu'un renvoi est à faire.

### 3. La résolution de l'établissement

Un webhook n'a ni jeton ni slug : ni `JwtAuthGuard` ni `TenantScopeMiddleware`
n'ont de quoi travailler. L'établissement se résout donc en deux temps :

1. **la base d'abord** — `payments.provider_payment_intent_id` ou
   `provider_charge_id`, par `prismaUnscoped`, projection réduite au seul
   `tenant_id`. C'est la seule lecture légitimement inter-tenant du module ;
2. **la métadonnée ensuite**, et seulement si aucune ligne ne porte la
   référence. Elle a été écrite par nous et la signature l'authentifie, mais
   elle ne prime jamais sur une ligne réelle : la suivre laisserait la marque
   d'idempotence dans un établissement et l'encaissement dans un autre.

Le traitement s'exécute ensuite dans `runWithTenant`, la porte que
`tenant-context.ts` prévoit pour les traitements hors requête HTTP.

### 4. Le 200 ne dépend pas du traitement

Le traitement part dans `WEBHOOK_QUEUE`. « Un webhook qui dépasse le délai est
rejoué et amplifie la charge » : la file coupe ce couplage. Son implémentation
est en mémoire — la chaîne EventBridge → SQS → Lambda du CDC §2.2 n'est pas
posée.

La contrepartie est à connaître, et elle n'est pas gratuite : **le 200 étant
déjà parti, Stripe ne rejoue rien.** Il ne redélivre que ce qu'il a vu échouer
— un non-2xx ou un délai dépassé. Un traitement qui échoue en base, ou un arrêt
brutal du processus, laisse donc l'encaissement `PENDING` et le rendez-vous non
confirmé, sans aucune nouvelle livraison. `processed_webhook_events` rend un
renvoi manuel depuis le tableau de bord Stripe inoffensif — c'est ce qui rend la
reprise possible —, mais elle ne la déclenche pas.

Deux garde-fous en attendant la file durable : `onApplicationShutdown` attend
les traitements en vol à chaque déploiement, et tout échec est journalisé en
`error` sous `InProcessWebhookQueue` — c'est une **alerte à traiter**, pas une
trace.

## Ce que le module fait de chaque événement

| Événement | Effet |
|---|---|
| `payment_intent.succeeded` | `payments` → `SUCCEEDED`, `captured_at`, `provider_charge_id` ; le rendez-vous `PENDING` → `CONFIRMED` |
| `payment_intent.payment_failed` | `payments` → `FAILED` si encore `PENDING`. **Le rendez-vous ne bouge pas** : une carte refusée ne prend pas son créneau à la cliente |
| `charge.refunded` | `refunded_amount_minor`, statut `REFUNDED` ou `PARTIALLY_REFUNDED` |
| `charge.dispute.created` | Alerte de niveau `error` vers l'équipe. Aucune écriture : le litige n'est pas traité automatiquement au MVP |
| tout autre type | Acquitté sans traitement — un refus le ferait rejouer indéfiniment |

Les transitions de `payment_intent.succeeded` sont des `updateMany` **filtrés
par statut** : c'est un test-et-pose atomique. Un rendez-vous annulé ne
ressuscite pas parce que le paiement aboutit, et un encaissement remboursé ne
redevient pas abouti parce qu'une livraison arrive en retard — auquel cas le
rendez-vous **n'est pas confirmé non plus** : confirmer un créneau sur un
paiement déjà rendu le bloquerait pour rien.

Le montant d'un remboursement vient de Stripe, qui fait foi, et n'est pas
plafonné par le code : `payments_refunded_amount_minor_check` le refuse en base.
La transaction est alors annulée et l'événement n'est pas marqué traité — rien
de faux n'est écrit. La reprise est en revanche **manuelle** : voir « Le 200 ne
dépend pas du traitement » ci-dessus.

## Aucune donnée de carte, nulle part

`stripe-webhook.types.ts` réduit l'objet Stripe à quatre faits typés dès la
lecture. La garantie n'est pas qu'on efface `last4`, `brand` ou `exp_month` :
c'est qu'**il n'existe nulle part où les mettre**. Un test le vérifie sur un
corps qui en porte.

Le secret de terminaison ne quitte pas `StripeConfig`, et aucun message d'erreur
ne cite jamais sa valeur.

## Configuration

Les trois valeurs vivent dans **une seule** `StripeConfig` (#410), lue au
démarrage et nulle part ailleurs.

| Variable | Absente en `development` / `test` | Absente en `staging` / `production` |
|---|---|---|
| `STRIPE_SECRET_KEY` | l'API démarre, l'encaissement répond 503 | **l'API refuse de démarrer** |
| `STRIPE_PUBLISHABLE_KEY` | l'API démarre, l'encaissement répond 503 | **l'API refuse de démarrer** |
| `STRIPE_WEBHOOK_SECRET` | l'API démarre, la route répond 503 | **l'API refuse de démarrer** |

Une valeur présente mais mal préfixée — `sk_`, `pk_`, `whsec_` — empêche le
démarrage dans **tous** les environnements : c'est le symptôme de deux variables
interverties, et l'inversion la plus probable place une clé `sk_…` là où on la
croit inoffensive.

Les deux capacités se jugent séparément : `isConfigured` parle des clés,
`isWebhookConfigured` du secret de terminaison. Un poste qui détient les clés de
test sans avoir lancé `stripe listen` est un cas ordinaire, et il doit pouvoir
créer une intention.

## Tests

| Suite | Ce qu'elle prouve |
|---|---|
| `__tests__/stripe-signature.spec.ts` | Le schéma de signature, la tolérance, la rotation de secret, le refus en temps constant |
| `__tests__/stripe-webhook.raw-body.spec.ts` | Le lecteur d'octets, sa borne, son indifférence aux non-`POST` |
| `__tests__/stripe-webhook.types.spec.ts` | La réduction des événements — et qu'aucune donnée de carte n'en ressort |
| `__tests__/stripe.config.spec.ts` | Les trois valeurs, la frontière entre elles, et la table « refuser de démarrer » |
| `__tests__/payments.boundaries.spec.ts` | Le confinement de `PRISMA_UNSCOPED`, l'unicité du fichier d'erreurs et de la porte de configuration |
| `__tests__/stripe-webhook.queue.spec.ts` | Le différé, l'absence de propagation d'erreur, l'attente à l'arrêt |
| `__tests__/stripe-webhook.service.spec.ts` | La résolution d'établissement et l'alerte de litige |
| `test/payments-webhook.integration-spec.ts` | La route servie, le corps **brut**, le 400 sans traitement, le 200 rendu avant le traitement |
| `test/payments-webhook.isolation-spec.ts` | Contre un vrai PostgreSQL : la frontière entre établissements, l'unicité qui tranche, la transaction qui fait bloc, et la marque qui n'est **pas** posée quand aucun encaissement ne porte la référence (#410) |
| `__tests__/pos.types.spec.ts` | Le témoin du vocabulaire du POS contre `enum SaleItemKind` |
| `__tests__/pos.totals.spec.ts` | Le calcul du ticket, centime par centime : sous-total, taxe en points de base, pourboire, bornes |
| `__tests__/products.service.spec.ts` | La devise imposée par l'établissement, l'unicité du code par tenant, l'absence de suppression |
| `__tests__/sales.service.spec.ts` | D'où vient chaque montant, les refus qui protègent la pièce comptable, la frontière du tenant sur les deux sources de prix |
| `test/pos.integration-spec.ts` | Les cinq routes servies, les gardes montées, `forbidNonWhitelisted` qui refuse un montant glissé dans un ticket |
| `test/pos-tenant.isolation-spec.ts` | Les cinq routes traversées : rien du voisin n'est lisible, modifiable ni facturable |
| `test/pos.isolation-spec.ts` | Contre un vrai PostgreSQL : la transaction du ticket, le scoping par l'extension, les `CHECK` de montant et les clés composites |
| `__tests__/cash-payments.service.spec.ts` | Le chemin espèces : l'absence d'import Stripe, d'où vient le montant, la rejouabilité, les refus, la frontière du tenant |
| `__tests__/payments-history.service.spec.ts` | Le tri, la fenêtre semi-ouverte, les filtres du rapprochement, la pagination |
| `__tests__/sales-history.service.spec.ts` | L'historique des ventes : opérateur, horodatage, montants — et l'absence des lignes |
| `__tests__/history-filters.spec.ts` | La frontière HTTP des deux historiques : bornes à offset explicite, critères absents, plafonds de pagination |
| `__tests__/refunds.service.spec.ts` | Les trois critères de #63 : total et partiel, le cumul borné dans les deux sens, la trace — et que le service n'écrit pas le statut de l'encaissement |

Les trois routes de #62 et celle de #63 n'ont pas de suite d'**intégration** ni
d'**isolation**
propre : `apps/api/test/` est hors de l'empreinte de fichiers du ticket, et une
issue de suivi porte leur ajout à `pos.integration-spec.ts`,
`pos-tenant.isolation-spec.ts` et `payments-tenant.isolation-spec.ts`. La
frontière du tenant est en attendant exercée à deux endroits : au niveau du
service, par les doubles qui reproduisent le scoping de l'extension Prisma, et
en bout de chaîne par la recette fonctionnelle de la PR — jeton du salon voisin,
404 attendu.

## Le POS — ce qui tient le total (#60)

Le troisième critère de #60 — « le total est recalculé côté serveur ; le montant
envoyé par le front ne fait jamais autorité » — ne repose sur aucun contrôle
défensif. Il tient par **quatre propriétés de forme**, chacune vérifiable :

| Où | Ce qui l'empêche |
|---|---|
| `dto/sale.dto.ts` | il n'existe aucun champ de montant sur une ligne `SERVICE` ou `PRODUCT`, ni de total sur le ticket ; `forbidNonWhitelisted` refuse en 400 celui qu'on y glisserait |
| `pos.types.ts` | `SaleLineRequest` est une union où seul `TIP` porte un montant — le domaine n'a pas de place pour les autres |
| `sales.service.ts` | chaque prix unitaire est relu à sa source : `ServicesService.byId` pour une prestation, le rayon pour un article |
| `sales_total_amount_minor_check` | PostgreSQL refuse un ticket dont le total ne somme pas ses trois parts |

Le **pourboire** est la seule valeur acceptée de l'appelant, et il l'est parce
qu'il n'existe dans aucune table à relire : une personne le décide au comptoir.
Le serveur le borne, refuse un flottant, et le porte en ligne distincte — jamais
fondu dans un prix (payments-stripe §5).

La **taxe** est composée à partir de `tenants.tax_rate_bps`, un entier en points
de base. Un taux fractionnaire aurait introduit un type inexact sur le chemin de
l'argent ; le calcul reste une multiplication d'entiers suivie d'une division
entière, exacte et reproductible.

## L'encaissement en espèces (#62)

`POST /api/v1/payments/cash` règle un rendez-vous au comptoir. Le corps ne porte
qu'un `appointmentId` : le montant est le prix figé à la réservation, l'opérateur
vient du jeton, l'établissement de la revendication signée.

### Ce qui tient le quatrième critère — « aucun appel Stripe »

Il ne tient pas à la vigilance d'une relecture, mais à la forme du module :

| Où | Ce qui l'empêche |
|---|---|
| `cash-payments.service.ts` | le fichier **n'importe rien** de `stripe/` — un test le vérifie sur ses spécificateurs d'import |
| son constructeur | deux dépendances, le dépôt et le journal. Ni `StripeConfig`, ni `STRIPE_GATEWAY` |
| `CashPaymentDraft` | pas de champ pour une référence de prestataire : il n'y en a aucune à écrire |

C'est pourquoi c'est un service **à part** et non une méthode de
`PaymentsService`, qui injecte les deux : y ajouter le chemin espèces aurait
laissé la passerelle à un `this.stripe.` près.

### Ce que la ligne porte, et en quoi elle diffère d'une carte

| | Carte | Espèces |
|---|---|---|
| Statut à l'écriture | `PENDING` — le webhook conclut | `SUCCEEDED` — la caisse fait foi |
| `captured_at` | posé par le webhook | posé à l'écriture |
| `provider_payment_intent_id` | `pi_…` | **`null`**, par construction |

### Rejouable, jamais deux fois

`@@unique([tenantId, appointmentId])` tranche : un deuxième clic rend le
**même** reçu — d'où un `200` et non un `201`, annoncer une création à chaque
fois aurait laissé croire à deux recettes. Un encaissement *autre* — intention
carte en cours, aboutie, remboursée — est refusé en `409` plutôt qu'écrasé : une
pièce comptable ne se remplace pas en silence. Le cas d'une carte `FAILED` que le
comptoir voudrait reprendre en espèces relève de #63, qui annulera l'intention.

### Statuts de rendez-vous acceptés

`CANCELLED` seul est refusé, en `422` : le créneau a été rendu, il n'y a pas de
prestation à vendre. `COMPLETED` et `NO_SHOW` sont au contraire le cas nominal du
comptoir — alors que le tunnel public les refuse, parce que rouvrir un débit en
ligne sur un dossier clos n'est surveillé par personne.

## Les deux historiques (#62)

| Route | Ce qu'elle lit | Rang |
|---|---|---|
| `GET /api/v1/sales` | ce qui a été **vendu** — tickets, opérateur, horodatage, montants | `STAFF` |
| `GET /api/v1/payments` | ce qui a été **encaissé** — moyen, statut, remboursements, références Stripe | `MANAGER` |

Deux lectures et non une : la relève de fin de journée est un geste de comptoir,
le rapprochement une décision de gestion. `GET /sales` rend les en-têtes **sans
leurs lignes** — une page de cinquante tickets n'a pas à charger cinq cents
lignes qu'aucun tableau n'affiche ; le détail se demande par `GET /sales/:id`.

**Fenêtre** : `from` inclus, `to` **exclu**, à offset explicite. C'est la seule
convention qui permette de poser deux journées de caisse bout à bout sans compter
deux fois l'encaissement de minuit. Une fenêtre à l'envers est refusée en `422`
plutôt que rendue en page vide : « aucune transaction ce jour-là » et « la
fenêtre est à l'envers » appellent deux conduites différentes.

### Le rapprochement, en deux ensembles

| Lignes | Ce qui en fait foi |
|---|---|
| `?method=CARD` | le relevé Stripe, par `providerChargeId` puis `providerPaymentIntentId` |
| `?method=CASH` | la caisse du salon — aucune référence de prestataire, par construction |

`refunded` accompagne chaque ligne : une transaction remboursée reste au relevé,
et un total qui l'ignorerait ne tomberait jamais juste.

## Le remboursement (#63)

`POST /api/v1/payments/:paymentId/refunds` rend l'argent, en totalité ou en
partie. Le corps porte un `reason` obligatoire et un `amountMinor` facultatif —
omis, c'est **tout le solde restant**, calculé côté serveur.

### `MANAGER`, et pas `STAFF`

Encaisser et rembourser ne sont pas symétriques. Le premier constate une vente
qui a lieu devant soi ; le second **sort de l'argent** de l'établissement, sans
contrepartie immédiate et sans que la caisse en garde trace. C'est une décision
de gestion, au même rang que fixer un prix de vente — et c'est le geste dont le
rang trop bas coûterait le plus cher, un remboursement parti chez le prestataire
ne se reprenant pas.

### Les trois temps, et pourquoi cet ordre-là

```
1. réserver   — transaction sérialisable : contrôle du cumul + ligne PENDING
2. ordonner   — appel au prestataire, clé d'idempotence = identifiant de la ligne
3. conclure   — SUCCEEDED + re_… si accepté, FAILED si refusé
```

Réserver **avant** d'ordonner est ce qui rend le deuxième critère vrai en
présence de pannes. L'inverse laisserait, sur un arrêt du processus entre les
deux, un remboursement sorti que notre cumul ignore — donc rendu une seconde
fois au clic suivant. Réservé d'abord, le pire cas est une somme momentanément
non remboursable : l'erreur du bon côté.

C'est aussi ce qui donne sa valeur à la clé d'idempotence — elle est
l'identifiant de la ligne, posé avant l'appel. Un renvoi après coupure réseau
porte la même clé et rend le remboursement déjà créé.

### Le seul échec qui relâche la réservation

Une reprise repart avec une **autre** ligne, donc une autre clé d'idempotence —
que le prestataire n'a aucun moyen de reconnaître comme un doublon. Relâcher une
réservation dont on ignore le sort rendrait donc l'argent deux fois. Le partage :

| Issue de l'appel | La réservation | Pourquoi |
|---|---|---|
| 4xx du prestataire, hors `429` | **relâchée** (`FAILED`) | reçue, comprise, rejetée : rien n'est sorti |
| remboursement créé `failed` ou `canceled` | **relâchée** (`FAILED`) | un 2xx n'est pas une acceptation ; l'objet existe et dit qu'il n'aboutira pas |
| `429`, 5xx, délai dépassé, coupure, corps illisible | **conservée** (`PENDING`) | le sort de l'ordre est inconnu |

`pending` chez le prestataire vaut `SUCCEEDED` chez nous : le mouvement est
engagé, seule sa confirmation tarde — et c'est `charge.refunded` qui la portera.

La distinction n'apparaît **pas** dans la réponse HTTP : `PaymentProviderRefusedError`
hérite de `PaymentProviderUnavailableError` et rend le même corps, le même 503.
La différencier ferait de cette route une sonde de l'état de notre compte.

Une réservation conservée immobilise sa somme jusqu'à un rapprochement manuel,
et l'alerte de niveau `error` est ce qui doit y amener quelqu'un. Coûteux, mais
réparable — là où un double remboursement ne l'est pas.

### Le perdant d'une course recommence

Un échec de sérialisation (`40001`, `P2034`) sur la transaction de réservation
est **réessayé**, trois fois, avec une attente croissante et dispersée. C'est la
conduite que `SERIALIZABLE` appelle, et elle est sans danger : la transaction
n'écrit qu'en base et ne fait bouger aucun argent — une tentative avortée n'a,
par définition d'un `ROLLBACK`, rien laissé derrière elle. La perdante relit
alors la réservation de la gagnante, donc le bon cumul.

### Ce qui tient « le cumul ne dépasse jamais le montant capturé »

| Où | Ce qui l'empêche |
|---|---|
| `refunds.repository.ts` | le contrôle et la réservation sont dans **une** transaction `Serializable` : deux comptoirs simultanés ne peuvent pas conclure tous deux que le geste est possible |
| `refunds.service.ts` | l'encaissement doit être `SUCCEEDED` ou `PARTIALLY_REFUNDED`, en `CARD`, avec une référence d'intention |
| `payment_refunds_amount_minor_check` | PostgreSQL refuse un montant nul ou négatif |

`Serializable` et non le défaut : la borne porte sur une **somme de lignes**, pas
sur une colonne, donc aucun `CHECK` ne peut l'exprimer. `READ COMMITTED` prend un
instantané par instruction et les deux transactions ne se voient jamais. Même
conduite qu'ADR 0002 impose au moteur de réservation, et pour la même raison.

Le cumul retenu est le **plus grand des deux comptes** qui existent, et chacun
couvre l'angle mort de l'autre :

| Situation | Le compte qui dit vrai |
|---|---|
| notre demande vient de partir, `charge.refunded` n'est pas arrivé | nos lignes `PENDING` et `SUCCEEDED` |
| un remboursement fait à la main dans le tableau de bord du prestataire | `payments.refunded_amount_minor` |

### La trace — qui, quand, pourquoi

| Colonne de `payment_refunds` | Le critère |
|---|---|
| `requested_by_user_id` | **qui** — du jeton vérifié, jamais du corps |
| `created_at` | **quand** — en UTC |
| `reason` | **pourquoi** — obligatoire, 3 à 500 caractères |

Une table et non trois colonnes sur `payments` : le remboursement partiel étant
au périmètre, un encaissement peut en recevoir plusieurs, et des colonnes
n'auraient gardé que le dernier.

**Le motif ne part pas chez le prestataire.** Il est saisi par une personne et
peut nommer la cliente ; le champ `reason` de Stripe n'accepte de toute façon que
trois valeurs énumérées. Les métadonnées de l'ordre ne portent que
`tenantId`, `paymentId` et `refundId` — des identifiants opaques (CDC §5.1). Il
ne part pas non plus au journal structuré, pour la même raison.

### Ce que la route ne fait pas

Elle **n'écrit ni `payments.status` ni `payments.refunded_amount_minor`**. Ils
sont l'affaire de `charge.refunded`, et de lui seul (payments-stripe §6) : la
réponse rend la *demande*, pas son effet. `RefundsRepository` n'expose d'ailleurs
aucune écriture sur `payments` — un test le vérifie sur sa surface.

Elle n'annule pas non plus une intention `FAILED` — le cas que #62 renvoyait
ici. Une annulation n'est pas un remboursement : rien n'a été capturé, et
`PaymentNotRefundableError` le dit en 422. Une issue de suivi porte ce geste.

## Dette connue

- **`PaymentsRepository` lit la table `appointments` directement**, pour le prix
  figé à la réservation. Le chemin conforme serait un appel de service
  (`AppointmentsService`, api-module §3), mais ce module n'expose aujourd'hui
  aucune lecture par identifiant. La lecture est bornée à trois colonnes non
  personnelles et n'écrit rien ; une issue de suivi porte la reprise.
- **`AppointmentsModule` n'est pas importé.** La confirmation du rendez-vous est
  écrite dans la même transaction que l'encaissement ; passer par un service
  d'un autre module l'en sortirait, et un paiement abouti pourrait coexister
  avec un rendez-vous resté `PENDING`. Dette assumée vis-à-vis d'api-module §3,
  portée par une issue de suivi.
- **La file est en mémoire, et sans reprise.** Un traitement qui échoue après le
  200 n'est rejoué par personne : ni par la file, ni par Stripe. Seul un renvoi
  manuel depuis le tableau de bord le rattrape. La chaîne durable du CDC §2.2
  (SQS, accusé de consommation, file d'attente morte) est ce qui referme ce
  trou ; elle est hors de l'empreinte de #58 et porte sa propre issue de suivi.
- **`PosRepository` lit `appointments` et `tenants` directement**, pour une
  existence et pour deux colonnes de paramétrage. Même dette, et même
  justification, que la lecture d'`appointments` par `PaymentsRepository` :
  aucune écriture, aucune colonne personnelle, et pas de lecture par identifiant
  à appeler chez le voisin. Les prestations, elles, passent bien par
  `ServicesService` — la voie conforme.
- **`tenants.tax_rate_bps` n'a aucune route pour être réglé.** Le paramétrage
  fiscal du salon relève du back-office, pas du POS : la colonne existe pour que
  le total soit calculable côté serveur, sa saisie viendra avec l'écran qui la
  porte. À `0` — la valeur par défaut — aucun ticket ne porte de ligne de taxe.
- **`payments` n'a pas de colonne d'opérateur.** payments-stripe §4 demande
  d'enregistrer une vente en espèces « avec `method: 'cash'`, l'opérateur,
  l'horodatage et le montant ». Trois des quatre sont écrits en base ; l'opérateur
  part au **journal structuré**, faute de colonne où l'écrire. L'ajouter —
  `payments.operator_user_id`, `NOT NULL` sur les lignes `CASH` — est une
  migration, hors de l'empreinte de #62 ; une issue de suivi la porte. Ce n'est
  pas l'équivalent d'une écriture : un journal se purge, une colonne se
  rapproche.
- **`payments` n'a pas de lien vers `sales`.** Un règlement se rattache à un
  **rendez-vous**, pas à un ticket : `POST /payments/cash` prend un
  `appointmentId`, et `@@unique([tenantId, appointmentId])` en tire son
  idempotence. Une vente retail autonome — ticket sans rendez-vous — n'a donc
  aujourd'hui aucun moyen d'être réglée par cette route : il n'y a rien à quoi
  rattacher sa ligne, et deux ventes autonomes réglées en espèces porteraient
  toutes deux `appointment_id = NULL`, indiscernables. `payments.sale_id` est la
  colonne qui ferme ce trou, même migration et même issue de suivi que
  ci-dessus.
- **Un ticket ne s'encaisse toujours pas.** #60 compose l'addition, #62 règle le
  rendez-vous ; régler le **ticket** attend la colonne ci-dessus. Un
  remboursement se rattache donc à un encaissement de rendez-vous, jamais à une
  vente retail autonome — qui n'a aujourd'hui pas d'encaissement à rembourser.
- **Une réservation `PENDING` orpheline immobilise sa somme.** Deux causes : un
  arrêt du processus entre l'inscription de la ligne et la réponse du
  prestataire, ou une issue ambiguë de l'appel — voir « Le seul échec qui
  relâche la réservation ». Le montant reste réservé, donc non remboursable,
  jusqu'à ce qu'une reprise la tranche. C'est délibérément l'erreur du bon côté
  — l'inverse rendrait l'argent deux fois — mais la reprise est **manuelle** au
  MVP : relire les remboursements du prestataire et conclure les lignes qui leur
  correspondent. Une issue de suivi porte le travail périodique qui le ferait
  seul.
- **Aucune route ne lit les remboursements d'un encaissement.** La trace existe
  en base et `GET /payments` rend le cumul par ligne, mais le détail — qui,
  quand, pourquoi, geste par geste — n'a pas de lecture HTTP. L'écran qui la
  demandera viendra avec sa route ; une issue de suivi la porte.
- **Une intention `FAILED` ne s'annule pas.** #62 renvoyait à #63 pour
  transformer une carte refusée en règlement espèces ; c'est une *annulation*
  d'intention, pas un remboursement — rien n'a été capturé, et la route de
  remboursement le refuse en 422. Même issue de suivi.
