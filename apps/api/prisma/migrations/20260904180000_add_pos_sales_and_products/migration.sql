-- POS de base — lignes de vente, produits retail, total serveur (#60,
-- CDC §1.4 « encaissement carte/espèces, POS simple : services + produits
-- retail »).
--
-- ## Ce que la migration pose
--
-- Trois tables et une colonne :
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `products` | le rayon revendable — nom, code, prix, devise, activation |
-- | `sales` | le ticket : rendez-vous ou vente autonome, opérateur, quatre montants |
-- | `sale_items` | les lignes du ticket, dont taxes et pourboires |
-- | `tenants.tax_rate_bps` | le taux de taxe du salon, en points de base |
--
-- ## Pourquoi une table `products`, et pas un libellé libre sur la ligne
--
-- Le troisième critère de #60 dit que « le total est recalculé côté serveur ;
-- le montant envoyé par le front ne fait jamais autorité ». Un produit saisi au
-- comptoir sous la forme « un nom, un montant » ferait exactement l'inverse :
-- le montant encaissé viendrait du navigateur. La table est ce qui donne au
-- prix une source côté serveur, au même titre que `services.price_amount_minor`
-- en donne une aux prestations.
--
-- ## Pourquoi les montants sont écrits sur `sales` alors qu'ils se déduisent
--
-- `subtotal`, `tax`, `tip` et `total` sont la somme des lignes : ils
-- pourraient se recalculer à chaque lecture. Ils sont figés parce qu'un ticket
-- est une pièce comptable — un taux de taxe modifié demain, un article
-- retarifé la semaine prochaine, et le ticket d'hier changerait de montant sous
-- les yeux du rapprochement. `sales_total_amount_minor_check` maintient leur
-- cohérence dans PostgreSQL, pas seulement dans le service qui les compose.
--
-- ## Le taux en points de base
--
-- `tax_rate_bps` est un entier : `2000` vaut 20 %. Un taux fractionnaire aurait
-- introduit un type à virgule sur le chemin de l'argent, ce que le principe 2
-- de ce schéma refuse. Le calcul de la ligne de taxe reste une multiplication
-- d'entiers suivie d'une division entière — exacte, reproductible, et sans
-- arrondi qui dépende de l'ordre des opérations.
--
-- `DEFAULT 0` : l'ajout est sans effet sur les établissements déjà en base.
-- Aucune ligne de taxe n'est composée à taux nul, et le ticket est exactement
-- celui qu'il aurait été sans la colonne.
--
-- ## Les contraintes que Prisma ne sait pas exprimer (api-module §6)
--
-- - **Clés étrangères composites `(tenant_id, …)`** vers `tenants(id)` exclu :
--   `tenant_id` sur la table est nécessaire, il n'est pas suffisant. Sans
--   elles, un ticket du salon A pourrait facturer la prestation du salon B, ou
--   nommer comme opérateur un compte d'ailleurs.
-- - **`CHECK` sur les montants** : un prix négatif, une ligne dont le montant
--   ne vaut pas `unit × quantity`, un total qui ne somme pas ses parts — rien
--   de tout cela ne fait planter quoi que ce soit. Cela fausse silencieusement
--   le « mesurer » de la boucle de valeur.
-- - **`sale_items_reference_check`** : une ligne `SERVICE` référence une
--   prestation et rien d'autre, une ligne `PRODUCT` un article et rien
--   d'autre, une ligne `TAX` ou `TIP` ne référence rien. Sans cette contrainte,
--   une ligne de pourboire pointant une prestation serait représentable, et le
--   reporting compterait le pourboire comme une prestation vendue.
--
-- ## Purement additive, et réversible
--
-- Trois tables créées, un type créé, une colonne ajoutée avec valeur par
-- défaut. Aucune table existante n'est retypée, aucune colonne n'est retirée,
-- aucune donnée n'est réécrite. `ADD COLUMN` avec `DEFAULT` constant ne
-- réécrit pas la table sur PostgreSQL 11+ : le catalogue seul est touché.
--
-- L'inverse exact est le retrait des trois tables, du type et de la colonne ;
-- il ne perd que les ventes saisies depuis le déploiement. Le retour arrière du
-- **code** seul est sans effet de bord — la version antérieure ignore ces
-- tables et n'écrit rien qui en dépende.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression et les
-- noms de types à virgule : `prisma-schema.spec.ts` relit le **texte** de la
-- migration, commentaires compris, pour interdire toute instruction
-- destructive et tout type inexact sur un montant. Il ne peut pas distinguer
-- une phrase d'une instruction.)

