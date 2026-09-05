-- Remboursements total et partiel — #63, CDC §4.9 et payments-stripe §6.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `RefundStatus` | le sort d'une demande : inscrite, acceptée, refusée |
-- | `payment_refunds` | la trace « qui, quand, pourquoi » de chaque remboursement |
-- | `payments_tenant_id_id_key` | la cible de la clé composite du remboursement |
--
-- ## Pourquoi une table, et pas trois colonnes sur `payments`
--
-- Parce que le remboursement **partiel** est au périmètre du ticket : un
-- encaissement peut en recevoir plusieurs, et trois colonnes ne garderaient que
-- le dernier. Le critère de #63 demande « qui, quand, pourquoi » de chaque
-- geste, et une trace qui s'écrase au deuxième remboursement ne rapproche plus
-- rien.
--
-- C'est aussi ce qui rend le deuxième critère — « le cumul des remboursements
-- ne peut jamais dépasser le montant capturé, vérifié côté serveur » — tenable
-- sans attendre le webhook : la somme des lignes actives de cette table est
-- connue à l'instant où le comptoir demande, là où `payments.refunded_amount_minor`
-- ne l'est qu'une fois `charge.refunded` reçu.
--
-- ## Pourquoi le statut de la demande n'est pas celui de l'encaissement
--
-- `RefundStatus` décrit le cheminement de l'ordre donné au prestataire ;
-- `PaymentStatus` dit où en est l'encaissement. Le second reste écrit par le
-- webhook `charge.refunded` et par lui seul — payments-stripe §6 interdit
-- l'écriture optimiste, et cette migration ne l'ouvre pas : aucune colonne
-- posée ici ne se substitue à `payments.status` ni à
-- `payments.refunded_amount_minor`.
--
-- `PENDING` réserve son montant dans le cumul, `FAILED` le relâche. C'est ce
-- qui empêche deux comptoirs qui remboursent en même temps de rendre deux fois
-- la même somme pendant que le premier appel est encore en vol.
--
-- ## Le motif reste ici
--
-- `reason` est un texte saisi par une personne : il peut nommer la cliente. Il
-- ne part donc pas dans les métadonnées de l'ordre envoyé au prestataire, qui
-- ne portent que des identifiants opaques (CDC §5.1). La trace vit en base, où
-- le rapprochement la lit.
--
-- ## Les contraintes que Prisma ne sait pas exprimer (api-module §6)
--
-- - **Clés étrangères composites `(tenant_id, …)`** vers `payments` et
--   `users` : `tenant_id` sur la table est nécessaire, il n'est pas suffisant.
--   Sans elles, un salon pourrait rembourser l'encaissement d'un autre, ou
--   attribuer le geste à un compte d'ailleurs.
-- - **`payment_refunds_amount_minor_check`** : un remboursement de zéro n'est
--   pas un remboursement, un remboursement négatif est un débit. La borne
--   haute, elle, ne s'exprime pas en `CHECK` — elle porte sur une somme de
--   lignes, et c'est le service qui la tient, dans une transaction sérialisable.
-- - **`payment_refunds_provider_reference_check`** : une demande acceptée
--   porte la référence du prestataire, une demande inscrite ou refusée n'en a
--   pas encore. Sans cette contrainte, une ligne `SUCCEEDED` sans `re_…` serait
--   représentable, et le rapprochement du relevé buterait dessus.
--
-- ## Purement additive, et réversible
--
-- Une table créée, un type créé, un index unique ajouté sur une table
-- existante. Aucune colonne n'est retirée, aucune donnée n'est réécrite, aucune
-- table n'est retypée. `payments_tenant_id_id_key` se construit sur un couple
-- déjà unique — `id` étant la clé primaire —, donc sans risque de conflit sur
-- les lignes en place.
--
-- L'inverse exact est le retrait de la table, du type et de l'index ; il ne
-- perd que les remboursements saisis depuis le déploiement. Le retour arrière
-- du **code** seul est sans effet de bord — la version antérieure ignore cette
-- table, et le webhook continue de tenir `payments` à jour comme avant.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression et les
-- noms de types à virgule : `prisma-schema.spec.ts` relit le texte de la
-- migration, commentaires compris, pour interdire toute instruction destructive
-- et tout type inexact sur un montant.)

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "provider_refund_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- Cible de la clé étrangère composite posée plus bas. PostgreSQL refuse une
-- clé dont la cible n'est couverte par aucun index unique : sans lui, ce n'est
-- pas un test qui rougit, c'est la migration qui ne s'applique pas.
-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_id_key" ON "payments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_tenant_id_provider_refund_id_key" ON "payment_refunds"("tenant_id", "provider_refund_id");

-- L'axe de lecture unique : « qu'a-t-on déjà rendu sur cet encaissement ? ».
-- CreateIndex
CREATE INDEX "payment_refunds_tenant_id_payment_id_created_at_idx" ON "payment_refunds"("tenant_id", "payment_id", "created_at");

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Clés étrangères composites — la frontière du tenant en base
--
-- Chaque référence est doublée d'une clé qui embarque `tenant_id`. C'est elle,
-- et non la colonne seule, qui rend impossible de rembourser l'encaissement
-- d'un autre salon, ou d'attribuer le geste au compte d'un autre salon.

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_tenant_id_payment_id_fkey" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "payments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_tenant_id_requested_by_user_id_fkey" FOREIGN KEY ("tenant_id", "requested_by_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK

-- Un remboursement de zéro n'est pas un remboursement, un remboursement
-- négatif est un débit. La borne haute porte sur une somme de lignes : elle ne
-- s'exprime pas ici, et c'est le service qui la tient.
-- AddCheck
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_amount_minor_check" CHECK ("amount_minor" > 0);

-- Une demande acceptée porte la référence du prestataire ; une demande
-- inscrite ou refusée n'en a pas encore.
-- AddCheck
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_provider_reference_check" CHECK (("status" = 'SUCCEEDED' AND "provider_refund_id" IS NOT NULL) OR ("status" IN ('PENDING', 'FAILED') AND "provider_refund_id" IS NULL));
