-- Abonnement du salon à la plateforme — ADR 0016.
--
-- Un salon qui s'inscrit seul paie un abonnement mensuel, après un essai
-- gratuit dont la carte est enregistrée par Stripe Checkout. Cette migration
-- pose, sur `tenants`, ce qu'il faut pour savoir si le salon est ouvert :
--
-- | Colonne | Ce qu'elle porte |
-- |---|---|
-- | `billing_status` | l'état de la facturation — `MANAGED` par défaut |
-- | `trial_ends_at` | la fin de l'essai, telle que Stripe l'annonce |
-- | `current_period_ends_at` | la prochaine échéance |
-- | `stripe_customer_id`, `stripe_subscription_id` | les identifiants Stripe, uniques |
-- | `stripe_checkout_session_id` | la dernière session de paiement, relue au retour |
--
-- Additive : les salons existants — seed, recette, console — prennent
-- `MANAGED` et restent ouverts. Aucune donnée de carte n'est stockée
-- (payments-stripe §1) : seulement des identifiants Stripe.

-- CreateEnum
CREATE TYPE "TenantBillingStatus" AS ENUM ('MANAGED', 'PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "billing_status" "TenantBillingStatus" NOT NULL DEFAULT 'MANAGED',
ADD COLUMN     "current_period_ends_at" TIMESTAMPTZ(6),
ADD COLUMN     "stripe_checkout_session_id" VARCHAR(128),
ADD COLUMN     "stripe_customer_id" VARCHAR(64),
ADD COLUMN     "stripe_subscription_id" VARCHAR(64),
ADD COLUMN     "trial_ends_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_customer_id_key" ON "tenants"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_stripe_subscription_id_key" ON "tenants"("stripe_subscription_id");
