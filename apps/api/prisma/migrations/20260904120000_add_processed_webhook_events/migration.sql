-- Journal des événements de webhook Stripe déjà traités — #58, payments-stripe §3.
--
-- Stripe rejoue ses événements : à chaque réponse non-2xx, à chaque délai
-- dépassé, et parfois sans raison visible. Cette table est ce qui rend le
-- rejeu inoffensif. Sans elle, un second `charge.refunded` rembourserait deux
-- fois dans notre comptabilité, et un second `payment_intent.succeeded`
-- réémettrait la confirmation d'un rendez-vous déjà confirmé.
--
-- ## L'insertion *est* le verrou, et c'est tout le propos
--
-- La ligne s'insère dans la **même transaction** que l'effet métier. Deux
-- livraisons concurrentes du même événement — Stripe n'en exclut aucune — se
-- sérialisent sur l'unique `(tenant_id, event_id)` : la première valide, la
-- seconde échoue en violation d'unicité et son `ROLLBACK` annule l'effet
-- qu'elle avait commencé à écrire.
--
-- Ce n'est donc pas « ai-je déjà vu cet événement ? » suivi d'une écriture :
-- entre la lecture et l'écriture, l'autre livraison passe. C'est la même
-- conduite que celle qu'ADR 0002 impose au moteur de réservation, pour
-- exactement la même raison — la base tranche, le code traduit.
--
-- ## Pourquoi `tenant_id`, alors que le skill décrit `event_id PRIMARY KEY`
--
-- payments-stripe §3 décrit `processed_webhook_events(event_id PRIMARY KEY,
-- processed_at)`. Cette table en diffère sur un point, et le durcit :
-- tenant-isolation §1 n'exempte de `tenant_id` que `tenants`, les tables de
-- référence globales et les tables techniques, et toute autre exception se
-- documente en ADR. Une table métier sans colonne discriminante serait par
-- ailleurs refusée par l'extension de scoping tant qu'elle n'est pas déclarée
-- globalement légitime — c'est-à-dire rendue lisible par tous les
-- établissements à la fois.
--
-- L'unicité porte donc sur le couple. La garantie ne s'en trouve pas
-- affaiblie : le tenant est résolu depuis les métadonnées de l'intention,
-- écrites par nous à la création et authentifiées par la signature du corps,
-- si bien qu'un même `evt_…` retombe toujours sur le même établissement. Un
-- événement dont le tenant ne se résout pas n'est jamais traité, et n'a donc
-- aucun effet à rendre idempotent.
--
-- ## Ce que la table ne stocke pas
--
-- Ni corps d'événement, ni charge utile Stripe, ni dernier quatuor de
-- chiffres : rien qui ressemble à une donnée de carte n'y entre
-- (payments-stripe §1), et conserver un événement complet reviendrait à tenir
-- le journal que ce même §1 interdit. `event_type` suffit à la réconciliation
-- du CDC §4.9 ; le reste se relit chez Stripe, qui en est la source de vérité.
--
-- Pas de colonne `processed_at` non plus : la ligne n'existe que si la
-- transaction de traitement a validé, donc `created_at` **est** l'instant de
-- traitement. Deux colonnes qui portent la même date finissent par diverger.
--
-- ## Purement additive, et réversible
--
-- Une table neuve, deux index, une clé étrangère. Aucune colonne existante
-- n'est retypée, aucune ligne n'est réécrite, aucun verrou long n'est pris —
-- `CREATE TABLE` ne touche pas les tables voisines. L'inverse exact est le
-- retrait de la table, et il ne perd que la trace des événements déjà traités.
--
-- Le retour arrière du **code** seul est sans effet de bord : la version
-- antérieure de l'application ignore cette table, et n'écrit donc rien qui
-- l'attende. Le seul coût d'un aller-retour est de rendre à nouveau rejouables
-- les événements déjà consommés — sans perte de données, puisque les effets
-- métier, eux, sont écrits ailleurs.
--
-- ## Aucune clé étrangère vers `payments` ni `appointments`
--
-- Délibéré. Cette table est un journal de livraisons, pas une ligne de
-- comptabilité : elle enregistre « cet événement-là a été consommé », y compris
-- pour un `charge.dispute.created` que le MVP se contente d'alerter sans rien
-- écrire ailleurs (payments-stripe §6). Une clé étrangère l'aurait rendue
-- insérable seulement quand l'événement porte sur une ligne connue, et aurait
-- donc laissé rejouables exactement les événements qu'on ne sait pas traiter.
--
-- ## Invariants
--
-- `src/infrastructure/database/__tests__/prisma-schema.spec.ts` relit ce texte :
-- `tenant_id` non nullable et rattaché à `tenants`, index tous préfixés de
-- `tenant_id`, unique composite, identifiant UUID, `created_at` / `updated_at`
-- non nullables en `TIMESTAMPTZ`, migration sans retrait, aucune colonne
-- susceptible de porter une donnée de carte.

-- CreateTable
CREATE TABLE "processed_webhook_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhook_events_tenant_id_event_id_key" ON "processed_webhook_events"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "processed_webhook_events_tenant_id_created_at_idx" ON "processed_webhook_events"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "processed_webhook_events" ADD CONSTRAINT "processed_webhook_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
