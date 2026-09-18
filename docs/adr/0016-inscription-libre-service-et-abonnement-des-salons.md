# ADR 0016 — Inscription d'un salon en libre-service, et abonnement à la plateforme

- **Statut** : Accepté
- **Date** : 2026-09-18
- **Décideurs** : PO (décision du 18/09/2026)
- **Contexte CDC** : §1.2 proposition de valeur, §1.4 périmètre, §2.4 le Tenant
  comme entité racine, §4.9 paiements (PCI-DSS)
- **Amende** : [ADR 0012](0012-operateur-plateforme-hors-tenant.md) — sur un
  point seulement, l'inscription en libre-service

## Contexte

Le produit est un SaaS vendu à des salons. L'ADR 0012 a donné à l'éditeur une
console pour **ouvrir** un salon, et a consigné l'arbitrage du PO du 16/09 :
« pas d'inscription en libre-service ». Le 18/09, le PO a revu cet arbitrage. Un
gérant doit pouvoir, depuis la page d'accueil :

1. s'inscrire et décrire son salon ;
2. s'abonner — le salon **paie** la plateforme ;
3. recevoir son back-office et sa page de réservation, où son équipe et ses
   clientes travaillent.

Le PO a fixé l'offre : **une seule**, **29 € par mois**, **14 jours d'essai
gratuit**, et la carte **enregistrée dès l'inscription**, débitée à la fin de
l'essai.

Deux lectures du CDC sont à lever :

- §1.4 range « abonnements et forfaits » hors périmètre. Il s'agit de ce qu'un
  salon vend à **ses clientes** (la fonctionnalité de Booker qui porte ce nom),
  pas de ce que le salon paie à l'éditeur. Le CDC ne dit rien du second : ni
  dedans, ni dehors. Cet ADR ne l'y fait pas entrer par la bande, il le décide.
- La skill `payments-stripe` §8 reprend la même exclusion, pour la même raison.

## Options envisagées

### Option A — Créer le salon après le paiement

Garder les données de l'inscription en attente (table dédiée), n'ouvrir le
salon qu'à la réception du webhook `checkout.session.completed`.

Écartée : il faut stocker une empreinte de mot de passe hors de `users`, dans une
table sans `tenant_id` de plus (voir ADR 0012 sur ce que coûte chaque exception),
et le webhook n'atteint pas un poste de développement. L'adresse du salon (son
slug) n'est pas non plus réservée pendant le paiement.

### Option B — Créer le salon fermé, l'ouvrir quand Stripe confirme

Le salon et son administrateur naissent ensemble, salon `PENDING`, et la session
de l'administrateur s'ouvre aussitôt. Le paiement de l'essai se fait sous cette
session ; le salon s'ouvre quand Stripe annonce l'abonnement `trialing`.

Retenue. Le slug est réservé dès l'inscription ; un paiement abandonné se reprend
depuis l'écran d'abonnement, sans rien ressaisir ; rien n'est stocké hors des
tables existantes.

### Option C — Stripe Billing avec des pages maison

Collecter la carte avec Stripe Elements dans nos pages, créer l'abonnement par
l'API.

Écartée : Checkout et le portail client, hébergés par Stripe, couvrent
l'enregistrement de la carte, les factures, la mise à jour de la carte et la
résiliation, sans une ligne d'interface de notre côté, et gardent le périmètre
PCI en SAQ A (payments-stripe §1).

## Décision

**Option B**, avec Stripe Checkout et le portail client.

### Données

`tenants` reçoit l'état de sa facturation — aucune table neuve :

| Colonne | Rôle |
|---|---|
| `billing_status` | `MANAGED`, `PENDING`, `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELED` |
| `trial_ends_at`, `current_period_ends_at` | les échéances annoncées par Stripe |
| `stripe_customer_id`, `stripe_subscription_id` | identifiants Stripe, uniques |
| `stripe_checkout_session_id` | la dernière session de paiement, relue au retour |

