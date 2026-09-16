-- La référence citable d'un rendez-vous — #796, suite de #736.
--
-- « RDV-8F3K-27 » : le code qu'une cliente lit sur sa confirmation, dicte au
-- téléphone, et que le comptoir doit pouvoir **résoudre**. #736 l'affichait
-- déjà, mais elle était calculée côté front à partir de l'identifiant du
-- rendez-vous : elle n'existait que sur cet écran, et personne d'autre — ni le
-- back-office, ni l'e-mail de confirmation, ni aucune route — ne la connaissait.
--
-- ## Pourquoi une colonne, et non la dérivation partagée
--
-- La dérivation ne demandait aucune migration, et c'était son seul avantage.
-- Elle tirait un code dans un espace de `32⁴ × 100` valeurs que **rien ne
-- contraignait** : deux rendez-vous d'un même salon pouvaient porter la même
-- référence. Tant que le code sert à reconnaître son propre rendez-vous sur un
-- écran, l'ambiguïté ne coûte rien ; dès qu'on le **résout**, elle désigne la
-- mauvaise cliente au comptoir — c'est-à-dire exactement le geste que ce ticket
-- existe pour rendre possible.
--
-- Et une résolution par dérivation n'aurait pas été une lecture : faute d'être
-- inversible, elle aurait demandé de recalculer la référence de chaque ligne de
-- l'établissement pour trouver celles qui correspondent. Un parcours complet de
-- l'agenda à chaque appel téléphonique, pour une réponse éventuellement
-- multiple.
--
-- La colonne, elle, est unique par construction et se lit par son index.
--
-- ## Unique **par établissement**, jamais globalement
--
-- `appointments_tenant_id_reference_key` porte `(tenant_id, reference)`, comme
-- tout unique métier de ce schéma (tenant-isolation §1 : « les clés uniques
-- métier sont composites avec le tenant »). Deux salons ont le droit de tirer le
-- même code — ils ne se citent pas l'un à l'autre —, et une unicité globale
-- aurait fait dépendre le tirage d'un salon du volume de tous les autres.
--
-- L'index sert les deux usages d'un seul objet : il **garantit** l'unicité et il
-- **sert** la résolution. Préfixé de `tenant_id`, il ne peut pas non plus être
-- emprunté pour lire hors de son établissement.
--
-- ## Additive, et en trois temps
--
-- 1. `ADD COLUMN` nullable, sans valeur par défaut : mise à jour du catalogue,
--    sans réécriture de table depuis PostgreSQL 11 ;
-- 2. remplissage des lignes existantes — sans lui, l'étape 3 échouerait sur la
--    première ligne, et une colonne laissée nullable aurait signifié « des
--    rendez-vous sans référence », donc des rendez-vous que le comptoir ne peut
--    pas retrouver ;
-- 3. `SET NOT NULL` puis l'index unique.
--
-- Aucune colonne n'est retirée, aucune n'est retypée, aucune valeur existante ne
-- change de sens. L'inverse exact est le retrait de l'index puis de la colonne,
-- et il ne perd que la référence — jamais un rendez-vous.
--
-- ## La version **précédente** de l'API doit pouvoir continuer d'insérer
--
-- Le déploiement est progressif : la tâche de migration passe *avant* la bascule
-- du service (`.github/workflows/deploy-production.yml`), et le service bascule
-- à `deployment_minimum_healthy_percent = 100`
-- (`infra/terraform/modules/ecs-service/service.tf`) — les anciennes tâches
-- servent donc le trafic pendant toute la durée du remplacement. Pendant ces
-- quelques minutes, c'est du code qui **n'émet pas** `reference` qui insère.
--
-- Une colonne `NOT NULL` sans valeur par défaut aurait fait échouer chacune de
-- ces insertions : le tunnel public, la prise au comptoir et le report auraient
-- rendu 500 pendant toute la fenêtre — la boucle de valeur du produit, arrêtée
-- par une migration réputée additive. C'est la règle d'api-module §6 : une
-- migration ne casse pas « la version en cours d'exécution pendant un
-- déploiement progressif ».
--
-- D'où le `SET DEFAULT` posé en fin de fichier. Il ne rend la référence
-- **facultative** pour personne : la colonne reste `NOT NULL`, l'unique par
-- établissement continue de trancher, et toute ligne porte une référence de la
-- même forme, tirée dans le même alphabet. Il couvre la seule fenêtre où
-- l'émetteur n'est pas encore celui de ce ticket — et couvre du même geste le
-- retour arrière du code seul.
--
-- Il se retire de lui-même : `schema.prisma` ne le déclare pas, donc la
-- prochaine migration générée portera son `DROP DEFAULT`, c'est-à-dire une fois
-- que toutes les tâches émettent la référence.
--
-- ## Pourquoi le remplissage tire au sort plutôt que de dériver l'identifiant
--
-- Parce que la dérivation ne garantit rien, et que ce remplissage doit produire
-- des valeurs qui satisfont l'index unique qui suit. Tirer au sort et vérifier
-- est la conduite qu'aura le code ensuite ; la migration fait la même chose, et
-- ne laisse donc pas derrière elle des lignes obtenues autrement que les
-- suivantes.
--
-- L'alphabet est celui de Crockford — les chiffres et les lettres, moins `I`,
-- `L`, `O` et `U` —, recopié de `packages/shared/src/constants/appointment.ts`.
-- Les trois premières se confondent avec `1` et `0` dans la plupart des fontes,
-- et une référence est faite pour être recopiée à la main ou dictée.
--
-- `random()` de PostgreSQL n'est pas cryptographique, et ce n'en est pas un
-- usage : il remplit des lignes **déjà écrites**, dont personne n'a jamais reçu
-- la référence. Le code applicatif, lui, tire avec `node:crypto` — une référence
-- qu'on devine est une référence qu'on peut citer à la place de quelqu'un
-- d'autre.
--
-- ## Invariants
--
-- `src/infrastructure/database/__tests__/prisma-schema.spec.ts` relit ce texte :
-- migration additive (aucun retrait), tout unique métier composite avec
-- `tenant_id`, tout index préfixé de `tenant_id`.

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN "reference" VARCHAR(11);

