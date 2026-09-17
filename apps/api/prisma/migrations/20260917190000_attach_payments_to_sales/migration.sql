-- Rattacher chaque règlement à sa vente — #817, CDC §2.4 et payments-stripe §4.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `payments.sale_id` | la pièce que le règlement solde — la moitié manquante de « 1–1 vers Appointment **ou vente POS** » |
-- | `payments_tenant_id_sale_id_fkey` | la frontière du tenant sur cette référence |
-- | `payments_sale_required_check` | « tout nouveau paiement porte une vente », appliqué sans relire l'existant |
-- | `sales.settled_amount_minor` | ce qui est déjà engagé sur le ticket |
-- | `sales.settled_at` | l'instant où il a été soldé |
-- | `sales_settled_amount_minor_check` | le dépassement rendu **non représentable** |
-- | `sales_settled_at_check` | une vente datée comme soldée l'est réellement |
--
-- ## Le constat qu'elle referme
--
-- `payments` ne se rattachait qu'à un rendez-vous. Composer une vente
-- n'encaissait rien, régler un rendez-vous ne créait aucune vente, et le revenu
-- se calculait sur les seuls encaissements : une vente de produits n'entrait
-- jamais au reporting. Relevé sur `spa_dev` le 16/09/2026 — douze ventes chez
-- Barber Tana dont aucune ne **pouvait** porter d'encaissement, et un écran
-- annonçant « 385,00 € · 5 encaissements » pour une unique vente de 106,80 €
-- comptée 65,00 €.
--
-- ## Pourquoi `sale_id` est nullable, et pourquoi la contrainte est `NOT VALID`
--
-- Les lignes déjà écrites n'ont pas de vente, et aucune valeur par défaut ne
-- peut en inventer une : rendre la colonne obligatoire d'emblée aurait fait
-- échouer la migration sur toute base non vide. `NOT VALID` est exactement
-- l'outil de cette situation — PostgreSQL applique la contrainte à chaque
-- écriture nouvelle et à chaque mise à jour de ligne, sans relire l'existant.
-- Le premier critère de #817 est donc tenu par la base pour tout ce qui vient,
-- pendant que `pos.sale-backfill.ts` rattrape ce qui précède. Une fois la
-- reprise jouée, une migration ultérieure pourra valider la contrainte ; cela
-- se décide sur l'état réel de la base, pas ici.
--
-- ## Pourquoi le dépassement est une contrainte et non un contrôle de service
--
-- « Zéro double encaissement » est du même rang que « zéro double
-- réservation » : il se tient en base, jamais par une vérification applicative
-- (CLAUDE.md, contrainte n°4). `sales_settled_amount_minor_check` rend
-- l'over-règlement impossible à écrire ; le service ajoute le montant dans une
-- transaction `Serializable`, comme `refunds.repository.ts` le fait déjà pour
-- le cumul des remboursements. Deux comptoirs qui règlent la même vente au
-- même instant ne peuvent donc ni lire tous deux « rien d'encaissé », ni
-- inscrire tous deux leur ligne : l'un aboutit, l'autre reçoit `40001` ou se
-- heurte au `CHECK`.
--
-- Ce que la contrainte ne peut pas exprimer, et qui est tenu ailleurs : que
-- `settled_amount_minor` soit bien la somme des encaissements engagés de la
-- vente. Cela porte sur un ensemble de lignes, et c'est la transaction qui
-- l'entretient — le même partage que pour `payment_refunds`.
--
-- ## `settled_at` et la date de solde
--
-- `sales_settled_at_check` n'oblige pas à dater une vente soldée : il interdit
-- de dater comme soldée une vente qui ne l'est pas. Une vente dont le total est
-- nul reste donc représentable sans date, ce qui est la conduite voulue — c'est
-- le règlement qui pose l'instant, pas l'arithmétique.
--
-- ## Purement additive, et réversible
--
-- Trois colonnes ajoutées, deux clés étrangères, deux index, trois `CHECK`.
-- Aucune colonne n'est retirée, aucune donnée réécrite, aucune table retypée,
-- aucun index existant touché — `payments_tenant_id_appointment_id_key` reste
-- en place et continue de garantir une intention en ligne par rendez-vous.
--
-- L'inverse exact est le retrait des trois colonnes et de leurs contraintes ; il
-- ne perd que le rattachement inscrit depuis le déploiement. Le retour arrière
-- du **code** seul est sans effet de bord : la version antérieure ignore ces
-- colonnes, et `sale_id` étant nullable, ses écritures restent acceptées tant
-- que la contrainte n'a pas été validée.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression et les
-- noms de types à virgule : `prisma-schema.spec.ts` relit le texte de la
-- migration, commentaires compris, pour interdire toute instruction destructive
-- et tout type inexact sur un montant.)

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "sale_id" UUID;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "settled_amount_minor" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN "settled_at" TIMESTAMPTZ(6);

-- « Qu'a-t-on déjà encaissé sur ce ticket ? » — la lecture que le règlement
-- fait avant d'inscrire une ligne de plus, et la jointure du revenu.
-- CreateIndex
CREATE INDEX "payments_tenant_id_sale_id_idx" ON "payments"("tenant_id", "sale_id");

-- « Qu'a-t-on soldé, et quand ? » — l'axe du rapprochement de caisse.
-- CreateIndex
CREATE INDEX "sales_tenant_id_settled_at_idx" ON "sales"("tenant_id", "settled_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## La clé composite — la frontière du tenant en base
--
-- `tenant_id` sur la table est nécessaire, il n'est pas suffisant : sans cette
-- clé-ci, un salon pourrait rattacher son encaissement au ticket d'un autre.
-- `sales (tenant_id, id)` est déjà unique depuis #60.

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_sale_id_fkey" FOREIGN KEY ("tenant_id", "sale_id") REFERENCES "sales"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ## Bornes métier — contraintes CHECK

-- Tout **nouveau** règlement porte sa vente. `NOT VALID` laisse l'existant tel
-- quel : c'est le script de reprise qui s'en charge, et lui seul.
-- AddCheck
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_required_check" CHECK ("sale_id" IS NOT NULL) NOT VALID;

-- Le cœur de « zéro double encaissement » : on ne peut pas engager plus que le
-- total du ticket, et on ne peut pas engager un montant négatif.
-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_settled_amount_minor_check" CHECK ("settled_amount_minor" >= 0 AND "settled_amount_minor" <= "total_amount_minor");

-- Une vente datée comme soldée est réellement soldée. L'inverse n'est pas
-- imposé : une vente à total nul reste sans date tant que personne ne l'a
-- réglée.
-- AddCheck
ALTER TABLE "sales" ADD CONSTRAINT "sales_settled_at_check" CHECK ("settled_at" IS NULL OR "settled_amount_minor" = "total_amount_minor");
