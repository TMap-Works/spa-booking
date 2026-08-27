-- Contrainte d'exclusion anti-double-réservation — #31, ADR 0002.
--
-- Le risque n°1 du projet (CDC §6). Une vérification applicative « ce créneau
-- est-il libre ? » suivie d'un INSERT est structurellement fausse sous
-- concurrence : deux requêtes simultanées passent toutes les deux la
-- vérification, et toutes les deux insèrent. La garantie doit donc venir du
-- moteur, où l'atomicité existe déjà — pas du code, où elle n'existe pas.
--
-- Trois objets, dans cet ordre, parce que chacun a besoin du précédent :
--
-- 1. l'extension `btree_gist`, sans laquelle un index GiST ne sait pas comparer
--    deux `uuid` par égalité — donc ne sait pas mêler `tenant_id` et `staff_id`
--    à un opérateur de chevauchement ;
-- 2. la colonne générée `time_range`, l'intervalle sur lequel le chevauchement
--    se calcule ;
-- 3. la contrainte elle-même.
--
-- ## Pourquoi une colonne générée plutôt qu'une expression dans la contrainte
--
-- `EXCLUDE USING gist (… tstzrange("starts_at", "ends_at", '[)') WITH &&)`
-- fonctionnerait aussi. La colonne est préférée pour trois raisons : elle est
-- lisible dans `\d appointments`, elle est indexable et interrogeable par le
-- moteur de disponibilité (#34) sans réécrire l'expression à l'identique à
-- chaque requête, et surtout elle ne peut pas diverger — `GENERATED ALWAYS`
-- interdit toute écriture directe, y compris par un script d'administration.
--
-- ## Pourquoi la borne `[)` — fermée à gauche, ouverte à droite
--
-- C'est ce qui rend deux rendez-vous **adjacents** légaux : un soin qui finit à
-- 10:00 et le suivant qui commence à 10:00 ne se chevauchent pas. Avec `[]`,
-- l'agenda d'un praticien perdrait un créneau sur deux. Le cas symétrique —
-- l'intervalle vide, qui ne chevauche rien et laisserait passer deux
-- réservations au même instant — est déjà fermé par
-- `appointments_time_range_check` (`ends_at > starts_at`), posée par la
-- migration initiale précisément pour ce moment-ci.
--
-- ## Pourquoi le filtre partiel sur les statuts
--
-- Un rendez-vous annulé ou marqué no-show **libère** son créneau
-- (booking-engine §5) : seuls `PENDING` et `CONFIRMED` occupent l'agenda.
-- `COMPLETED` non plus n'occupe rien — le soin est passé, et un report qui
-- viendrait se placer sur le même intervalle historique n'a aucune raison
-- d'être refusé. Sans ce `WHERE`, la première annulation rendrait le créneau
-- définitivement inréservable.
--
-- ## Pourquoi `tenant_id` en tête
--
-- Deux salons peuvent réserver le même praticien — le leur — au même instant :
-- ce sont deux praticiens différents. `staff_id` seul suffirait en théorie,
-- puisqu'un praticien appartient à un seul établissement, mais l'index qui
-- porte la contrainte deviendrait le seul index de la table à ne pas commencer
-- par `tenant_id` (tenant-isolation §1), et une lecture de plage se paierait un
-- parcours inter-tenant. La colonne est donc là pour la même raison que
-- partout ailleurs : la frontière se lit dans l'index, pas dans les intentions.
--
-- ## Purement additive, et réversible
--
-- Une extension, une colonne, une contrainte. Aucune colonne n'est retypée,
-- aucune ligne n'est réécrite, aucune valeur existante ne change de sens.
-- L'inverse exact est le retrait de la contrainte puis de la colonne ; la
-- réécriture de table qu'entraîne l'ajout de la colonne générée se paie sur une
-- table de rendez-vous, pas sur un journal d'événements.
--
-- Le retour arrière du **code** seul ne demande rien : `time_range` est inerte
-- pour la version antérieure de l'application, qui ne l'émet ni ne la lit, et
-- `GENERATED ALWAYS` la remplit sans elle. La contrainte, en revanche, refusera
-- des insertions que la version antérieure croyait légales — c'est le propos du
-- ticket, et c'est la seule incompatibilité assumée : elle se manifeste par un
-- 409 traduit, jamais par une donnée perdue.
--
-- Une migration ne peut pas s'appliquer sur une table qui viole déjà la
-- contrainte. C'est voulu : si deux rendez-vous se chevauchent déjà en base, le
-- déploiement s'arrête plutôt que d'entériner la double réservation en silence.
-- Aucun environnement du MVP n'a encore de rendez-vous.
--
-- ## Invariants
--
-- `src/infrastructure/database/__tests__/prisma-schema.spec.ts` relit ce texte :
-- migration additive (aucun retrait), aucun type flottant, aucun instant sans
-- fuseau. La contrainte d'exclusion elle-même et la borne de l'intervalle sont
-- vérifiées contre un vrai moteur par
-- `test/appointments-exclusion.integration-spec.ts`.

-- CreateExtension
--
-- `IF NOT EXISTS` : la recette et la production partagent parfois une base où
-- l'extension a déjà été posée par un autre chemin, et `btree_gist` fait partie
-- des extensions dites « de confiance » depuis PostgreSQL 13 — le propriétaire
-- de la base suffit à la créer, aucun superutilisateur n'est requis.
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- AddGeneratedColumn
--
-- `STORED` est le seul mode que PostgreSQL implémente à ce jour, et c'est celui
-- qu'il faut : un index — donc une contrainte d'exclusion — ne peut pas porter
-- sur une colonne calculée à la lecture.
ALTER TABLE "appointments"
    ADD COLUMN "time_range" tstzrange
    GENERATED ALWAYS AS (tstzrange("starts_at", "ends_at", '[)')) STORED;

-- AddExclusionConstraint
--
-- Ce que Prisma n'exprime pas, et qui vit donc en SQL brut (api-module §6).
--
-- La lecture : « il ne peut pas exister deux lignes qui, toutes deux dans un
-- statut occupant, aient le même établissement, le même praticien, et des
-- intervalles qui se chevauchent ». PostgreSQL le refuse au niveau de la ligne,
-- quelle que soit l'origine de l'écriture — API, script, psql.
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_no_overlap"
    EXCLUDE USING gist (
        "tenant_id" WITH =,
        "staff_id" WITH =,
        "time_range" WITH &&
    )
    WHERE ("status" IN ('PENDING', 'CONFIRMED'));
