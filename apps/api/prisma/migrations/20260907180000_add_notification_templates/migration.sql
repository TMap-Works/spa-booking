-- Modèles de messages par établissement — #69, notifications §6, CDC §1.4.
--
-- « Un salon doit pouvoir personnaliser ses messages sans déploiement. » C'est
-- l'énoncé du ticket, et il désigne une table : tant que les modèles sont des
-- littéraux TypeScript, changer une formule de politesse demande une pull
-- request, une CI et une mise en production.
--
-- ## Ce que la migration ajoute
--
-- Une table, un unique composite, une clé étrangère. Rien d'autre — ni type, ni
-- colonne sur une table existante, ni index supplémentaire.
--
-- ## Pourquoi elle ne stocke pas les modèles par défaut
--
-- Parce qu'ils n'ont pas d'établissement. Les inscrire ici aurait demandé un
-- `tenant_id` nullable, c'est-à-dire une ligne que l'extension de scoping ne sait
-- pas borner (tenant-isolation §1, « toute table métier porte `tenant_id` non
-- nullable ») — et pas dans n'importe quelle table : celle qui décide de ce que
-- les clientes de chaque salon reçoivent. Une lecture qui échapperait au filtre
-- de tenant y servirait le modèle d'un concurrent.
--
-- La seule autre issue aurait été de recopier les quatre modèles de la plateforme
-- dans chaque établissement à sa création. Elle a été écartée pour une raison
-- d'exploitation : la correction d'une coquille dans la confirmation serait alors
-- devenue une migration de données sur tous les tenants, à rejouer à chaque
-- retouche, avec le risque d'écraser au passage la personnalisation d'un salon.
--
-- Les défauts vivent donc en code (`notification-default-templates.ts`), où ils
-- sont versionnés, relus et testés. **Une ligne absente n'est pas un manque** :
-- c'est un salon qui n'a rien personnalisé. Et supprimer la ligne *est* le retour
-- au défaut, sans qu'aucun contenu n'ait à être recopié.
--
-- ## L'unique est la clé de lecture, et il n'y a pas d'autre index
--
-- `(tenant_id, type, channel)` désigne exactement une personnalisation, et c'est
-- aussi la seule interrogation que fasse la résolution du modèle effectif — une
-- fois par message, juste avant l'envoi. Un second index n'aurait servi aucune
-- lecture et coûté une écriture de plus à chaque enregistrement.
--
-- `tenant_id` en tête, comme tout index de ce schéma : un index qui ne commence
-- pas par lui fait payer un parcours inter-établissement à une lecture qui est,
-- elle, toujours bornée à un salon.
--
-- ## Ni destinataire, ni contenu rendu
--
-- Un modèle porte `{{client}}`, jamais un nom de cliente. La règle du module —
-- « aucune donnée personnelle qui persiste » (CDC §5.1, notifications §7) — est
-- ici tenue par construction : il n'y a aucune colonne où une coordonnée pourrait
-- se glisser, et c'est ce qui permet de lire cette table au back-office sans
-- réserve.
--
-- ## `TEXT` pour les corps, `VARCHAR(200)` pour l'objet
--
-- PostgreSQL stocke `TEXT` et `VARCHAR(n)` exactement de la même façon : la borne
-- n'achète pas de place, elle achète un refus. Sur un corps HTML, ce refus se
-- serait produit un jour sur un modèle parfaitement légitime — une mise en page
-- d'e-mail dépasse volontiers deux mille caractères. Sur un objet, la borne a un
-- sens : au-delà de 200 caractères, un client mail tronque de toute façon, et un
-- objet démesuré est un défaut de saisie qu'il vaut mieux nommer à l'écriture.
--
-- La borne qui compte vraiment est ailleurs, et elle est applicative : le coût
-- d'un SMS. Un accent hors GSM-7 fait passer le message en UCS-2 et le limite à
-- 70 caractères au lieu de 160 (notifications §5) — c'est le cinquième critère
-- d'acceptation, et il se mesure sur un rendu, pas sur une longueur de colonne.
--
-- ## Purement additive, et réversible
--
-- Un `CREATE TABLE` sur une table qui n'existait pas : aucune ligne existante
-- n'est lue, réécrite ni verrouillée, et le déploiement se fait sans fenêtre.
--
-- L'inverse exact est la suppression de la table, et il ne perd que
-- les personnalisations déjà saisies. Le retour arrière du **code** seul est sans
-- effet de bord : la version antérieure ignore la table et rend les modèles de la
-- plateforme, c'est-à-dire exactement ce qu'elle faisait avant ce ticket. Les
-- clientes reçoivent alors le message par défaut — jamais rien.
--
-- `ON DELETE RESTRICT` sur la clé étrangère, comme partout ailleurs dans ce
-- schéma : la suppression d'un établissement est un geste qui se décide, pas un
-- effet de bord qui emporte ses données en cascade.

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body_html" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- Un message, un canal, un modèle. Composite avec le tenant, comme tout unique
-- métier : deux salons personnalisent chacun leur confirmation par e-mail, et
-- une unicité globale sur `(type, channel)` aurait donné le premier arrivé au
-- premier salon inscrit.
CREATE UNIQUE INDEX "notification_templates_tenant_id_type_channel_key" ON "notification_templates"("tenant_id", "type", "channel");

-- AddForeignKey
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
