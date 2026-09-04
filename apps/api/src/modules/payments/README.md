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

À venir : le montage d’Elements côté tunnel (#59), le paiement en espèces et
l’historique des ventes (#62), les remboursements initiés au comptoir (#63).

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `POST` | `/api/v1/public/:tenantSlug/payments/intents` | — (ouverte) |
| `POST` | `/api/v1/stripe/webhook` | — (signature Stripe) |
| `GET` | `/api/v1/products` | `STAFF` |
| `POST` | `/api/v1/products` | `MANAGER` |
| `PATCH` | `/api/v1/products/:id` | `MANAGER` |
| `POST` | `/api/v1/sales` | `STAFF` |
| `GET` | `/api/v1/sales/:id` | `STAFF` |

Les cinq routes du POS sont gardées et **n'ont aucune surface publique** : un
ticket de caisse est une pièce comptable du salon, son rayon une donnée
commerciale. La ligne entre `STAFF` et `MANAGER` passe où le CDC la met —
composer une addition et lire le rayon sont des gestes de comptoir, fixer un
prix de vente est une décision.

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

- **Il ne confirme rien.** Il crée une intention et rend de quoi la payer. Le
  passage du rendez-vous en `CONFIRMED` et du paiement en `SUCCEEDED` est
  l'affaire du webhook signé (#58) : la source de vérité du paiement est Stripe
  reçue côté serveur, jamais la réponse du navigateur (payments-stripe §2).
- **Il n'encaisse pas au comptoir.** Espèces, produits retail et lignes de vente
  sont #60 et #62, sur une surface gardée.
- **Il ne rembourse pas.** #63.

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

Le secret de terminaison ne quitte pas `StripeWebhookConfig`, et aucun message
d'erreur ne cite jamais sa valeur.

## Configuration

| Variable | Absente en `development` / `test` | Absente en `staging` / `production` |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | l'API démarre, la route répond 503 | **l'API refuse de démarrer** |

Un secret présent mais non préfixé `whsec_` empêche le démarrage dans **tous**
les environnements : c'est le symptôme de deux variables interverties, et
l'inversion la plus probable place ici une clé `sk_…`.

## Tests

| Suite | Ce qu'elle prouve |
|---|---|
| `__tests__/stripe-signature.spec.ts` | Le schéma de signature, la tolérance, la rotation de secret, le refus en temps constant |
| `__tests__/stripe-webhook.raw-body.spec.ts` | Le lecteur d'octets, sa borne, son indifférence aux non-`POST` |
| `__tests__/stripe-webhook.types.spec.ts` | La réduction des événements — et qu'aucune donnée de carte n'en ressort |
| `__tests__/stripe-webhook.config.spec.ts` | La table « refuser de démarrer » |
| `__tests__/stripe-webhook.queue.spec.ts` | Le différé, l'absence de propagation d'erreur, l'attente à l'arrêt |
| `__tests__/stripe-webhook.service.spec.ts` | La résolution d'établissement et l'alerte de litige |
| `test/payments-webhook.integration-spec.ts` | La route servie, le corps **brut**, le 400 sans traitement, le 200 rendu avant le traitement |
| `test/payments-webhook.isolation-spec.ts` | Contre un vrai PostgreSQL : la frontière entre établissements, l'unicité qui tranche, la transaction qui fait bloc |
| `__tests__/pos.types.spec.ts` | Le témoin du vocabulaire du POS contre `enum SaleItemKind` |
| `__tests__/pos.totals.spec.ts` | Le calcul du ticket, centime par centime : sous-total, taxe en points de base, pourboire, bornes |
| `__tests__/products.service.spec.ts` | La devise imposée par l'établissement, l'unicité du code par tenant, l'absence de suppression |
| `__tests__/sales.service.spec.ts` | D'où vient chaque montant, les refus qui protègent la pièce comptable, la frontière du tenant sur les deux sources de prix |
| `test/pos.integration-spec.ts` | Les cinq routes servies, les gardes montées, `forbidNonWhitelisted` qui refuse un montant glissé dans un ticket |
| `test/pos-tenant.isolation-spec.ts` | Les cinq routes traversées : rien du voisin n'est lisible, modifiable ni facturable |
| `test/pos.isolation-spec.ts` | Contre un vrai PostgreSQL : la transaction du ticket, le scoping par l'extension, les `CHECK` de montant et les clés composites |

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
- **Un ticket ne s'encaisse pas encore.** #60 compose l'addition ; le règlement
  en espèces, l'historique filtrable et le rapprochement sont l'objet de #62, et
  les remboursements de #63.
