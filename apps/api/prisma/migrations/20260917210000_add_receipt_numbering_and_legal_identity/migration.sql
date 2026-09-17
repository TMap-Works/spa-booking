-- Numéroter les tickets de caisse et porter l'identité légale du salon — #818,
-- suite de #817, CDC §1.4 et payments-stripe §4.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `receipt_counters` | le compteur de pièces, **une ligne par établissement** |
-- | `sales.receipt_number` | le rang de la pièce dans la suite du salon |
-- | `sales_tenant_id_receipt_number_key` | « deux ventes ne portent jamais le même rang », rendu non représentable |
-- | `tenants.legal_name` … `receipt_prefix` | l'identité légale et la forme du numéro |
-- | `payments.tendered_amount_minor` | ce que la cliente a tendu, d'où se déduit la monnaie rendue |
--
-- ## Le constat qu'elle referme
--
-- Une vente n'était identifiée que par un UUID. Aucune numérotation
-- chronologique et continue n'existait, alors que c'est la première chose
-- qu'on attend d'une pièce de caisse — et `tenants` ne portait ni raison
-- sociale, ni identifiant d'entreprise, ni numéro de TVA. Le reçu relevé par le
-- PO le 16/09/2026 tenait en une ligne : ni salon, ni numéro, ni taxe.
--
-- ## Pourquoi un compteur verrouillé, et non une `SEQUENCE`
--
-- C'est le cœur du premier critère — « la suite n'a aucun trou, même sous
-- concurrence » — et les deux solutions faciles échouent chacune sur une moitié
-- de l'énoncé :
--
-- - une `SEQUENCE` PostgreSQL ne revient **pas** en arrière quand la
--   transaction qui l'a consommée échoue. C'est sa propriété de conception, et
--   c'est exactement le trou que le critère interdit : un règlement refusé par
--   `sales_settled_amount_minor_check` aurait emporté un rang avec lui ;
-- - `MAX(receipt_number) + 1` échoue sur l'autre moitié : deux clôtures
--   simultanées lisent le même maximum et écrivent le même rang. L'unique
--   ci-dessous en refuserait une, et le comptoir recevrait une panne là où il
--   doit recevoir un ticket. C'est une vérification applicative, et CLAUDE.md
--   range « zéro double » de ce rang-là en base, jamais dans le service
--   (contrainte n°4).
--
-- Une **ligne** de compteur, lue `FOR UPDATE` dans la transaction de clôture,
-- tient les deux : le verrou sérialise les concurrents — le second attend, puis
-- relit la valeur que le premier vient de valider —, et l'incrément revient en
-- arrière avec la transaction qui l'a pris. C'est la conduite qu'ADR 0002 impose
-- au moteur de réservation, appliquée à l'invariant équivalent de la caisse.
--
-- ## Une ligne par salon, et c'est la clé primaire qui le dit
--
-- `receipt_counters_pkey` porte `("tenant_id")`, et rien d'autre. Un compteur
-- en double serait deux suites concurrentes sur la même colonne, c'est-à-dire un
-- trou garanti dès la deuxième clôture ; la base l'interdit plutôt que le code
-- ne le surveille. La table porte malgré tout un `id` en UUID, parce que toute
-- table de ce schéma en porte un (`prisma-schema.spec.ts`) — un compteur n'a pas
-- d'adresse publique, il s'atteint par son établissement.
--
-- ## Le rang est attribué **à la clôture**, d'où la colonne nullable
--
-- Un ticket ouvert puis abandonné au comptoir ne doit consommer aucun rang :
-- numéroter à l'ouverture aurait percé la suite au premier panier délaissé.
-- `sales.receipt_number` est donc nul tant que `settled_at` l'est, et
-- PostgreSQL tenant deux valeurs nulles pour distinctes, autant de tickets
-- ouverts qu'on veut cohabitent sous l'unique.
--
-- Aucun `CHECK` n'impose « close donc numérotée » : les ventes déjà closes
-- avant cette migration seraient toutes en faute au moment même où le
-- rattrapage ci-dessous tente de les corriger, et une contrainte qui refuse la
-- réparation de son propre motif n'est pas une contrainte utile. L'invariant est
-- tenu par la transaction de clôture et vérifié par
-- `pos-receipt.concurrency-spec.ts`.
--
-- ## Unique **par établissement**, jamais globalement
--
-- `sales_tenant_id_receipt_number_key` porte `(tenant_id, receipt_number)`,
-- comme tout unique métier de ce schéma (tenant-isolation §1). Deux salons ont
-- le droit d'émettre chacun leur pièce n° 1 — ils ne se citent pas l'un
-- l'autre —, et une unicité globale aurait fait dépendre la numérotation d'un
-- salon du volume de tous les autres. L'index sert les deux usages d'un seul
-- objet : il garantit l'unicité du rang et il sert la recherche d'un ticket par
-- son numéro au comptoir.
--
-- ## Ni année, ni série
--
-- La suite est **continue par établissement**. L'année du format affiché —
-- `{PRÉFIXE}-{AAAA}-{000123}`, deuxième critère — n'est qu'une lecture de la
-- date de la pièce : un compteur remis à zéro chaque exercice produirait deux
-- ventes de même rang dans deux années, que l'unique ci-dessus refuse d'écrire.
-- Le préfixe, lui, vit sur l'établissement, si bien qu'un salon qui en change ne
-- réécrit pas ses tickets passés — il change ce que les prochains afficheront.
--
-- ## L'identité légale : nullable, sauf le préfixe
--
-- Les cinq colonnes d'identité sont nullables parce qu'un salon inscrit avant ce
-- ticket n'a rien saisi et que son reçu doit continuer d'être servi — c'est ce
-- qui rend la migration purement additive. `receipt_prefix` fait exception avec
-- un défaut : il gouverne la **forme d'une pièce comptable** qui doit être
-- rendue pour toute vente close, y compris celle d'un établissement qui n'a
-- jamais ouvert son écran de réglages. Un préfixe nul aurait fait de
-- `null-2026-000123` un numéro.
--
-- `tenants_legal_id_completeness_check` lie la nature et l'identifiant comme
-- `tenants_address_completeness_check` lie la rue et la ville : un identifiant
-- sans sa nature ne se vérifie pas — une clé de Luhn ne s'applique qu'à un
-- SIRET — et une nature sans identifiant ne dit rien. La **vérification** des
-- valeurs, elle, vit dans le contrat partagé (`isValidLegalId`) : une clé de
-- Luhn ne s'écrit pas en `CHECK`, et la coder deux fois aurait produit deux avis
-- sur ce qu'est un SIRET valide.
--
-- ## `tendered_amount_minor`, et pourquoi la monnaie rendue n'est pas stockée
--
-- Le cinquième critère demande « la monnaie rendue pour les espèces ».
-- `settlement.rules.ts` la calculait déjà, mais la **perdait** : rien en base ne
-- la portait, si bien qu'un reçu réimprimé une heure plus tard ne pouvait plus
-- la dire. Une seule des deux valeurs est donc inscrite — ce que la cliente a
-- tendu —, et la monnaie s'en déduit. Stocker les deux aurait rendu
-- représentable une monnaie incohérente avec le billet.
--
-- ## Purement additive, et réversible
--
-- Une table, huit colonnes, un index unique, une clé étrangère, cinq `CHECK`.
-- Aucune colonne n'est retirée, aucune table retypée, aucune valeur existante ne
-- change de sens — le rattrapage ci-dessous ne fait qu'écrire des colonnes
-- créées vides par cette même migration. L'inverse exact est le retrait de la
-- table et des colonnes, et il ne perd que la numérotation acquise depuis le
-- déploiement.
--
-- Le retour arrière du **code** seul est sans effet de bord : la version
-- antérieure ignore ces colonnes, `receipt_number` étant nullable et
-- `receipt_prefix` ayant un défaut, ses écritures restent acceptées telles
-- quelles. Le seul coût d'un tel retour est un trou dans la suite, que la
-- reprise du code comblera en repartant du compteur.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression et les
-- noms de types à virgule : `prisma-schema.spec.ts` relit le texte de la
-- migration, commentaires compris, pour interdire toute instruction destructive
-- et tout type inexact sur un montant.)

