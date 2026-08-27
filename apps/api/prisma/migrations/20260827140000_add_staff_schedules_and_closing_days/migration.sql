-- Horaires récurrents du personnel et jours de fermeture — #32.
--
-- Deux tables, et une propriété qui les tient toutes les deux : **aucun décalage
-- horaire n'est figé en base**.
--
-- ## Pourquoi des minutes et non un type horaire
--
-- « Ouvre à 09:00 » n'est pas un instant. À Paris, cette heure murale vaut
-- `08:00Z` en hiver et `07:00Z` en été : stocker l'un des deux décale l'agenda
-- six mois par an, sans que rien ne le signale — le bug de sévérité haute que
-- CLAUDE.md interdit (CDC §6). La colonne ne peut donc pas être un `timestamptz`.
--
-- Elle n'est pas non plus un type horaire nu. PostgreSQL saurait l'ordonner et
-- le comparer, mais le convertir demanderait de toute façon une date **et** un
-- fuseau, et le type ferait croire à un point de la ligne du temps. Un entier —
-- les minutes écoulées depuis minuit local, `540` pour 09:00 — ne peut se lire
-- que pour ce qu'il est, se compare sans conversion, et se soustrait.
--
-- La conversion en instants UTC se fait à la volée, date par date, par
-- `TenantClockService` (#41), qui interroge la base tzdata de l'ICU pour
-- l'instant considéré. C'est ce qui rend l'agenda juste des deux côtés d'un
-- changement d'heure.
--
-- ## Purement additive
--
-- Deux tables, un index, un unique, trois clés étrangères — dont une composite
-- portant le tenant —, trois bornes `CHECK` et une contrainte d'exclusion.
-- Aucune colonne n'est retypée, aucune ligne n'est réécrite, aucune valeur
-- existante ne change de sens. Les deux tables arrivent vides : une base migrée
-- sans elles décrit exactement le même état du monde qu'une base migrée avec —
-- « aucun horaire saisi », qui est bien la situation d'avant ce ticket.
--
-- ## Réversibilité
--
-- L'inverse exact est le retrait, dans l'ordre inverse, de la contrainte
-- d'exclusion, des trois bornes, des trois clés étrangères, des deux index puis
-- des deux tables. Rien de préexistant n'est transformé ici : le retour arrière
-- ne perd que ce que cette migration a elle-même créé.
--
-- Le retour arrière du **code** seul ne demande rien : les deux tables sont
-- inertes pour la version antérieure de l'application, qui ne les lit ni ne les
-- écrit. La propriété qu'exige api-module §6 est donc tenue dans les deux sens.
--
-- ## Invariants
--
-- Vérifiés par `src/infrastructure/database/__tests__/prisma-schema.spec.ts` :
-- `tenant_id` NOT NULL sur les deux tables, index préfixé `tenant_id`, unique
-- métier composite avec `tenant_id`, identifiants UUID, horodatages en
-- `timestamptz`, et toute référence entre tables métier doublée d'une clé
-- composite portant le tenant.

-- CreateTable
CREATE TABLE "staff_schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "staff_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_closing_days" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_closing_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_schedules_tenant_id_staff_id_weekday_idx" ON "staff_schedules"("tenant_id", "staff_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_closing_days_tenant_id_weekday_key" ON "tenant_closing_days"("tenant_id", "weekday");

-- AddForeignKey
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_closing_days" ADD CONSTRAINT "tenant_closing_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- SQL brut — ce que Prisma ne sait pas exprimer (api-module §6)
-- ---------------------------------------------------------------------------

-- ## Intégrité inter-tenant — clé étrangère composite
--
-- `staff_schedules_staff_id_fkey` ci-dessus est muette sur le tenant : telle
-- quelle, elle laisserait poser l'horaire d'un salon sur le praticien d'un
-- autre. Rien ne le verrait — l'écriture passe par le client scopé, qui borne le
-- `where` mais pas la valeur d'une colonne de référence fournie dans le corps.
-- La frontière se tient en base, pas à la vigilance de l'appelant
-- (tenant-isolation §1).
--
-- L'action `ON DELETE` reprend exactement celle de la clé mono-colonne qu'elle
-- double : lui en donner une autre changerait le comportement de suppression au
-- lieu de le renforcer.

-- AddForeignKey
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_tenant_id_staff_id_fkey" FOREIGN KEY ("tenant_id", "staff_id") REFERENCES "staff"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK
--
-- `weekday` est en numérotation ISO 8601 : 1 lundi … 7 dimanche. Le `0` de
-- `Date.getDay` est délibérément hors bornes — il est *falsy* en JavaScript, et
-- le praticien du dimanche disparaîtrait au premier `weekday ?? défaut`.
--
-- Les minutes sont bornées à la journée civile de 24 heures. Une fenêtre de
-- travail qui déborde sur le lendemain se décrit par deux plages, une par jour,
-- et non par un `1530` que rien ne saurait afficher.
--
-- La fin est strictement postérieure au début, pour la même raison que
-- `appointments_time_range_check` : une plage vide ne recouvre rien et passerait
-- sous la contrainte d'exclusion ci-dessous sans jamais la déclencher, tout en
-- ne produisant aucun créneau — un horaire saisi qui ne sert à rien, et que rien
-- n'aurait signalé.

-- AddCheckConstraint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);

-- AddCheckConstraint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_minutes_check" CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "end_minute" > "start_minute");

-- AddCheckConstraint
ALTER TABLE "tenant_closing_days" ADD CONSTRAINT "tenant_closing_days_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7);

-- ## Non-recouvrement des plages d'une même journée
--
-- Plusieurs plages par `(praticien, jour)` sont attendues : c'est ainsi que se
-- dit la coupure méridienne. Deux plages qui se **recouvrent**, en revanche, ne
-- veulent rien dire — le calcul de créneaux (#34) proposerait deux fois le même
-- créneau, et le praticien apparaîtrait deux fois libre à la même heure.
--
-- L'unicité ne suffit pas à l'interdire : `09:00–13:00` et `10:00–12:00` ont des
-- bornes différentes. Il faut une contrainte sur l'intervalle, et PostgreSQL sait
-- l'exprimer — `int4range` avec la borne haute exclue, comme partout ailleurs
-- dans ce projet, de sorte que `09:00–12:00` et `12:00–18:00` restent adjacentes
-- plutôt que conflictuelles.
--
-- `btree_gist` est ce qui autorise `=` sur `tenant_id`, `staff_id` et `weekday`
-- dans un index GiST, aux côtés du `&&` de l'intervalle. L'extension est créée
-- ici parce que cette migration en dépend : la supposer présente parce qu'une
-- autre l'a créée ailleurs ferait échouer l'application sur une base neuve.
-- `IF NOT EXISTS` la rend rejouable sans effet.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- AddExclusionConstraint
ALTER TABLE "staff_schedules" ADD CONSTRAINT "staff_schedules_no_overlap" EXCLUDE USING gist ("tenant_id" WITH =, "staff_id" WITH =, "weekday" WITH =, (int4range("start_minute", "end_minute")) WITH &&);