`MANAGED` est la valeur par défaut : les salons ouverts par la console, et tous
ceux d'avant cet ADR, ne sont pas facturés et restent ouverts. La console de
l'ADR 0012 continue d'exister et d'ouvrir des salons `MANAGED`.

### Ce qui ferme un salon

Seuls `PENDING` (l'essai n'a jamais démarré) et `CANCELED` (résilié, impayé
définitif) ferment le salon. `PAST_DUE` le laisse ouvert pendant les relances de
Stripe. Un salon fermé :

- refuse la réservation publique — créneaux et prise de rendez-vous — en **409**
  `SALON_BOOKING_CLOSED` ; sa vitrine reste lisible, parce que l'écran de
  connexion du back-office en a besoin ;
- refuse son back-office en **402** `SUBSCRIPTION_REQUIRED` — la garde
  `TenantBillingGuard`, posée par `Auth`, `AuthAtLeast` et `AuthWith` juste après
  `JwtAuthGuard`. Seuls `GET /auth/me` et les routes `/billing/*` restent
  ouvertes (`@AllowUnpaidTenant()`) : c'est par elles que l'administrateur
  rétablit l'abonnement.

La garde lit l'état par établissement avec un cache de vingt secondes, vidé par
le processus qui écrit la facturation.

### Parcours

1. `POST /v1/signup` (public, trois par minute et par IP) crée le salon
   `PENDING` et son administrateur — mot de passe et accord sur les données
   posés par le gérant lui-même —, et ouvre sa session.
2. `POST /v1/billing/checkout` ouvre une session Stripe Checkout : un client
   Stripe par salon, l'offre unique, `trial_period_days=14`,
   `payment_method_collection=always`, et `metadata.tenantId` sur la session et
   sur l'abonnement. Pas de second essai pour un salon résilié.
3. Stripe annonce l'abonnement par `customer.subscription.created|updated|deleted`
   — trois événements ajoutés à la chaîne de webhooks existante, signée et
   idempotente. Le salon est résolu par `metadata.tenantId`.
4. `GET /v1/billing/subscription` relit l'abonnement **chez Stripe** à chaque
   affichage de l'écran d'abonnement, et l'applique par la même fonction que le
   webhook. C'est ce qui rend l'écran juste au retour du paiement même quand le
   webhook n'est pas encore arrivé — ou n'arrivera jamais, sur un poste de
   développement. Stripe reste la seule source de vérité : rien ne déduit un
   paiement de la réponse du navigateur.
5. `POST /v1/billing/portal` ouvre le portail client : carte, factures,
   résiliation.

Le prix est décrit à la volée depuis `SUBSCRIPTION_PLAN` (`@spa/shared`), sauf si
`STRIPE_SUBSCRIPTION_PRICE_ID` désigne un prix créé dans Stripe — ce qui permet
d'en changer sans redéploiement.

## Conséquences

**Ce que cela facilite.** Un salon s'ouvre sans intervention de l'éditeur, et
paie. La console garde son rôle pour les salons accompagnés. Aucune donnée de
carte ne touche notre code.

**Ce que cela coûte.**

- **Une lecture de plus par requête du back-office**, amortie par le cache de la
  garde. Une instance peut voir un changement de facturation avec vingt secondes
  de retard.
- **Des salons `PENDING` abandonnés** occupent leur slug. Aucune purge n'est
  prévue ; la console les montre, avec leur statut.
- **Le portail client doit être configuré** dans le tableau de bord Stripe (mode
  test et mode live) avant d'être ouvert : sans configuration, Stripe refuse la
  session et l'écran le dit.
- **Le webhook de production doit s'abonner** aux trois événements
  `customer.subscription.*`, en plus des quatre de l'encaissement.
- **Aucun e-mail n'est envoyé par la plateforme** à l'inscription : les reçus et
  rappels de fin d'essai sont ceux de Stripe, à activer dans son tableau de bord.

**Ce que cela ferme.** L'idée qu'un salon puisse être ouvert en libre-service
sans moyen de paiement enregistré : l'essai exige la carte, par décision du PO.
