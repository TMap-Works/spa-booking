-- Encaisser la carte au comptoir par TPE — #834, ADR 0015 et payments-stripe §4.
--
-- ## Ce que la migration pose
--
-- | Objet | Ce qu'il porte |
-- |---|---|
-- | `PaymentCardChannel` | par quel tuyau une carte est passée : `STRIPE` ou `TERMINAL` |
-- | `payments.card_channel` | le tuyau de cette ligne — nul sur les espèces |
-- | `payments.terminal_reference` | le numéro du ticket ou de l'autorisation du TPE |
-- | `payments.idempotency_key` | la clé que l'appelant choisit pour que la double soumission rende le même règlement |
-- | `payments_card_channel_check` | un canal n'existe que sur une carte |
-- | `payments_terminal_reference_check` | une référence de terminal n'existe que sur un règlement au terminal |
-- | `payments_tenant_id_sale_id_idempotency_key_key` | l'unicité qui tranche deux soumissions concurrentes |
--
-- ## Le constat qu'elle referme
--
-- « Payer par carte » au comptoir ouvrait une intention Stripe et affichait le
-- formulaire de carte de Stripe **dans la page d'encaissement du back-office**
-- (`apps/web/.../admin/components/checkout-card-form.tsx`). La carte se
-- saisissait donc sur l'écran du salon, ce que payments-stripe §4 interdit
-- explicitement — « ne jamais saisir un numéro de carte dicté par le client
-- dans un formulaire, c'est exactement ce que SAQ A interdit ». S'y ajoutait un
-- fait de terrain : Stripe n'ouvre pas de compte marchand pour un
-- établissement installé à Madagascar, c'est-à-dire pour l'un des deux salons
-- du jeu d'essai.
--
-- Au comptoir, la carte se règle sur le **TPE de la banque du salon**.
-- L'application n'a rien à toucher : elle enregistre ce que le caissier
-- déclare — le moyen, le montant, l'opérateur, l'horodatage, et la référence du
-- ticket du terminal s'il l'a sous la main.
--
-- ## Pourquoi un canal et non une valeur de plus dans `PaymentMethod`
--
-- Le troisième critère de l'issue laissait le choix ; l'ADR 0015 tranche pour le
-- canal, et pour une raison qui se mesure. `method` est lu par des
-- consommateurs qui n'ont aucune raison de connaître le tuyau : la ventilation
-- du revenu par moyen (`reporting`), le libellé du reçu, le filtre de
-- rapprochement du back-office. Ajouter `CARD_TERMINAL` à l'énumération aurait
-- **changé le sens** de leur filtre `CARD` du jour au lendemain, en silence, et
-- obligé à reprendre trois écritures situées hors de l'empreinte de ce
-- ticket — dont un témoin qui asserte l'égalité de la liste applicative avec
-- l'énumération PostgreSQL.
--
-- Les deux faits sont orthogonaux : ce que la cliente a présenté, et par où
-- cela est passé. Le schéma les sépare, et le TPE **intégré** de #833 entrera
-- comme un troisième canal sans toucher au moyen.
--
-- ## Les lignes existantes ne sont **pas** reprises, et ce n'est pas un oubli
--
-- La version d'abord écrite de cette migration portait les lignes `CARD`
-- existantes à `STRIPE` — un `UPDATE` d'une ligne de la forme « dis ce que tu es
-- déjà », le TPE n'existant pas avant ce ticket. Elle a échoué sur `spa_dev` :
--
--   ERROR: new row for relation "payments" violates check constraint
--          "payments_sale_required_check"
--
-- La cause est `payments_sale_required_check`, posé **`NOT VALID`** par #817 :
-- PostgreSQL ne relit pas l'existant à la pose, mais il applique la contrainte à
-- **toute mise à jour** d'une ligne ancienne. Un règlement inscrit avant #817
-- n'a pas de vente ; le toucher, même pour une colonne sans rapport, le rend
-- donc irrecevable. La reprise aurait échoué sur toute base où
-- `pos.sale-backfill.ts` n'a pas encore tourné — c'est le cas de `spa_dev`
-- aujourd'hui, et rien ne dit que ce n'est pas celui de la recette.
--
-- Ce n'est pas un défaut que la CI pouvait voir : elle rejoue les migrations sur
-- un PostgreSQL neuf, où la table est vide et la reprise un geste sans effet.
--
-- La conduite retenue est donc de **ne toucher aucune ligne** :
-- `payments_card_channel_check` n'exige pas le canal de toute carte, il interdit
-- d'en porter un ailleurs que sur une carte. Toutes les lignes existantes le
-- satisfont — leur canal est nul — et la contrainte est donc posée **valide**,
-- sans `NOT VALID`, donc sans rendre aucune ligne irrecevable à sa prochaine
-- mise à jour.
--
-- Ce que cela laisse représentable, et qui est sans conséquence : une carte dont
-- le canal est nul. Elle ne peut être qu'antérieure à ce ticket, donc une
-- intention Stripe — les deux seuls chemins d'écriture d'une carte posent
-- désormais leur canal (`payments.repository.ts` pose `STRIPE`,
-- `settlement.repository.ts` pose `TERMINAL`). C'est ce que `settlementMeanOf`
-- énonce en repliant « carte sans canal » sur `CARD_ONLINE`, et ce que le filtre
-- de `GET /sales?method=CARD_ONLINE` accepte explicitement.
--
-- ## Purement additive, et réversible
--
-- Un type d'énumération créé, trois colonnes ajoutées, un index unique, deux
-- bornes `CHECK`. **Aucune ligne n'est écrite.** Aucune colonne n'est retirée,
-- aucun index existant touché, aucune table retypée, aucun montant approché par
-- un type à virgule. `PaymentMethod` n'est pas modifié — c'est tout l'objet du
-- choix ci-dessus.
--
-- L'inverse exact est le retrait des trois colonnes, de leurs bornes, de
-- l'index et du type ; il ne perd que ce qui a été inscrit depuis le
-- déploiement. Le retour arrière du **code** seul est sans effet de bord : la
-- version antérieure n'écrit pas ces colonnes, et les bornes ci-dessous
-- n'exigent rien d'elle — un canal nul est admis. C'est la seconde raison de
-- préférer l'implication à l'équivalence : une équivalence aurait fermé
-- l'encaissement par carte au premier retour arrière du code.
--
-- (Ce commentaire évite délibérément les mots-clés SQL de suppression et les
-- noms de types à virgule : `prisma-schema.spec.ts` relit le texte de la
-- migration, commentaires compris, pour interdire toute instruction destructive
-- et tout type inexact sur un montant.)