-- CreateEnum
CREATE TYPE "SaleItemKind" AS ENUM ('SERVICE', 'PRODUCT', 'TAX', 'TIP');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "tax_rate_bps" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "price_amount_minor" INTEGER NOT NULL,
    "price_currency" CHAR(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID,
    "cashier_user_id" UUID NOT NULL,
    "subtotal_amount_minor" INTEGER NOT NULL,
    "tax_amount_minor" INTEGER NOT NULL,
    "tip_amount_minor" INTEGER NOT NULL,
    "total_amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "kind" "SaleItemKind" NOT NULL,
    "service_id" UUID,
    "product_id" UUID,
    "label" VARCHAR(160) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_amount_minor" INTEGER NOT NULL,
    "line_amount_minor" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_sku_key" ON "products"("tenant_id", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_tenant_id_id_key" ON "products"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "products_tenant_id_is_active_name_idx" ON "products"("tenant_id", "is_active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_id_key" ON "sales"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "sales_tenant_id_created_at_idx" ON "sales"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_tenant_id_appointment_id_idx" ON "sales"("tenant_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_tenant_id_sale_id_position_key" ON "sale_items"("tenant_id", "sale_id", "position");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_user_id_fkey" FOREIGN KEY ("cashier_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Clés étrangères composites — la frontière du tenant en base
--
-- Chaque référence vers une table métier est doublée d'une clé qui embarque
-- `tenant_id`. C'est elle, et non la colonne seule, qui rend impossible de
-- facturer sur le ticket d'un salon la prestation, l'article, le rendez-vous ou
-- l'opérateur d'un autre.

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_appointment_id_fkey" FOREIGN KEY ("tenant_id", "appointment_id") REFERENCES "appointments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_cashier_user_id_fkey" FOREIGN KEY ("tenant_id", "cashier_user_id") REFERENCES "users"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "services"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK
--
-- Prisma n'exprime aucune contrainte `CHECK`. Sans elles, le schéma accepte un
-- ticket dont le total ne somme pas ses lignes, une quantité nulle, un taux de
-- taxe de 300 %, ou une ligne de pourboire qui prétend vendre une prestation.

-- AddCheck
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_tax_rate_bps_check" CHECK ("tax_rate_bps" >= 0 AND "tax_rate_bps" <= 10000);

-- AddCheck
ALTER TABLE "products" ADD CONSTRAINT "products_price_amount_minor_check" CHECK ("price_amount_minor" >= 0);

-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_subtotal_amount_minor_check" CHECK ("subtotal_amount_minor" >= 0);

-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_tax_amount_minor_check" CHECK ("tax_amount_minor" >= 0);

-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_tip_amount_minor_check" CHECK ("tip_amount_minor" >= 0);

-- Le total ne se contente pas d'être positif : il **somme ses parts**. C'est la
-- garantie que le serveur est la seule autorité sur le montant du ticket.
-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_total_amount_minor_check" CHECK ("total_amount_minor" >= 0 AND "total_amount_minor" = "subtotal_amount_minor" + "tax_amount_minor" + "tip_amount_minor");

-- AddCheck
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_quantity_check" CHECK ("quantity" > 0);

-- AddCheck
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_unit_amount_minor_check" CHECK ("unit_amount_minor" >= 0);

-- AddCheck
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_line_amount_minor_check" CHECK ("line_amount_minor" >= 0 AND "line_amount_minor" = "unit_amount_minor" * "quantity");

-- AddCheck
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_position_check" CHECK ("position" >= 0);

-- Une ligne porte exactement la référence de sa nature : la prestation pour
-- `SERVICE`, l'article pour `PRODUCT`, aucune des deux pour `TAX` et `TIP`.
-- AddCheck
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_reference_check" CHECK ((("kind" = 'SERVICE') AND "service_id" IS NOT NULL AND "product_id" IS NULL) OR (("kind" = 'PRODUCT') AND "product_id" IS NOT NULL AND "service_id" IS NULL) OR (("kind" IN ('TAX', 'TIP')) AND "service_id" IS NULL AND "product_id" IS NULL));