-- Remplissage des lignes existantes : une référence libre par établissement.
DO $$
DECLARE
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- Cent tirages sur un espace de 104 857 600 valeurs : le plafond n'est pas là
  -- pour être atteint, il est là pour qu'un schéma imprévu échoue bruyamment
  -- plutôt que de boucler sans fin sur une base de recette.
  max_attempts CONSTANT INT := 100;
  target RECORD;
  candidate TEXT;
  attempt INT;
BEGIN
  FOR target IN SELECT "id", "tenant_id" FROM "appointments" WHERE "reference" IS NULL LOOP
    attempt := 0;
    LOOP
      attempt := attempt + 1;
      candidate := 'RDV-'
        || substr(alphabet, 1 + floor(random() * 32)::int, 1)
        || substr(alphabet, 1 + floor(random() * 32)::int, 1)
        || substr(alphabet, 1 + floor(random() * 32)::int, 1)
        || substr(alphabet, 1 + floor(random() * 32)::int, 1)
        || '-'
        || lpad(floor(random() * 100)::int::text, 2, '0');

      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM "appointments"
        WHERE "tenant_id" = target."tenant_id" AND "reference" = candidate
      );

      IF attempt >= max_attempts THEN
        RAISE EXCEPTION 'aucune reference libre apres % tirages pour le rendez-vous %',
          max_attempts, target."id";
      END IF;
    END LOOP;

    UPDATE "appointments" SET "reference" = candidate WHERE "id" = target."id";
  END LOOP;
END $$;

-- AlterTable
ALTER TABLE "appointments" ALTER COLUMN "reference" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_id_reference_key" ON "appointments"("tenant_id", "reference");

-- Le filet de la fenêtre de bascule — voir « La version précédente de l'API doit
-- pouvoir continuer d'insérer » en tête de fichier. Même alphabet et même forme
-- que le code ; `ALTER COLUMN … SET DEFAULT` ne réécrit pas la table, là où un
-- `ADD COLUMN … DEFAULT <volatile>` l'aurait réécrite — d'où sa place ici et non
-- en tête.
ALTER TABLE "appointments" ALTER COLUMN "reference" SET DEFAULT (
  'RDV-'
  || substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1)
  || substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1)
  || substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1)
  || substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', 1 + floor(random() * 32)::int, 1)
  || '-'
  || lpad(floor(random() * 100)::int::text, 2, '0')
);
