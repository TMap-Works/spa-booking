-- Ouvrir un salon depuis une console réservée à l'éditeur — #806, arbitrage du
-- PO du 16/09/2026 (#804), CDC §1.2, §2.3, §2.4.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `platform_operators` | l'identité de l'éditeur, **hors** établissement |
-- | `platform_tenant_provisionings` | « qui a ouvert quel salon, quand », et la clé d'idempotence |
-- | `platform_operators_email_key` | une adresse, un opérateur — unique **globalement** |
-- | `platform_tenant_provisionings_idempotency_key_key` | « la même clé n'ouvre jamais deux salons » |
--
-- ## Le constat qu'elle referme
--
-- Aucun code ne créait d'établissement : les salons de `spa_dev` venaient tous
-- du seed et des jeux d'essai de recette. `POST /v1/users` invite un compte
-- dans un établissement qui existe déjà ; rien ne créait le premier
-- administrateur d'un salon neuf. Le produit savait tout faire d'un salon, sauf
-- en ouvrir un.
--
-- ## Deux tables sans `tenant_id`, et pourquoi c'est licite
--
-- C'est l'exception que l'ADR 0012 tranche, et le critère y est écrit :
-- `tenant_id` protège les données **d'un établissement**, et une ligne qui
-- n'appartient à aucun établissement n'a rien à discriminer. Un opérateur
-- plateforme n'est pas une donnée de salon — il est au-dessus de tous. Lui
-- poser la colonne rattacherait l'identité de l'éditeur à l'un des salons qu'il
-- administre, c'est-à-dire l'inverse exact de ce que la règle cherche.
--
-- C'est la même lecture qui exempte déjà `tenants` : la racine ne porte pas la
-- colonne parce qu'elle *est* ce que la colonne désigne. Ces deux tables-ci ne
-- la portent pas parce qu'elles sont **au-dessus** de ce que la colonne désigne.
--
-- Le champ d'établissement du journal se nomme `created_tenant_id` et non
-- `tenant_id`. Ce n'est pas un déguisement : c'est l'énoncé du fait. La ligne
-- n'appartient pas au salon qu'elle nomme, elle appartient à l'acte de
-- l'éditeur qui l'a ouvert — et le nom garde `tenant-scope.extension.ts` de
-- prendre cette table pour une table de salon, lui qui déduit du champ
-- `tenantId` les modèles à filtrer.
--
-- ## L'unique de la clé d'idempotence est global, et il doit l'être
--
-- Tout unique métier de ce schéma est composite avec `tenant_id`
-- (tenant-isolation §1) — parce que deux salons ont le droit de nommer
-- pareillement leurs propres lignes. Ici, l'unique porte sur la clé seule, et
-- c'est précisément ce qui la rend utile : la clé est présentée **avant**
-- qu'aucun établissement n'existe, et un unique par établissement n'aurait
-- refusé aucun rejeu — chaque rejeu créant un salon de plus, donc une portée de
-- plus.
--
-- ## Le mot de passe est obligatoire, contrairement à celui d'un compte de salon
--
-- `users.password_hash` est nullable : un membre du personnel naît « invité »,
-- inconnectable jusqu'à ce qu'il pose son mot de passe. Un opérateur
-- plateforme, lui, naît par la commande d'exploitation `npm run
-- platform:operator`, qui lui pose son mot de passe initial et son secret TOTP
-- d'un même geste. Il n'y a donc pas d'état intermédiaire à représenter, et une
-- colonne nullable aurait rendu représentable un opérateur sans second facteur.
--
-- ## Purement additive, et réversible
--
-- Deux tables neuves, deux index uniques, deux clés étrangères. Aucune colonne
-- n'est retirée, aucune table retypée, aucune ligne existante ne change de sens :
-- le schéma d'avant cette migration reste valide pour la totalité du stock.
-- L'inverse exact est le retrait des deux tables, et il ne perd que les
-- opérateurs et le journal acquis depuis le déploiement.
--
-- Le retour arrière du **code** seul est sans effet de bord : la version
-- antérieure ignore ces deux tables, qu'aucune autre ne référence.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression :
-- `prisma-schema.spec.ts` relit le texte de la migration, commentaires compris,
-- pour interdire toute instruction destructive.)

-- CreateTable
CREATE TABLE "platform_operators" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "totp_secret" VARCHAR(64) NOT NULL,
    "first_name" VARCHAR(80) NOT NULL,
    "last_name" VARCHAR(80) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_tenant_provisionings" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "created_tenant_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_tenant_provisionings_pkey" PRIMARY KEY ("id")
);

-- Une adresse, un opérateur. Unique **globalement** : il n'y a qu'un espace
-- plateforme, et deux opérateurs sur la même adresse seraient deux identités
-- pour une seule boîte mail — donc deux MFA pour un seul destinataire.
-- CreateIndex
CREATE UNIQUE INDEX "platform_operators_email_key" ON "platform_operators"("email");

-- « La même clé n'ouvre jamais deux salons » — le critère 6, rendu non
-- représentable plutôt que surveillé par le service.
-- CreateIndex
CREATE UNIQUE INDEX "platform_tenant_provisionings_idempotency_key_key" ON "platform_tenant_provisionings"("idempotency_key");

-- « Les salons ouverts par cet opérateur », et le tri du journal par date.
-- CreateIndex
CREATE INDEX "platform_tenant_provisionings_operator_id_created_at_idx" ON "platform_tenant_provisionings"("operator_id", "created_at");

-- `RESTRICT` des deux côtés, comme partout dans ce schéma : un opérateur qui a
-- ouvert un salon ne s'efface pas, sans quoi le journal du critère 6 perdrait le
-- « qui ». La désactivation (`is_active`) est la façon dont on ferme un accès.
-- AddForeignKey
ALTER TABLE "platform_tenant_provisionings" ADD CONSTRAINT "platform_tenant_provisionings_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform_operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_tenant_provisionings" ADD CONSTRAINT "platform_tenant_provisionings_created_tenant_id_fkey" FOREIGN KEY ("created_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
