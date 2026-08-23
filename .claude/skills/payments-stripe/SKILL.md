---
name: payments-stripe
description: Frontière de conformité PCI-DSS et intégration Stripe — tokenisation côté client, webhooks signés et idempotents, encaissement au comptoir (POS), remboursements, réconciliation. À charger avant toute modification de apps/api/src/modules/payments, du checkout front, ou dès qu'une tâche parle de paiement, carte, encaissement, Stripe ou remboursement.
---

# Paiements et conformité PCI

Le CDC §4.9 délègue le traitement des cartes à un prestataire PCI-DSS niveau 1.
Cela ramène notre obligation à une **auto-évaluation SAQ A**, la plus légère.
Cette réduction de périmètre est conditionnelle : elle disparaît à la seconde où
un numéro de carte traverse notre code.

## 1. La ligne à ne jamais franchir

**Aucune donnée de carte ne doit atteindre notre backend, nos logs, notre base
ou nos navigateurs sous notre contrôle direct.**

Concrètement, sont interdits :

- Un champ `<input>` maison pour le numéro de carte, le CVC ou l'expiration.
- Le passage d'un PAN, d'un CVC ou d'une piste magnétique dans un appel à notre API.
- Le stockage d'un PAN, même chiffré, même partiel au-delà des 4 derniers chiffres.
- L'enregistrement d'un corps de requête Stripe complet dans les logs.

Ce que nous avons le droit de conserver : l'identifiant Stripe
(`payment_intent_id`, `customer_id`, `payment_method_id`), la marque de carte,
les 4 derniers chiffres, le mois/année d'expiration, le montant, la devise et le
statut. Rien d'autre.

Si une demande implique de manipuler un numéro de carte, la refuser et expliquer
qu'elle ferait basculer le projet de SAQ A vers SAQ D, avec un audit annuel.

## 2. Flux de paiement en ligne (réservation client)

1. Le client valide sa réservation. Notre API crée le rendez-vous en `pending`
   et un `PaymentIntent` Stripe, et renvoie le `client_secret`.
2. Le navigateur monte **Stripe Elements** (ou le Payment Element). Les champs
   carte sont des iframes servies par Stripe — le DOM de notre page ne les lit pas.
3. Le navigateur confirme le paiement directement auprès de Stripe.
4. Stripe appelle notre **webhook**. C'est le webhook, et lui seul, qui fait
   passer le rendez-vous en `confirmed` et déclenche la notification.

Le point 4 est structurant : ne jamais confirmer une réservation sur la seule
réponse du navigateur. Le client peut fermer l'onglet, perdre le réseau, ou
falsifier l'appel. La source de vérité du paiement est Stripe, reçue côté serveur.

## 3. Webhooks

```ts
const event = stripe.webhooks.constructEvent(
  req.rawBody,                 // le corps BRUT, pas le JSON parsé
  req.headers['stripe-signature'],
  process.env.STRIPE_WEBHOOK_SECRET,
);
```

- La route webhook doit recevoir le **corps brut**. Dans NestJS, l'exclure du
  parseur JSON global, sinon la vérification de signature échoue toujours.
- Une signature invalide → **400 immédiat**, aucun traitement, log d'alerte.
- **Idempotence obligatoire.** Stripe rejoue les événements. Une table
  `processed_webhook_events(event_id PRIMARY KEY, processed_at)` avec insertion
  dans la même transaction que le traitement métier : si l'insertion échoue en
  doublon, l'événement a déjà été traité, on répond 200 sans rien refaire.
- Répondre **200 rapidement**. Le traitement long part en file SQS. Un webhook
  qui dépasse le délai est rejoué et amplifie la charge.
- Événements à traiter au MVP : `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`.

## 4. Encaissement au comptoir (POS)

Le CDC §1.4 inclut un POS de base : services + produits retail, carte ou espèces.

- **Espèces** : aucun appel Stripe. Enregistrer la vente avec
  `method: 'cash'`, l'opérateur, l'horodatage et le montant. C'est la caisse qui
  fait foi lors du rapprochement.
- **Carte au comptoir** : Stripe Terminal si un lecteur physique est présent, ou
  un lien de paiement envoyé au client. Ne jamais saisir un numéro de carte dicté
  par le client dans un formulaire — c'est exactement ce que SAQ A interdit.
- Une vente POS peut être **liée à un rendez-vous** (`appointment_id`) ou
  autonome (vente retail). Le modèle doit accepter les deux depuis le départ.
- Un ticket regroupe plusieurs lignes (`sale_items`) : services rendus et produits.
  Le total est recalculé côté serveur ; le montant envoyé par le front n'est
  jamais fait autorité.

## 5. Montants

- **Entiers uniquement**, dans la plus petite unité de la devise (centimes pour
  l'euro, ariary entier pour MGA). Jamais de `float`, jamais de `Number` JS pour
  un calcul de total.
- Chaque montant est accompagné de son `currency` ISO 4217. Ne jamais supposer
  une devise par défaut.
- Attention aux devises sans sous-unité (JPY, MGA) : la conversion « ×100 » est
  fausse pour elles. Utiliser la table des exposants de Stripe.
- Taxes et pourboires sont des lignes distinctes, jamais fondues dans le prix.

## 6. Remboursements et litiges

- Le remboursement passe par l'API Stripe et se reflète en base via le webhook
  `charge.refunded`, pas par une écriture optimiste.
- Remboursement partiel accepté ; le cumul des remboursements ne peut jamais
  dépasser le montant capturé — le vérifier côté serveur.
- Un remboursement exige une trace : qui, quand, pourquoi. Le CDC §4.9 demande
  une journalisation permettant la réconciliation avec les relevés Stripe.
- Un litige (`charge.dispute.created`) déclenche une alerte vers l'équipe ; il
  n'est pas traité automatiquement au MVP.

## 7. Clés, environnements, tests

- Clés de test en dev et recette, clés live en production uniquement. La clé
  secrète et le secret de webhook vivent dans **AWS Secrets Manager**, jamais
  dans le code ni dans une variable de build front.
- La clé **publiable** est la seule qui a le droit d'atteindre le navigateur.
- Les tests utilisent les cartes de test Stripe et le mode `stripe listen` en
  local ; aucun test n'appelle l'environnement live.
- Tester au minimum : succès, échec, 3D Secure requis, webhook rejoué deux fois
  (idempotence), signature invalide, remboursement partiel.

## 8. Hors périmètre MVP

Cartes cadeaux, forfaits, abonnements, pourboires multi-staff et gestion de caisse
sont explicitement **post-MVP** (CDC §1.4). Ne pas les préparer « au cas où » :
le modèle de données doit rester simple. Ouvrir une issue `post-mvp` si le besoin
remonte.
