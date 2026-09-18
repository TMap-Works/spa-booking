-- Le journal de la console sur un salon — fiche salon, notes internes,
-- suspension et réactivation (ADR 0012, espace plateforme).
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `PlatformTenantEventKind` | note, suspension, réactivation, réinvitation |
-- | `platform_tenant_events` | qui (opérateur), quoi, sur quel salon, quand |
-- | `platform_tenant_events_subject_tenant_id_created_at_idx` | l'historique d'un salon, du plus récent au plus ancien |
--
-- ## Une table sans `tenant_id`, et pourquoi c'est licite
--
-- C'est la lecture qui exempte déjà `platform_tenant_provisionings` : la ligne
-- n'appartient pas au salon qu'elle nomme, elle appartient à l'éditeur qui l'a
-- écrite, et le salon ne la lit jamais. La colonne se nomme
-- `subject_tenant_id` — et non `tenant_id` — pour que
-- `tenant-scope.extension.ts`, qui déduit du champ `tenantId` les modèles à
-- filtrer, ne la prenne pas pour une table de salon. Elle est inscrite dans
-- `PLATFORM_MODELS`, donc refusée au client scopé.
--
-- ## Purement additive, et réversible
--
-- Aucune ligne existante n'est touchée. Le retour arrière est un
-- `DROP TABLE "platform_tenant_events"; DROP TYPE "PlatformTenantEventKind";`.

-- CreateEnum
CREATE TYPE "PlatformTenantEventKind" AS ENUM ('NOTE', 'SUSPENDED', 'REACTIVATED', 'INVITATION_REISSUED');

-- CreateTable
CREATE TABLE "platform_tenant_events" (
    "id" UUID NOT NULL,
    "subject_tenant_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "kind" "PlatformTenantEventKind" NOT NULL,
    "body" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_tenant_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_tenant_events_subject_tenant_id_created_at_idx" ON "platform_tenant_events"("subject_tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "platform_tenant_events" ADD CONSTRAINT "platform_tenant_events_subject_tenant_id_fkey" FOREIGN KEY ("subject_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_tenant_events" ADD CONSTRAINT "platform_tenant_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform_operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