-- CreateEnum
CREATE TYPE "LegalIdType" AS ENUM ('SIRET', 'SIREN', 'NIF', 'STAT', 'OTHER');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "legal_name" VARCHAR(160);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "legal_id_type" "LegalIdType";

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "legal_id" VARCHAR(32);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "vat_number" VARCHAR(32);

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "receipt_footer" VARCHAR(500);

-- Un défaut constant : PostgreSQL ne réécrit pas la table pour lui, et toute
-- ligne existante se met à porter « TIC » sans qu'une seule page ne bouge.
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "receipt_prefix" VARCHAR(8) NOT NULL DEFAULT 'TIC';

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "receipt_number" INTEGER;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "tax_rate_bps" INTEGER NOT NULL DEFAULT 0;

-- Le taux des tickets déjà écrits, repris **sur leur établissement**.
--
-- C'est exact pour toute ligne antérieure à cette migration, et pas une
-- approximation : jusqu'ici, `tenants.tax_rate_bps` n'avait aucune route
-- d'écriture — le commentaire du schéma le disait en toutes lettres, « le MVP
-- n'expose aucune route pour le régler » —, si bien que la valeur portée
-- aujourd'hui est celle qui était en vigueur quand chaque ticket a été composé.
--
-- Le déduire des montants aurait été faux : `subtotal_amount_minor` est arrondi
-- à l'unité, et un ticket de 65,00 € à 20 % rend 19,99 % à la division.
--
-- Le filtre sur la taxe garde à zéro les tickets composés **avant** que le salon
-- n'ait un taux : ils n'en portent pas, et leur en attribuer un annoncerait une
-- ventilation qu'ils n'ont jamais eue.
UPDATE "sales"
SET "tax_rate_bps" = "tenants"."tax_rate_bps"
FROM "tenants"
WHERE "sales"."tenant_id" = "tenants"."id" AND "sales"."tax_amount_minor" > 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "tendered_amount_minor" INTEGER;

