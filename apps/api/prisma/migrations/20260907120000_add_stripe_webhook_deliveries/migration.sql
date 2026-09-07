-- File durable des livraisons de webhook Stripe — #409, CDC §2.2.
--
-- ## Le trou que cette table bouche
--
-- Le point d'entrée des webhooks répond 200 **avant** de traiter, parce que
-- payments-stripe §3 l'exige : « répondre 200 rapidement, le traitement long
-- part en file ». La conséquence est rarement énoncée, et c'est elle qui fait
-- mal : à partir de cet accusé, **Stripe ne redélivre plus rien**. Il ne rejoue
-- que ce qu'il a vu échouer — un non-2xx, ou un délai dépassé.
--
-- Deux scénarios laissaient donc un encaissement `PENDING` et un rendez-vous
-- jamais confirmé, sans aucune nouvelle livraison et sans que rien ne le
-- signale, sauf à lire le journal :
--
-- 1. le traitement échoue en base — indisponibilité, interblocage, échec de
--    sérialisation ;
-- 2. le processus s'arrête brutalement avec des événements encore en file.
--
-- Dans les deux cas la cliente a été débitée.
--
-- ## Ce que la table change, et à quel instant précis
--
-- La ligne est inscrite **pendant la requête HTTP**, avant que le 200 ne parte.
-- C'est tout le dispositif :
--
-- | Instant | Avant | Maintenant |
-- |---|---|---|
-- | inscription impossible (base injoignable) | 200 rendu, événement perdu | pas de 2xx — **Stripe redélivre** |
-- | 200 rendu | événement en mémoire d'un processus | événement sur disque |
-- | processus tué | événement perdu | ligne `PENDING`, reprise par le balayage |
-- | traitement en échec | journal `error`, reprise manuelle | réessai borné, puis `DEAD` + alerte |
--
-- ## Pourquoi elle ne double pas `processed_webhook_events`
--
-- Elles ne portent pas le même objet. Celle-ci porte le **travail à faire** et
-- disparaît quand il est fait ; l'autre porte la **preuve que c'est fait** et
-- se conserve, parce que c'est elle qui rend un rejeu inoffensif. Conserver ici
-- les livraisons abouties ferait grossir une table pour redire ce que l'autre
-- dit déjà, et l'audit de réconciliation du CDC §4.9 s'appuie sur l'autre.
--
-- D'où le statut à **deux** valeurs seulement. `PENDING` couvre « jamais
-- tentée », « en cours » et « en attente d'un réessai » : ce sont `claimed_at`
-- et `next_attempt_at` qui les distinguent. `DEAD` est la file d'attente morte.
--
-- ## Le bail, ou comment reprendre ce qu'un mort tenait
--
-- `claimed_at` est la seule colonne qui demande une explication. Elle porte le
-- bail qu'une instance pose sur une livraison en la prenant :
--
-- - `NULL` — personne ne la tient ;
-- - récente — une instance la traite en ce moment, on n'y touche pas ;
-- - vieille de plus que le bail — l'instance qui la tenait ne répond plus.
--
-- Ce troisième état est exactement celui que laisse un `SIGKILL`, et c'est ce
-- qui permet à n'importe quelle instance de reprendre la livraison sans avoir à
-- savoir qu'une autre est morte. La prise est un `UPDATE` conditionnel — pas un
-- `SELECT` suivi d'un `UPDATE` : sous `READ COMMITTED`, PostgreSQL réévalue le
-- prédicat après avoir pris le verrou de ligne, si bien que de deux instances
-- qui prennent en même temps, une seule voit `count = 1`. C'est la base qui
-- tranche, pas le code (ADR 0002).
--
-- ## Additive et réversible
--
-- Rien d'existant n'est touché : un type et une table qui n'existaient pas. La
-- marche arrière est le retrait de la table puis celui du type, dans cet ordre,
-- sans perte de donnée métier — la table ne contient que du travail en cours, et
-- l'effet des livraisons abouties est déjà dans `payments` et `appointments`.
-- (Le SQL de ce retrait n'est pas écrit ici : `prisma-schema.spec.ts` interdit à
-- toute migration de contenir un ordre destructif, jusque dans ses commentaires,
-- et c'est une bonne chose — la marche arrière se joue à la main, en connaissance
-- de cause.)

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'DEAD');

-- CreateTable
CREATE TABLE "stripe_webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" VARCHAR(255) NOT NULL,
    "event_type" VARCHAR(255) NOT NULL,
    "serialization_key" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stripe_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- L'index du balayage : préfixé par `tenant_id`, comme tout index de ce schéma.
-- Le balayage lit sans portée de tenant par nécessité — une livraison orpheline
-- n'appartient à aucune requête —, mais la table ne contient que ce qui attend,
-- les succès étant supprimés. Un index sans `tenant_id` en tête aurait ouvert
-- une voie de lecture inter-établissement pour n'économiser rien.
-- Chaque ordre tient sur **une seule ligne**, comme ceux que Prisma génère :
-- `prisma-schema.spec.ts` lit ce fichier à l'expression rationnelle pour
-- vérifier les invariants du projet, et un ordre replié lui échapperait — la
-- table passerait alors pour dépourvue d'index et de clé étrangère, et le
-- contrôle qui devait la protéger ne dirait plus rien.
CREATE INDEX "stripe_webhook_deliveries_tenant_id_status_next_attempt_at_idx" ON "stripe_webhook_deliveries"("tenant_id", "status", "next_attempt_at");

-- Une redélivrance de Stripe arrivée pendant que la première attend son réessai
-- ne crée pas un second travail pour le même effet.
CREATE UNIQUE INDEX "stripe_webhook_deliveries_tenant_id_event_id_key" ON "stripe_webhook_deliveries"("tenant_id", "event_id");

-- `RESTRICT` comme partout ailleurs : la suppression d'un établissement est une
-- opération délibérée qui doit buter sur ce qui lui appartient encore, pas
-- emporter silencieusement des livraisons non traitées.
ALTER TABLE "stripe_webhook_deliveries" ADD CONSTRAINT "stripe_webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
