# apps/api/prisma — schéma et migrations

Modèle de données du CDC §2.4. Conventions d'écriture :
[api-module §6](../../../.claude/skills/api-module/SKILL.md) et
[tenant-isolation](../../../.claude/skills/tenant-isolation/SKILL.md).

```
schema.prisma                           source de vérité du modèle
migrations/
  migration_lock.toml                   connecteur verrouillé sur PostgreSQL
  20260825120000_initial_schema/        les sept entités du CDC
  20260825140000_add_refresh_tokens/    sessions de rafraîchissement (#21)
  20260826100000_add_manager_user_role/ `MANAGER` dans `enum UserRole` (#202)
  20260826150000_add_service_categories_and_buffers/
                                        catégories et tampons de prestation
  20260827120000_add_appointment_exclusion/
                                        contrainte anti-double-réservation (#31)
```

## Les neuf tables

| Table | Rôle | `tenant_id` |
|---|---|---|
| `tenants` | Établissement — racine de l'isolation | — (elle *est* le tenant) |
| `users` | Compte client / praticien / administrateur + rôle | oui |
| `services` | Prestation : nom, durée, prix, catégorie | oui |
| `staff` | Fiche praticien, rattachée à un `users` | oui |
| `service_staff` | Jonction N–N « ce praticien pratique cette prestation » | oui |
| `appointments` | Rendez-vous : créneau, statut, prix figé | oui |
| `payments` | Encaissement d'un rendez-vous ou vente retail | oui |
| `notifications` | Message émis : type, canal, statut, planification | oui |
| `refresh_tokens` | Session de rafraîchissement — ce qui rend la déconnexion invalidante (#21) | oui |

`refresh_tokens` n'est pas une neuvième entité métier : un JWT signé ne se
révoque pas, et sans ligne en base « se déconnecter » se réduirait à effacer un
cookie que l'attaquant qui l'a volé n'effacera pas. Elle est inscrite ici pour la
même raison que les autres — pour que son `tenant_id`, ses index et ses clés
composites soient relus par la suite de tests du schéma comme ceux de n'importe
quelle table métier.

`service_staff` est une table de jonction **explicite** : une relation N–N
implicite de Prisma produirait une table `_ServiceToStaff` sans `tenant_id`, et
il n'y aurait alors rien à quoi accrocher la frontière. Porter la colonne ne
suffit pourtant pas — les clés étrangères que Prisma génère sont mono-colonne,
donc muettes sur le tenant. Ce sont les clés **composites** `(tenant_id, id)`,
posées en SQL brut à la fin de la migration, qui interdisent réellement
d'affecter le praticien d'un salon à la prestation d'un autre.

## Les invariants, et ce qui les tient

Aucun de ces invariants n'est vérifiable par le compilateur — Prisma accepterait
sans broncher un `tenant_id` nullable ou un prix en flottant. Ils sont donc
vérifiés par un test qui relit le SQL de migration :
[`src/infrastructure/database/__tests__/prisma-schema.spec.ts`](../src/infrastructure/database/__tests__/prisma-schema.spec.ts).
Il **découvre** les tables au lieu de les énumérer : une table ajoutée demain
sans `tenant_id` fait rougir la suite sans que personne ait pensé à l'y inscrire.

- `tenant_id` non nullable et référencé vers `tenants` sur toute table métier ;
- tout index commence par `tenant_id`, tout unique métier est composite avec lui ;
- toute référence entre tables métier est **doublée d'une clé étrangère
  composite** `(tenant_id, id)` — une clé mono-colonne laisserait la ligne d'un
  salon en référencer une autre ;
- identifiants UUID v4 générés côté application — aucun entier séquentiel ;
- `tenants.timezone` (IANA) obligatoire et **sans valeur par défaut** ;
- montants en entiers (`*_amount_minor`) accompagnés d'un code devise ISO 4217 —
  aucun type flottant dans tout le schéma ;
- bornes tenues par des contraintes `CHECK` et non par la vigilance de
  l'appelant : montants positifs, remboursement borné par l'encaissement, durée
  de prestation strictement positive, `ends_at > starts_at` ;
- tout instant en `timestamptz`, stocké en UTC ;
- `created_at` / `updated_at` sur chaque table ;
- aucune colonne susceptible de porter une donnée de carte (périmètre PCI SAQ A).

## Travailler avec

```bash
npm run db:migrate --workspace @spa/api          # créer/appliquer en local (prisma migrate dev)
npm run db:migrate:deploy --workspace @spa/api   # appliquer en déployé (prisma migrate deploy)
npm run db:generate --workspace @spa/api         # régénérer le client
```

Le client est régénéré automatiquement au `postinstall` du workspace : `npm ci`
suffit pour que `tsc` et les tests trouvent les types.

`prisma` est une dépendance de **développement** : une image construite avec
`npm ci --omit=dev` n'a pas la CLI, et le `postinstall` échoue avant même de
commencer. Le Dockerfile à venir installe donc tout, génère le client, construit,
puis élague — jamais l'inverse.

La CI applique réellement la migration avant les tests — l'étape
`npm run db:migrate:deploy` du job `test` de
[ci.yml](../../../.github/workflows/ci.yml) la rejoue sur un PostgreSQL 16 neuf.
Une migration syntaxiquement fausse ne peut donc pas être mergée.

## Règles de migration

- **Une migration par PR**, nommée en clair.
- **Additive par défaut.** Supprimer une colonne se fait en deux déploiements —
  cesser de la lire, puis la supprimer — pour ne pas casser la version en cours
  d'exécution pendant un déploiement progressif.
- Ce que Prisma ne sait pas exprimer s'écrit en SQL brut dans le fichier de
  migration, avec le commentaire qui dit pourquoi. C'est le cas des clés
  étrangères composites et des contraintes `CHECK` de la migration initiale, et
  celui de la contrainte d'exclusion anti-double-réservation, posée par
  `20260827120000_add_appointment_exclusion` (#31, [ADR 0002](../../../docs/adr/0002-anti-double-reservation.md)) :

  ```sql
  CREATE EXTENSION IF NOT EXISTS "btree_gist";

  ALTER TABLE "appointments"
      ADD COLUMN "time_range" tstzrange
      GENERATED ALWAYS AS (tstzrange("starts_at", "ends_at", '[)')) STORED;

  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
    EXCLUDE USING gist (
      "tenant_id"  WITH =,
      "staff_id"   WITH =,
      "time_range" WITH &&
    )
    WHERE ("status" IN ('PENDING', 'CONFIRMED'));
  ```

  Trois détails qui ne sont pas des détails : `btree_gist` est ce qui autorise
  `=` sur un `uuid` à l'intérieur d'un index GiST ; la borne `[)` est ce qui rend
  deux rendez-vous **adjacents** légaux, sans quoi l'agenda perdrait un créneau
  sur deux ; et le `WHERE` partiel n'est pas une optimisation — sans lui, un
  rendez-vous annulé ou marqué no-show bloquerait son créneau pour toujours
  (booking-engine §1).
- **`prisma migrate dev` ne rend pas un fichier applicable tel quel**, et c'est
  la contrepartie du point précédent : ce qu'il ne sait pas exprimer, il ne sait
  pas non plus le lire en base, et il écrit donc dans chaque migration générée de
  quoi le défaire. Deux relevés, à retirer du fichier avant de le committer :

  ```sql
  -- les clés étrangères composites (tenant_id, id), invisibles à Prisma
  ALTER TABLE "appointments" DROP CONSTRAINT "appointments_tenant_id_staff_id_fkey";
  -- la colonne générée, dont Prisma lit l'expression comme une valeur par défaut
  ALTER TABLE "appointments" ALTER COLUMN "time_range" DROP DEFAULT;
  ```

  La seconde échoue à l'application — *column "time_range" of relation
  "appointments" is a generated column* —, ce qui la rend visible ; les premières
  s'appliquent en silence et emporteraient la frontière de tenant. Relire le
  fichier généré n'est donc pas une précaution, c'est l'étape.
- Jamais de `prisma db push` ni de `prisma migrate reset` sur une base partagée.

## Ce qui n'est pas encore là

Le **scoping automatique par `tenant_id`** — l'extension Prisma décrite en
[tenant-isolation §3](../../../.claude/skills/tenant-isolation/SKILL.md) — attend
le contexte de requête authentifié du module `identity`. Tant qu'il n'existe pas,
chaque repository porte son `where: { tenantId }` et le test de fuite de son
module en est la preuve.
