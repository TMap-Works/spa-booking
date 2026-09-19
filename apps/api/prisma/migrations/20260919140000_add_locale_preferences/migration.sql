-- Langue de l'établissement et langue préférée des comptes — #844, épique #843.
--
-- Aucun champ de langue n'existait en base : `tenants` portait `timezone` et
-- `default_currency` mais aucune langue, et `users` — qui représente aussi bien
-- les clientes que l'équipe — n'en avait pas non plus. Une page ne savait donc
-- pas en quelle langue s'ouvrir, ni une notification en quelle langue partir.
--
-- | Colonne | Nullable | Défaut | Ce qu'elle porte |
-- |---|---|---|---|
-- | `tenants.default_locale` | non | `'en'` | la langue du salon, celle de sa vitrine et de ses envois |
-- | `users.locale` | oui | — | la préférence de la personne ; `NULL` = aucune |
--
-- ## `'en'` par défaut, y compris pour les établissements déjà en base
--
-- Décision du PO du 2026-09-19 : la clientèle du produit est nord-américaine, et
-- l'anglais est la langue par défaut du système. Le `DEFAULT` de l'`ADD COLUMN`
-- remplit les lignes existantes — seed, recette, console, salons inscrits en
-- libre-service —, ce qui rend cette moitié de la migration **purement
-- additive** : aucune ligne n'a de valeur à fournir, aucun écran n'a à traiter
-- un trou. Le français reste une option que l'établissement choisit.
--
-- ## `users.locale` nullable, et ce n'est pas un relâchement
--
-- `NULL` se lit « aucune préférence enregistrée », jamais « français ». C'est ce
-- qui rend exprimable la règle du huitième critère d'acceptation : l'inscription
-- et la réservation **posent** la langue de l'interface sur un compte qui n'en a
-- pas, et n'écrasent jamais celle qui y est déjà. Un `NOT NULL DEFAULT 'en'`
-- aurait fabriqué sur chaque compte une préférence que personne n'a donnée, et
-- il n'y aurait plus eu moyen de distinguer « a choisi l'anglais » de « n'a rien
-- dit ».
--
-- ## Une contrainte `CHECK`, pas un type énuméré
--
-- `UserRole` et `TenantBillingStatus` sont des `CREATE TYPE ... AS ENUM`, et
-- Prisma en génère les valeurs en **majuscules**. Le contrat partagé, lui, nomme
-- ces langues `fr` et `en` en minuscules — ce sont les étiquettes BCP 47 que
-- portent un `Accept-Language` et un `<html lang>`. Un type énuméré aurait donc
-- rouvert la conversion de casse que le vocabulaire des rôles traîne depuis #510
-- (`receivedUserRoleSchema`), pour un gain nul : deux valeurs, jamais
-- interrogées par un index, jamais ordonnées. La colonne porte exactement la
-- valeur du contrat, et la contrainte dit lesquelles sont admises.
--
-- Une valeur hors vocabulaire est de toute façon refusée **avant** la base, en
-- 400 `VALIDATION_ERROR`, par `localeSchema` monté sur les frontières d'entrée.
-- La contrainte est la garantie ; la validation est le message.
--
-- ## Réversibilité
--
-- Purement additive et réversible sans perte d'une donnée antérieure :
--
-- ```sql
-- ALTER TABLE "users"   DROP CONSTRAINT "users_locale_check";
-- ALTER TABLE "users"   DROP COLUMN "locale";
-- ALTER TABLE "tenants" DROP CONSTRAINT "tenants_default_locale_check";
-- ALTER TABLE "tenants" DROP COLUMN "default_locale";
-- ```
--
-- Aucune colonne existante n'est modifiée, aucune ligne n'est réécrite, aucun
-- index n'est supprimé : revenir en arrière ne rend pas une base différente de
-- celle d'avant, aux préférences saisies entre-temps près.
--
-- Aucun index non plus, et c'est délibéré : ces deux colonnes se lisent avec la
-- ligne qu'on regarde — la vitrine du salon, le compte connecté, le destinataire
-- d'un envoi — et ne servent aucun prédicat de recherche. Même arbitrage, et
-- même motif, que `users.data_consent_at` (#880).

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "default_locale" VARCHAR(5) NOT NULL DEFAULT 'en';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" VARCHAR(5);

-- Le vocabulaire des langues, tenu en base — `LOCALES` de `@spa/shared`.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_locale_check" CHECK ("default_locale" IN ('fr', 'en'));

-- `NULL` traverse : c'est « aucune préférence », et c'est l'état de la quasi
-- totalité des comptes à tout instant.
ALTER TABLE "users" ADD CONSTRAINT "users_locale_check" CHECK ("locale" IS NULL OR "locale" IN ('fr', 'en'));
