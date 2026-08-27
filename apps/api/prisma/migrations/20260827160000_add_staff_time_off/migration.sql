-- Plages bloquées et congés du personnel — #33.
--
-- Un praticien absent ne doit apparaître dans aucun créneau proposé. Il manquait
-- au schéma l'endroit où dire cette absence : `appointments` dit ce qui est
-- réservé, `staff` dit qui existe, rien ne disait quand quelqu'un n'est pas là.
--
-- ## Une table, deux usages
--
-- Un déjeuner d'une heure et trois semaines de congés d'été ne diffèrent que par
-- leur durée. Deux tables auraient obligé le calcul de créneaux à lire les deux
-- et à trancher leurs recouvrements ; une table, un intervalle `[starts_at,
-- ends_at[`, et une soustraction.
--
-- ## Purement additive
--
-- Une table, deux index, un unique, deux clés étrangères mono-colonne, une clé
-- composite, une borne `CHECK`. Aucune table existante n'est touchée, aucune
-- colonne retypée, aucune ligne réécrite. La version de l'application encore en
-- vol pendant un déploiement progressif n'émet ni ne lit cette table : elle lui
-- est parfaitement inerte (api-module §6).
--
-- ## Réversibilité
--
-- L'inverse exact est le retrait, dans l'ordre inverse, de la borne, des trois
-- clés étrangères, des trois index puis de la table. Rien de préexistant n'ayant
-- été transformé, le retour arrière ne perd que ce que cette migration a
-- elle-même créé.
--
-- ## Aucune dépendance sur les autres migrations du jalon
--
-- Ni `btree_gist`, ni `tstzrange`, ni les horaires récurrents du personnel : la
-- table se suffit à elle-même et s'applique sur le schéma tel qu'il est
-- aujourd'hui. C'est délibéré — elle dit **quand le praticien est absent**,
-- jamais quand il travaille, et se compose donc avec des fenêtres de travail
-- qu'elle n'a pas besoin de connaître.
--
-- ## Pourquoi aucune contrainte d'exclusion ici
--
-- `appointments` en portera une : deux rendez-vous simultanés sur le même
-- praticien sont une faute, deux clients pour une seule paire de mains. Deux
-- absences simultanées ne sont que la même absence dite deux fois. Les interdire
-- ferait échouer en 409 le geste anodin d'étendre un congé en en posant un
-- second, pour ne rien protéger : le moteur de créneaux fusionne les intervalles
-- avant de les soustraire, et l'union de deux plages qui se chevauchent est
-- exactement la plage attendue.

-- CreateTable
CREATE TABLE "staff_time_off" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_time_off_tenant_id_id_key" ON "staff_time_off"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "staff_time_off_tenant_id_staff_id_starts_at_idx" ON "staff_time_off"("tenant_id", "staff_id", "starts_at");

-- CreateIndex
CREATE INDEX "staff_time_off_tenant_id_starts_at_idx" ON "staff_time_off"("tenant_id", "starts_at");

-- AddForeignKey
ALTER TABLE "staff_time_off" ADD CONSTRAINT "staff_time_off_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_time_off" ADD CONSTRAINT "staff_time_off_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SQL brut — ce que Prisma ne sait pas exprimer (api-module §6)
-- ---------------------------------------------------------------------------

-- ## Intégrité inter-tenant — clé étrangère composite
--
-- `staff_time_off_staff_id_fkey` ci-dessus est muette sur le tenant : telle
-- quelle, elle laisserait poser un congé du salon A sur le praticien du salon B.
-- Le client scopé borne le `where` d'une lecture, il ne borne pas la **valeur**
-- d'une colonne de référence fournie dans un corps de requête — et `staff_id`
-- vient précisément du corps. La frontière se tient donc en base
-- (tenant-isolation §1).
--
-- C'est aussi ce qui rend le 404 gratuit : une création visant le praticien d'un
-- autre établissement viole cette contrainte, et le repository traduit la
-- violation en « praticien introuvable » — jamais en 403, qui confirmerait son
-- existence (tenant-isolation §4).
--
-- L'action `ON DELETE` reprend exactement celle de la clé mono-colonne qu'elle
-- double : lui en donner une autre changerait le comportement de suppression au
-- lieu de le renforcer.

-- AddForeignKey
ALTER TABLE "staff_time_off" ADD CONSTRAINT "staff_time_off_tenant_id_staff_id_fkey" FOREIGN KEY ("tenant_id", "staff_id") REFERENCES "staff"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Borne métier — contrainte CHECK
--
-- Un intervalle vide (`ends_at = starts_at`) ou inversé ne soustrait **rien** au
-- calcul de créneaux : il reste invisible du moteur alors que l'utilisateur
-- croit avoir bloqué son agenda, et le praticien se retrouve proposé pendant son
-- congé. C'est le même raisonnement que le `CHECK` d'`appointments`, appliqué à
-- l'autre bout de la chaîne — là-bas un intervalle vide ne chevauche rien et
-- passe sous la contrainte d'exclusion, ici il ne retranche rien et passe sous
-- la soustraction.
--
-- La borne haute est exclue, de sorte que deux absences adjacentes ne se
-- chevauchent pas et qu'un créneau démarrant exactement à `ends_at` reste
-- proposable.

-- AddCheckConstraint
ALTER TABLE "staff_time_off" ADD CONSTRAINT "staff_time_off_range_check" CHECK ("ends_at" > "starts_at");
