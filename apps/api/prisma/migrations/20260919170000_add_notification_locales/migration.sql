-- La langue des notifications — #854, épique #843.
--
-- #844 a posé la langue **des acteurs** : `tenants.default_locale` et
-- `users.locale`. Celle-ci pose la langue **des messages** : ce qu'une cliente
-- reçoit, et ce qu'un salon a le droit d'écrire par langue.
--
-- | Colonne | Nullable | Ce qu'elle porte |
-- |---|---|---|
-- | `notifications.locale` | non | la langue dans laquelle le message est réellement parti |
-- | `notification_templates.locale` | non | la langue de la personnalisation écrite par le salon |
--
-- ============================================================================
-- 1. `notifications.locale` — un constat, pas une préférence
-- ============================================================================
--
-- La langue est résolue **au moment de l'expédition** (`NotificationDispatchService`),
-- jamais à la planification : c'est le sixième critère d'acceptation, et il
-- porte d'abord sur le rappel J-1, dont l'enveloppe SQS peut être consommée une
-- heure après avoir été publiée. Entre les deux, la cliente a pu changer sa
-- langue. L'enveloppe ne transporte donc aucune langue, et cette colonne
-- enregistre celle qui a servi.
--
-- ## Les lignes déjà en base reçoivent `'fr'`, et c'est la vérité
--
-- Tout message parti avant ce ticket a été rendu avec les modèles de plateforme
-- de `notification-default-templates.ts`, qui n'existaient **qu'en français**, et
-- formaté par `Intl` sur la locale `fr-FR` écrite en dur dans
-- `notification-content.ts`. Les tamponner `'en'` — la langue par défaut du
-- système depuis #844 — aurait inscrit dans le journal du back-office une
-- affirmation fausse sur des messages que les clientes ont déjà lus.
--
-- Le `DEFAULT 'fr'` posé à l'`ADD COLUMN` remplit ces lignes, puis il est
-- **retiré** : la colonne n'a pas de défaut à l'état stable. Une ligne naît
-- désormais avec la langue que l'expédition vient de résoudre, et une écriture
-- qui oublierait de la poser doit échouer plutôt que d'inventer une langue.
--
-- ============================================================================
-- 2. `notification_templates.locale` — la compatibilité des personnalisations
-- ============================================================================
--
-- L'unicité passe de `(tenant_id, type, channel)` à
-- `(tenant_id, type, channel, locale)` : un salon écrit désormais sa
-- confirmation en français **et** en anglais.
--
-- ## Quelle langue reçoivent les personnalisations déjà écrites, et pourquoi
--
-- **Celle de leur propre établissement** — `tenants.default_locale` — et non une
-- constante. C'est la seule reprise qui ne change le texte d'**aucun** message
-- qui part aujourd'hui, et c'est tout l'enjeu : ces lignes sont du contenu
-- délibérément rédigé par un salon, et le perdre en silence se découvrirait par
-- ses clientes.
--
-- Les deux autres reprises envisageables échouent, chacune à sa façon :
--
-- - **`'fr'` en dur** — la langue dans laquelle ces textes sont effectivement
--   rédigés, le produit ayant été francophone jusqu'ici. Mais #844 a migré
--   **tous** les établissements déjà en base à `default_locale = 'en'`, et aucun
--   compte ne porte de préférence (`users.locale` est `NULL` partout). Tout envoi
--   se résout donc aujourd'hui en `'en'` : une personnalisation tamponnée `'fr'`
--   ne serait plus jamais servie, et chaque salon qui avait personnalisé ses
--   messages repasserait sans le savoir au modèle de plateforme ;
-- - **`'en'` en dur** — le même résultat que ci-dessous tant que rien n'a bougé,
--   mais faux pour un établissement qui aurait déjà choisi le français depuis
--   #844 : sa personnalisation atterrirait dans une langue qu'il ne sert pas.
--
-- Rattacher la ligne à la langue de son établissement donne donc, aujourd'hui,
-- exactement le comportement d'avant la migration — le salon garde ses mots —
-- et reste juste pour un salon qui a déjà exprimé un choix.
--
-- ## Ce qu'elle ne fabrique pas
--
-- Aucune ligne n'est dupliquée dans la seconde langue. Recopier le texte
-- français d'un salon dans son emplacement anglais aurait inventé une
-- personnalisation que personne n'a écrite, et l'aurait rendue indiscernable
-- d'un choix délibéré au moment où le salon ouvrirait l'écran. La seconde langue
-- part donc du modèle de plateforme, qui existe désormais dans les deux — c'est
-- le premier critère d'acceptation.
--
-- ## Réversibilité
--
-- ```sql
-- -- Les deux langues d'un même (tenant, type, canal) entreraient en conflit sur
-- -- l'ancien unique : il faut choisir laquelle survit avant de le reposer.
-- DELETE FROM "notification_templates" t
--  USING "tenants" n
--  WHERE t."tenant_id" = n."id" AND t."locale" <> n."default_locale";
-- DROP INDEX "notification_templates_tenant_id_type_channel_key";
-- CREATE UNIQUE INDEX "notification_templates_tenant_id_type_channel_key"
--     ON "notification_templates"("tenant_id", "type", "channel");
-- ALTER TABLE "notification_templates" DROP CONSTRAINT "notification_templates_locale_check";
-- ALTER TABLE "notification_templates" DROP COLUMN "locale";
-- ALTER TABLE "notifications" DROP CONSTRAINT "notifications_locale_check";
-- ALTER TABLE "notifications" DROP COLUMN "locale";
-- ```
--
-- La réversibilité de la seconde langue est donc **avec perte** — les
-- personnalisations écrites dans la langue non servie sont supprimées —, et c'est
-- inhérent : l'ancien schéma n'a pas de place où les mettre. Rien de ce qui
-- existait avant ce ticket n'est perdu pour autant, et c'est la propriété qui
-- compte ici.
--
-- Aucun index n'est ajouté pour `notifications.locale` : elle se lit avec la
-- ligne qu'on regarde et ne sert aucun prédicat de recherche. Même arbitrage que
-- pour les deux colonnes de #844.