-- CreateTable
CREATE TABLE "receipt_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "next_value" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_counters_pkey" PRIMARY KEY ("tenant_id")
);

-- Un compteur par établissement déjà inscrit. La clôture sait en créer un à la
-- volée — `ON CONFLICT DO NOTHING` — pour les salons qui naîtront après cette
-- migration ; le faire ici évite ce détour au premier ticket de chacun.
INSERT INTO "receipt_counters" ("id", "tenant_id", "next_value", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 1, now(), now()
FROM "tenants";

-- Rattrapage : une suite continue pour les ventes **déjà closes**.
--
-- Les laisser sans rang aurait donné à chaque salon une suite qui commence au
-- milieu de son histoire, avec un avant sans numéro : la première vente
-- numérotée aurait porté le n° 1 alors que douze pièces l'avaient précédée.
-- L'ordre retenu est celui de la clôture — la date de la pièce —, départagé par
-- la composition puis par l'identifiant, pour que deux ventes closes dans la
-- même milliseconde ne se réordonnent pas d'une lecture à l'autre.
WITH numbered AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tenant_id"
      ORDER BY "settled_at", "created_at", "id"
    ) AS "seq"
  FROM "sales"
  WHERE "settled_at" IS NOT NULL
)
UPDATE "sales"
SET "receipt_number" = numbered."seq"
FROM numbered
WHERE "sales"."id" = numbered."id";

-- Le compteur reprend après le dernier rang attribué. `+ 1` parce que
-- `next_value` est **le prochain rang à attribuer**, jamais le dernier
-- attribué : l'autre convention aurait obligé chaque lecteur à savoir s'il faut
-- ajouter un, et le premier qui l'oublie écrit deux fois le même rang.
UPDATE "receipt_counters" AS counters
SET
  "next_value" = 1 + COALESCE(
    (SELECT max("receipt_number") FROM "sales" WHERE "sales"."tenant_id" = counters."tenant_id"),
    0
  ),
  "updated_at" = now();

-- « Deux ventes du même salon ne portent jamais le même rang » — l'invariant du
-- premier critère, rendu non représentable.
-- CreateIndex
CREATE UNIQUE INDEX "sales_tenant_id_receipt_number_key" ON "sales"("tenant_id", "receipt_number");

-- AddForeignKey
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK

-- Le préfixe est ce qui rend le format décomposable : le tiret y est le
-- séparateur, et un préfixe qui en porterait ferait de `TI-C-2026-000123` un
-- numéro qu'aucun lecteur ne sait relire.
-- AddCheck
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_receipt_prefix_check" CHECK ("receipt_prefix" ~ '^[A-Z0-9]{2,8}$');

-- La nature et l'identifiant vont ensemble, ou ne sont pas là.
-- AddCheck
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_legal_id_completeness_check" CHECK (("legal_id_type" IS NULL) = ("legal_id" IS NULL));

-- Un rang commence à 1 : `0` et les rangs négatifs ne sont pas des pièces.
-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_receipt_number_check" CHECK ("receipt_number" IS NULL OR "receipt_number" > 0);

-- AddCheck
ALTER TABLE "receipt_counters" ADD CONSTRAINT "receipt_counters_next_value_check" CHECK ("next_value" > 0);

-- La même borne que `tenants_tax_rate_bps_check` : un taux hors de [0, 10000]
-- n'est pas un taux.
-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_tax_rate_bps_check" CHECK ("tax_rate_bps" >= 0 AND "tax_rate_bps" <= 10000);

-- Seul un règlement en espèces porte un billet tendu, et un billet ne vaut
-- jamais moins que ce qu'il règle : la monnaie rendue, qui s'en déduit, ne peut
-- donc pas être négative.
-- AddCheck
ALTER TABLE "payments" ADD CONSTRAINT "payments_tendered_amount_minor_check" CHECK ("tendered_amount_minor" IS NULL OR ("method" = 'CASH' AND "tendered_amount_minor" >= "amount_minor"));
