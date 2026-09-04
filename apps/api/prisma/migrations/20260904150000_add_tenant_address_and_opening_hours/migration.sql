-- Adresse postale et horaires d'ouverture de l'établissement — #343.
--
-- La page vitrine du salon (#43) annonce « adresse, horaires, contact » ; seul le
-- contact existait. Cette migration pose les deux manquants, et rien d'autre :
-- cinq colonnes nullables sur `tenants` pour l'adresse, une table pour les
-- plages d'ouverture de la semaine.
--
-- ## Une table pour les horaires, des colonnes pour l'adresse
--
-- Une adresse est une **valeur** : un salon en a une, ou n'en a pas. Elle se lit
-- et s'écrit avec l'établissement, ne se filtre jamais, ne se joint jamais — des
-- colonnes suffisent, et une table dédiée aurait ajouté une jointure à chaque
-- affichage de vitrine pour ne jamais porter plus d'une ligne.
--
-- Une semaine d'ouverture, non. Un salon ferme entre midi et deux et rouvre
-- parfois le soir : il faut plusieurs plages par jour, ce qu'une colonne ne sait
-- pas exprimer. C'est aussi ce qui permet de tenir le non-recouvrement en base,
-- par une contrainte d'exclusion, plutôt qu'à la vigilance de l'appelant.
--
-- `tenant_opening_hours` n'est pas une entité neuve du CDC §2.4 : le CDC §1.4
-- range les horaires d'ouverture dans le paramétrage de l'établissement, au même
-- titre que `tenant_closing_days` posée par #32. Elle est soumise aux mêmes
-- exigences que toute table métier — `tenant_id` non nullable, clé étrangère
-- vers `tenants`, index préfixé du tenant, identifiant UUID, horodatages en
-- `timestamptz` — et `prisma-schema.spec.ts` les relit sur ce fichier.
--
-- ## Ce que ces horaires ne sont pas
--
-- Ils ne contraignent **aucun** agenda. Le moteur de créneaux part de
-- `staff_schedules`, leur soustrait `staff_time_off` et `tenant_closing_days`,
-- et ne lit pas cette table. Elle décrit ce que le salon affiche à ses clientes.
-- Les confondre ferait d'un texte de vitrine une règle de disponibilité : un
-- salon qui corrige son affichage fermerait son planning sans l'avoir demandé.
--
-- ## Purement additive
--
-- Cinq colonnes **nullables** sans valeur par défaut, une table, un index, une
-- clé étrangère et quatre bornes `CHECK`. Aucune colonne n'est retypée, aucune
-- ligne n'est réécrite, aucune valeur existante ne change de sens :
--
-- - une colonne nullable ajoutée sans défaut ne réécrit pas la table, et tous
--   les établissements déjà en base se retrouvent « sans adresse publiée » —
--   c'est-à-dire exactement dans l'état qui était le leur avant ce ticket ;
-- - la table arrive vide, donc « aucun horaire publié », qui est également
--   l'état d'avant.
--
-- La version de l'application encore en vol pendant un déploiement progressif ne
-- lit ni n'écrit rien de tout cela ; la nullabilité et la table vide la
-- dispensent d'avoir quoi que ce soit à fournir (api-module §6). Et la vitrine
-- publique **omet** ces champs quand ils sont absents plutôt que de rendre
-- `null` : la réponse d'un salon sans adresse a rigoureusement la forme qu'elle
-- avait avant cette migration, si bien qu'un front antérieur continue de la
-- valider.
--
-- ## Réversibilité
--
-- L'inverse exact est le retrait, dans l'ordre inverse, de la contrainte
-- d'exclusion, des bornes `CHECK`, de la clé étrangère, de l'index et de la
-- table, puis de la borne d'adresse et des cinq colonnes. Rien de préexistant
-- n'est transformé : le retour arrière ne perd que ce que cette migration a
-- elle-même créé.

-- ---------------------------------------------------------------------------
-- Adresse postale — cinq colonnes sur `tenants`
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "tenants"
    ADD COLUMN "address_line1" VARCHAR(160),
    ADD COLUMN "address_line2" VARCHAR(160),
    ADD COLUMN "postal_code" VARCHAR(16),
    ADD COLUMN "city" VARCHAR(120),
    ADD COLUMN "country_code" CHAR(2);

-- ## Cohérence de l'adresse — contrainte CHECK
--
-- Les cinq colonnes sont nullables *chacune*, mais pas indépendamment : une
-- adresse est publiée en entier ou pas du tout. `address_line1`, `city` et
-- `country_code` forment le triplet minimal — sans l'un des trois, l'adresse
-- n'oriente personne et le `PostalAddress` du JSON-LD serait incomplet, ce qui
-- coûte plus cher en référencement qu'une donnée absente.
--
-- La borne est en base et non seulement dans le DTO, pour la raison qui vaut
-- partout ailleurs ici : la validation d'entrée ne rattrape pas une valeur qui
-- arrive par une autre porte — un correctif de données, une restauration, un
-- futur import.
--
-- `address_line2` et `postal_code` en sont exclus : le premier est un
-- complément, le second n'existe pas dans tous les pays. Les exiger refuserait
-- l'adresse réelle d'un salon.
--
-- Toutes les lignes existantes ont les cinq colonnes à `NULL` et satisfont donc
-- la contrainte à l'instant où elle est posée — sa validation ne peut pas
-- échouer sur une base en production.

-- AddCheckConstraint
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_address_completeness_check"
    CHECK (
        ("address_line1" IS NULL AND "city" IS NULL AND "country_code" IS NULL)
        OR ("address_line1" IS NOT NULL AND "city" IS NOT NULL AND "country_code" IS NOT NULL)
    );

-- ## Le code pays est un code, en majuscules
--
-- ISO 3166-1 alpha-2. Le `CHAR(2)` borne la longueur, pas l'alphabet : sans
-- cette borne, `fr` et `FR` désigneraient le même pays sous deux valeurs, et
-- `12` passerait pour l'un d'eux. La normalisation en majuscules se fait au
-- contrat partagé (`postalAddressSchema`) ; la base refuse ce qui la
-- contournerait.

-- AddCheckConstraint
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_country_code_check"
    CHECK ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$');

-- ---------------------------------------------------------------------------
-- Horaires d'ouverture — une table
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "tenant_opening_hours" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_opening_hours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_opening_hours_tenant_id_weekday_idx" ON "tenant_opening_hours"("tenant_id", "weekday");

-- AddForeignKey
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SQL brut — ce que Prisma ne sait pas exprimer (api-module §6)
-- ---------------------------------------------------------------------------

-- ## Bornes métier — contraintes CHECK
--
-- Les mêmes que `staff_schedules`, et pour les mêmes raisons : `weekday` en
-- numérotation ISO 8601 (le `0` de `Date.getDay` est délibérément hors bornes —
-- il est *falsy*, et le dimanche disparaîtrait au premier `weekday ?? défaut`),
-- minutes bornées à la journée civile de 24 heures, fin strictement postérieure
-- au début.
--
-- Une plage vide (`end = start`) ne recouvre rien : elle passerait sous la
-- contrainte d'exclusion ci-dessous sans jamais la déclencher, tout en
-- n'affichant aucun horaire — une ligne saisie qui ne sert à rien, et que rien
-- n'aurait signalé.

-- AddCheckConstraint
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);