-- AlterTable — la langue d'un envoi, `'fr'` pour tout ce qui est déjà parti.
ALTER TABLE "notifications" ADD COLUMN     "locale" VARCHAR(5) NOT NULL DEFAULT 'fr';

-- Le défaut a rempli les lignes existantes ; il n'a plus lieu d'être. La langue
-- d'un envoi est résolue par l'expédition, et une ligne qui n'en porterait pas
-- est une faute d'écriture, pas un cas à couvrir.
ALTER TABLE "notifications" ALTER COLUMN "locale" DROP DEFAULT;

-- AlterTable — la langue d'une personnalisation.
ALTER TABLE "notification_templates" ADD COLUMN     "locale" VARCHAR(5);

-- La reprise : chaque personnalisation rejoint la langue de son établissement.
UPDATE "notification_templates" AS t
   SET "locale" = n."default_locale"
  FROM "tenants" AS n
 WHERE t."tenant_id" = n."id";

-- Plus aucune ligne n'est sans langue : la colonne peut se fermer.
ALTER TABLE "notification_templates" ALTER COLUMN "locale" SET NOT NULL;

-- Le vocabulaire des langues, tenu en base — `LOCALES` de `@spa/shared`, mêmes
-- minuscules et même raison qu'en #844 : un type énuméré aurait rouvert la
-- conversion de casse que le vocabulaire des rôles traîne depuis #510.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_locale_check" CHECK ("locale" IN ('fr', 'en'));
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_locale_check" CHECK ("locale" IN ('fr', 'en'));

-- L'unicité gagne sa quatrième dimension — **sous son nom d'origine**.
--
-- ## Pourquoi l'index garde son nom au lieu d'en prendre un qui liste `locale`
--
-- Parce que c'est la convention de remplacement du dépôt, et qu'elle est tenue
-- par un garde : `prisma-schema.spec.ts` n'autorise un `DROP INDEX` que si le
-- **même fichier** recrée un index du **même nom** (assouplissement de #534).
-- Ce n'est pas une formalité : c'est le fait vérifiable qui distingue un
-- remplacement d'un retrait sec, et qui prouve qu'à aucun instant visible d'une
-- autre transaction la table n'est restée sans son invariant d'unicité. Le
-- précédent est `notifications_live_once`, redéfini de la même façon en #534.
--
-- Un index ne se modifie pas, il se remplace : ajouter un second unique à côté
-- de l'ancien n'aurait rien débloqué, puisque c'est l'ancien — total sur
-- `(tenant_id, type, channel)` — qui refuse la seconde langue. Il doit donc
-- tomber, et le seul chemin que le garde reconnaît est celui-ci.
--
-- Le nom devient de ce fait **historique et non descriptif** : il ne cite pas
-- `locale`. C'est le prix assumé de la garantie ci-dessus, et il est modéré —
-- un `\d notification_templates` montre les colonnes de l'index, là où le nom
-- ne sert qu'à le désigner. `schema.prisma` le fixe par un `map:` explicite,
-- sans quoi Prisma le renommerait à la première migration suivante et rouvrirait
-- un `DROP` orphelin.
--
-- L'ordre est **DROP puis CREATE**, et non l'inverse : les deux index porteraient
-- le même nom, et PostgreSQL refuserait la création avant la suppression. Les
-- deux instructions sont dans la même transaction — Prisma joue chaque migration
-- dans la sienne —, donc atomiques ensemble, ce qui est exactement ce qu'on veut
-- d'un remplacement.
--
-- La création ne peut pas échouer sur une donnée existante : la nouvelle clé est
-- **plus fine** que l'ancienne, qui tenait jusqu'ici. Deux lignes que le nouvel
-- unique refuserait auraient déjà été refusées par l'ancien.
DROP INDEX "notification_templates_tenant_id_type_channel_key";
CREATE UNIQUE INDEX "notification_templates_tenant_id_type_channel_key"
    ON "notification_templates"("tenant_id", "type", "channel", "locale");
