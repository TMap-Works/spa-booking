-- Sessions de rafraîchissement — l'état qui rend la déconnexion invalidante (#21).
--
-- Purement additive : une table, ses index, ses clés étrangères. Rien
-- d'existant n'est touché — ni colonne ajoutée, ni type modifié, ni donnée
-- transformée. Elle s'applique sur une base portant déjà le schéma initial.
--
-- Réversibilité : l'inverse exact est la suppression de la table
-- « refresh_tokens », et rien d'autre. Aucune autre table n'en dépend, aucune
-- donnée métier n'y transite — une session perdue se retraduit par une
-- reconnexion. L'instruction n'est pas écrite ici, fût-ce en commentaire :
-- `prisma-schema.spec.ts` relit ce fichier pour vérifier qu'il est purement
-- additif, et il lit le texte, pas les intentions.
--
-- Pourquoi de l'état en base pour un jeton signé : un JWT ne se révoque pas. Tant
-- qu'il n'a pas expiré, il reste valable, et « se déconnecter » ne serait
-- qu'effacer un cookie — ce que l'attaquant qui l'a volé ne fera pas. La ligne
-- ci-dessous est ce que la déconnexion éteint, et c'est elle que le
-- rafraîchissement consulte avant d'émettre quoi que ce soit.
--
-- Invariants vérifiés par `src/infrastructure/database/__tests__/prisma-schema.spec.ts` :
-- `tenant_id` NOT NULL, index préfixé `tenant_id`, unique métier composite avec
-- `tenant_id`, identifiants UUID, instants en `timestamptz`, clé étrangère
-- doublée d'une composite `(tenant_id, user_id)`.

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_id_token_hash_key" ON "refresh_tokens"("tenant_id", "token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tenant_id_id_key" ON "refresh_tokens"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_user_id_expires_at_idx" ON "refresh_tokens"("tenant_id", "user_id", "expires_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Clé étrangère composite
--
-- `refresh_tokens.user_id → users(id)` est muette sur le tenant : elle laisserait
-- une session du salon A désigner le compte du salon B. Porter `tenant_id` sur la
-- table est nécessaire, il n'est pas suffisant — c'est le couple qui interdit le
-- rattachement croisé.

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Borne de cohérence
--
-- Une session déjà expirée à sa création n'a aucun sens et masquerait une erreur
-- de calcul de TTL — un `REFRESH_TOKEN_TTL` mal lu produirait des sessions mortes
-- à l'émission, ce qui se diagnostique mal depuis le front (« la connexion ne
-- tient pas »).

-- AddCheckConstraint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_expires_at_check" CHECK ("expires_at" > "created_at");