-- CreateEnum
CREATE TYPE "PaymentCardChannel" AS ENUM ('STRIPE', 'TERMINAL');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "card_channel" "PaymentCardChannel";

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "terminal_reference" VARCHAR(32);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "idempotency_key" VARCHAR(128);

-- ## L'unicité de la clé d'idempotence — portée au ticket
--
-- Deux soumissions concurrentes portant la même clé sur le même ticket se
-- sérialisent déjà sur le verrou de la ligne `sales` que prend
-- `settlement.repository.ts` ; cet index est le filet, du même rang que
-- `sales_settled_amount_minor_check` pour le double encaissement. Il est
-- préfixé de `tenant_id`, comme tout index de ce schéma.
-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_sale_id_idempotency_key_key" ON "payments"("tenant_id", "sale_id", "idempotency_key");

-- ## Bornes métier — contraintes CHECK

-- « Un canal n'existe que sur une carte. » C'est ce qui interdit qu'un règlement
-- en espèces se voie attribuer un tuyau — le rapprochement compterait alors un
-- passage au terminal qui n'a pas eu lieu.
--
-- Une **implication** et non une équivalence, pour la raison développée en tête :
-- exiger le canal de toute carte aurait demandé de reprendre les lignes
-- existantes, et un `UPDATE` sur une ligne antérieure à #817 se heurte à
-- `payments_sale_required_check`. Ce que l'implication laisse ouvert — une carte
-- sans canal — n'est écrit par aucun chemin du code et ne peut donc qu'être
-- antérieur à ce ticket, c'est-à-dire une intention Stripe.
-- AddCheck
ALTER TABLE "payments" ADD CONSTRAINT "payments_card_channel_check" CHECK ("card_channel" IS NULL OR "method" = 'CARD');

-- Une référence de terminal n'a de sens que sur un règlement passé au terminal.
-- La borne est dans ce sens-là seulement : la référence reste facultative, le
-- caissier n'ayant pas toujours le ticket du TPE sous la main.
-- AddCheck
ALTER TABLE "payments" ADD CONSTRAINT "payments_terminal_reference_check" CHECK ("terminal_reference" IS NULL OR "card_channel" = 'TERMINAL');
