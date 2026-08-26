-- Catégories de prestations et tampons de part et d'autre du soin — #24.
--
-- Trois manques du schéma initial que le module `catalog` doit combler :
--
-- 1. `services.category` était une **chaîne libre**, recopiée à chaque
--    prestation. Elle ne se renomme qu'une prestation à la fois, tolère
--    « Massages » à côté de « massage », et ne peut ni se désactiver ni porter
--    de description. Le CRUD des catégories réclamé par #24 suppose une ligne.
-- 2. `services` n'avait aucun tampon. Le moteur de disponibilité (#31) doit
--    occuper la cabine et le praticien au-delà du soin facturé — préparation,
--    nettoyage, remise en état — sans que ce temps apparaisse au client.
-- 3. Rien ne reliait une prestation à sa catégorie autrement que par le texte.
--
-- ## Purement additive
--
-- Une table, trois colonnes, quatre index, trois clés étrangères, deux bornes
-- `CHECK`. Aucune colonne n'est retypée, aucune ligne n'est réécrite, aucune
-- valeur existante ne change de sens.
--
-- `services.category` **reste en place**, et c'est délibéré : le module cesse de
-- la lire et de l'écrire, mais la retirer dans la migration qui cesse de la lire
-- casserait la version encore en vol pendant un déploiement progressif
-- (api-module §6). Son retrait se fait au déploiement suivant, sous une issue de
-- suivi. Elle est nullable et sans contrainte : la laisser ne gêne aucune
-- écriture.
--
-- Les deux colonnes de tampon arrivent `NOT NULL DEFAULT 0`. Le défaut n'est pas
-- une commodité — c'est ce qui rend l'ajout applicable sur une table déjà
-- peuplée sans avoir à écrire la moindre ligne de données, et ce qui fait que le
-- comportement d'avant ce ticket (aucun tampon) est exactement celui que
-- décrivent les lignes existantes après.
--
-- `services.category_id` arrive nullable : les prestations déjà en base n'ont
-- pas de catégorie de catalogue, et il n'existe encore aucune ligne à laquelle
-- les rattacher. Une colonne `NOT NULL` aurait exigé une catégorie fourre-tout
-- créée par la migration dans chaque établissement — une donnée métier inventée
-- par un script, que personne n'aurait demandée.
--
-- ## Réversibilité
--
-- L'inverse exact est le retrait, dans l'ordre inverse, des deux bornes, des
-- trois clés étrangères, des quatre index, des trois colonnes puis de la table.
-- Aucune donnée préexistante n'est transformée ici : le retour arrière ne perd
-- que ce que cette migration a elle-même créé.
--
-- Le retour arrière du **code** seul ne demande rien : les trois colonnes
-- ajoutées sont inertes pour la version antérieure de l'application, qui ne les
-- émet ni ne les lit, et leurs valeurs par défaut satisfont ses insertions. La
-- propriété qu'exige api-module §6 est donc tenue dans les deux sens — la
-- version en cours d'exécution survit à la migration, et la migration survit au
-- retour arrière.
--
-- ## Invariants
--
-- Vérifiés par `src/infrastructure/database/__tests__/prisma-schema.spec.ts` :
-- `tenant_id` NOT NULL sur `service_categories`, tout index préfixé
-- `tenant_id`, unique métier composite avec `tenant_id`, identifiants UUID,
-- instants en `timestamptz`, et — c'est le point de ce ticket — toute référence
-- entre tables métier doublée d'une clé composite portant le tenant.

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" VARCHAR(2000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "category_id" UUID,
ADD COLUMN     "buffer_before_minutes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "buffer_after_minutes" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_tenant_id_slug_key" ON "service_categories"("tenant_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_tenant_id_id_key" ON "service_categories"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "service_categories_tenant_id_is_active_idx" ON "service_categories"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "services_tenant_id_category_id_idx" ON "services"("tenant_id", "category_id");

-- AddForeignKey
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SQL brut — ce que Prisma ne sait pas exprimer (api-module §6)
-- ---------------------------------------------------------------------------

-- ## Intégrité inter-tenant — clé étrangère composite
--
-- `services_category_id_fkey` ci-dessus est muette sur le tenant : telle quelle,
-- elle laisserait ranger la prestation d'un salon dans la catégorie d'un autre.
-- Rien ne le verrait — l'écriture passe par le client scopé, qui borne le
-- `where` mais pas la valeur d'une colonne de référence fournie dans le corps.
-- La frontière se tient en base, pas à la vigilance de l'appelant
-- (tenant-isolation §1).
--
-- La colonne est nullable : `MATCH SIMPLE`, le défaut de PostgreSQL, ne vérifie
-- la référence que lorsque toutes les colonnes du couple sont renseignées — une
-- prestation sans catégorie reste donc représentable.
--
-- L'action `ON DELETE` reprend exactement celle de la clé mono-colonne qu'elle
-- double : lui en donner une autre changerait le comportement de suppression au
-- lieu de le renforcer.

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_category_id_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "service_categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK
--
-- Un tampon négatif raccourcirait le créneau occupé au lieu de l'allonger : la
-- cabine serait rendue disponible avant la fin réelle du soin, et deux
-- rendez-vous se chevaucheraient sur le terrain sans que la contrainte
-- d'exclusion à venir ne voie quoi que ce soit — elle porte sur l'intervalle
-- enregistré, pas sur celui qu'il aurait fallu enregistrer.
--
-- Le zéro reste permis, contrairement à `duration_minutes` : un soin sans temps
-- de préparation est le cas courant, un soin de durée nulle n'existe pas.

-- AddCheckConstraint
ALTER TABLE "services" ADD CONSTRAINT "services_buffer_before_minutes_check" CHECK ("buffer_before_minutes" >= 0);

-- AddCheckConstraint
ALTER TABLE "services" ADD CONSTRAINT "services_buffer_after_minutes_check" CHECK ("buffer_after_minutes" >= 0);