-- AddCheckConstraint
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_minutes_check" CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "end_minute" > "start_minute");

-- ## Non-recouvrement des plages d'une même journée
--
-- Plusieurs plages par jour sont attendues : c'est ainsi que se dit la coupure
-- méridienne. Deux plages qui se **recouvrent**, en revanche, ne veulent rien
-- dire — la vitrine afficherait « 09:00–13:00 » et « 12:00–19:00 » l'une sous
-- l'autre, et le `openingHoursSpecification` du JSON-LD serait contradictoire.
--
-- L'unicité ne suffit pas à l'interdire : ces deux plages ont des bornes
-- différentes. Il faut une contrainte sur l'intervalle — `int4range` avec la
-- borne haute exclue, comme partout ailleurs dans ce projet, de sorte que
-- `09:00–12:00` et `12:00–18:00` restent adjacentes plutôt que conflictuelles.
--
-- `btree_gist` autorise `=` sur `tenant_id` et `weekday` dans un index GiST, aux
-- côtés du `&&` de l'intervalle. L'extension est créée ici parce que cette
-- migration en dépend : la supposer présente parce qu'une autre l'a créée
-- ailleurs ferait échouer l'application sur une base neuve. `IF NOT EXISTS` la
-- rend rejouable sans effet.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- AddExclusionConstraint
ALTER TABLE "tenant_opening_hours" ADD CONSTRAINT "tenant_opening_hours_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "weekday" WITH =, (int4range("start_minute", "end_minute")) WITH &&);
