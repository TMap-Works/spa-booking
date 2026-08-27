-- Pas de créneau et délai minimum de réservation, par établissement — #34.
--
-- Le calcul des créneaux libres a besoin de deux réglages que le schéma ne
-- portait nulle part. Les six autres entrées de l'algorithme existent déjà :
-- `service_staff` dit qui pratique quoi (#24), `staff_schedules` et
-- `tenant_closing_days` disent quand on travaille (#32), `staff_time_off` quand
-- on est absent (#33), `appointments` ce qui est déjà pris (#31), et
-- `services.buffer_before_minutes` / `buffer_after_minutes` la durée réellement
-- occupée (#24). Il manquait **la grille et l'horizon** :
--
-- | Réglage | Étape de booking-engine §3 | Défaut |
-- |---|---|---|
-- | `slot_interval_minutes` | 4 — découpage des fenêtres | 15 |
-- | `min_booking_notice_minutes` | 6 — filtrage du trop-proche | 60 |
--
-- ## Sur `tenants`, et pas ailleurs
--
-- Ce sont des réglages d'établissement, pas de prestation : un salon annonce une
-- grille, il n'en annonce pas une par soin. Les poser sur `services` aurait
-- produit des grilles concurrentes sur un même agenda — deux prestations aux pas
-- différents proposant des créneaux qui se chevauchent à moitié.
--
-- `tenants` est la seule table sans `tenant_id` parce qu'elle *est* le tenant :
-- les règles d'index préfixés et de colonne discriminante (tenant-isolation §1)
-- ne s'y appliquent pas, et ces deux colonnes se lisent par la clé primaire.
--
-- ## Purement additive
--
-- Deux colonnes `NOT NULL` **avec valeur par défaut**, deux bornes `CHECK`.
-- Aucune colonne retypée, aucune ligne réécrite : PostgreSQL 11 et suivants
-- posent une valeur par défaut sans réécrire la table. Les établissements déjà
-- en base héritent de 15 et 60, c'est-à-dire du comportement que booking-engine
-- décrit comme le défaut — la migration ne change donc aucun agenda existant.
--
-- La version de l'application encore en vol pendant un déploiement progressif ne
-- lit ni n'écrit ces colonnes ; leur défaut la dispense de les fournir sur les
-- établissements qu'elle crée (api-module §6).
--
-- ## Réversibilité
--
-- L'inverse exact est le retrait des deux bornes puis des deux colonnes. Rien de
-- préexistant n'ayant été transformé, le retour arrière ne perd que ce que cette
-- migration a elle-même créé.
--
-- ## Pourquoi des bornes `CHECK` et pas seulement une validation applicative
--
-- Un pas nul ou négatif ne produit pas un mauvais résultat : il fait **boucler
-- indéfiniment** le découpage d'une fenêtre, puisque le curseur n'avance plus.
-- C'est une panne d'un genre que la validation d'entrée ne rattrape pas si la
-- valeur entre par une autre porte — un correctif de données, une restauration,
-- un futur écran de réglages. La borne basse est donc en base, là où aucune
-- écriture ne la contourne ; le calcul la revérifie pour nommer la faute plutôt
-- que de la laisser remonter en violation brute.
--
-- Les bornes hautes sont des bornes de faute de frappe, du même genre que
-- `MAX_TIME_OFF_RANGE_DAYS` : un pas d'une journée entière (1440) ne propose
-- qu'un créneau par jour, ce qui est absurde mais reste calculable ; au-delà, la
-- valeur ne veut plus rien dire. Un préavis de plus de trente jours (43200
-- minutes) vide l'agenda du mois sans qu'aucune erreur ne le signale.

-- AlterTable
ALTER TABLE "tenants"
    ADD COLUMN "slot_interval_minutes" INTEGER NOT NULL DEFAULT 15,
    ADD COLUMN "min_booking_notice_minutes" INTEGER NOT NULL DEFAULT 60;

-- Bornes de plausibilité. La basse protège l'algorithme, la haute protège de la
-- faute de frappe — voir l'en-tête. Écrites en SQL brut : Prisma ne sait pas
-- exprimer un `CHECK` (api-module §6).
ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_slot_interval_minutes_check"
    CHECK ("slot_interval_minutes" >= 1 AND "slot_interval_minutes" <= 1440);

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_min_booking_notice_minutes_check"
    CHECK ("min_booking_notice_minutes" >= 0 AND "min_booking_notice_minutes" <= 43200);
