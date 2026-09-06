# apps/api — Backend NestJS

Monolithe modulaire. Conventions détaillées :
[.claude/skills/api-module/SKILL.md](../../.claude/skills/api-module/SKILL.md).

```
src/
  modules/
    identity/        auth, rôles, permissions, tenants
    catalog/         services, catégories, prix, affectations
    availability/    calcul des créneaux, horaires, plages bloquées
    appointments/    cycle de vie du RDV, report, annulation, no-show
    crm/             profils clients, notes, historique
    payments/        encaissement, Stripe, POS, transactions
    notifications/   confirmations, rappels, modèles
    reporting/       revenu, volume, no-shows
  common/            guards, filtres, décorateurs, contexte tenant
  config/            validation des variables d'environnement
prisma/
  schema.prisma
  migrations/
```

Chaque module suit la même structure : `*.module.ts`, `*.controller.ts`
(HTTP uniquement), `*.service.ts` (règles métier), `*.repository.ts` (seul à
connaître Prisma), `dto/`, `events/`, `__tests__/` incluant un test d'isolation
inter-tenant.

## Tests

| Cible | Ce qu'elle couvre | Infrastructure |
|---|---|---|
| `npm run test:unit` | logique pure, `src/**/__tests__/*.spec.ts` | aucune |
| `npm run test:integration:api` | `test/*.integration-spec.ts` — l'API en HTTP | Docker pour deux d'entre elles |
| `npm run test:isolation` | `test/*.isolation-spec.ts` — les tests de fuite | Docker pour quatre d'entre elles |
| `npm run test:concurrency` | `test/*.concurrency-spec.ts` — les courses du moteur de réservation | Docker |
| `npm run test:integration` | les deux cibles d'intégration, dans cet ordre | idem |

Les quatre premières sont des étapes nommées du job `test` de
[ci.yml](../../.github/workflows/ci.yml) : une ligne rouge y désigne la nature
du problème sans qu'il faille ouvrir les logs.

« Docker » et non « PostgreSQL » : les suites qui exigent un vrai moteur
démarrent le leur (voir plus bas). Aucune ne lit `DATABASE_URL`, et les autres —
l'immense majorité — n'ont toujours besoin de rien.

`test:concurrency` a sa propre configuration Jest
([jest.concurrency.config.js](jest.concurrency.config.js)) et son propre suffixe,
disjoint de ceux de `jest.integration.config.js` : aucune suite n'est jouée deux
fois, ni par `npm run verify` ni par le job `test`. `--passWithNoTests` n'y est
délibérément pas posé — sans suite trouvée, la cible échoue. Jusqu'à #326, aucun
workspace ne la déclarait : le fan-out `--if-present` sortait en 0, et l'étape
qui annonce le garde-fou du risque n°1 (CDC §6) verdissait sans rien exercer.

Le contrat entre ces cibles est tenu par une garde du job `test`, et non par une
convention : la CI appelle les **feuilles** (`test:integration:api`,
`test:isolation`) pour ne pas rejouer les suites d'isolation deux fois, tandis
que `npm run verify` passe par l'alias `test:integration`. Un workspace qui
déclarerait l'alias sans ses feuilles serait sauté en silence par `--if-present`
en CI ; un alias qui oublierait une feuille la sauterait en silence dans
`verify` ; et une cible appelée en `--if-present` que plus aucun workspace ne
déclare — `test:integration:api`, `test:isolation` ou `test:concurrency` —
laisserait son étape verte sans rien lancer. L'étape « Contrat des cibles de
test » refuse les trois.

### Harnais de tests d'isolation inter-tenant

Tout endpoint nouveau ou modifié livre son test de fuite — c'est la Definition
of Done du projet, et le protocole est celui de
[tenant-isolation §6](../../.claude/skills/tenant-isolation/SKILL.md) : créer
chez A, s'authentifier comme B, tenter lecture, modification et suppression par
identifiant, attendre 404 sur les trois, vérifier que la ressource de A est
intacte, et qu'aucune liste ne laisse voir un identifiant d'ailleurs.

Ce protocole n'est pas à réécrire à chaque module. Trois modules sous
`test/utils/` le portent :

**`tenant-harness.ts` — deux établissements et leurs jeux de données.**
`createTenantHarness()` démarre l'application **réelle** (`AppModule` câblé par
`configureApp`, comme `main.ts`), déclare deux établissements —
`salon-des-lilas` et `barbier-du-port` — et rend de quoi les désigner :

```ts
const harness = await createTenantHarness({
  // Le dépôt du module sous test ; les connexions et `IdentityRepository`
  // sont déjà substitués.
  overrides: [{ provide: CatalogRepository, useValue: catalog }],
});

harness.a.id;        // l'établissement de l'appelant
harness.b.slug;      // le voisin, celui qu'aucune réponse ne doit montrer
await harness.bearer('ADMIN');            // un jeton signé par le vrai TokenService
await harness.bearer('ADMIN', harness.b); // le même rang, chez le voisin
await harness.seedUser(harness.a, { email: '…', password: '…', role: 'STAFF' });
```

Les jetons sont **signés**, pas simulés : c'est la seule façon d'exercer
`JwtAuthGuard` pour ce qu'il fait, lire le `tenantId` d'un jeton vérifié et le
poser dans le contexte de requête.

**`tenant-assertions.ts` — ce qu'on exige des réponses.**

```ts
await expectCrossTenantNotFound({
  attempts: [
    { label: 'lecture', send: () => request(server()).get(`/api/v1/services/${chezB.id}`).set('Authorization', bearer) },
    { label: 'modification', send: () => request(server()).patch(…) },
    { label: 'suppression', send: () => request(server()).delete(…) },
  ],
  // Ce qu'aucun corps de réponse ne doit contenir.
  hidden: [chezB.id, harness.b.id],
  // Relu après les tentatives : rien n'a été écrit chez le voisin.
  intact: () => catalog.services,
});

expectListScopedTo(response.body, { ownIds: [chezA.id], foreignIds: [chezB.id] });
expectExcludesForeignIds(response.body, [harness.b.id]);
```

`expectCrossTenantNotFound` exige **404 et jamais 403** : un 403 confirmerait que
la ressource existe quelque part, ce qui est une sonde d'existence offerte à qui
énumère des identifiants. Elle refuse aussi un scénario sans tentative ou sans
identifiant surveillé — vert sans rien avoir exercé est le pire résultat pour un
test de fuite.

**`disposable-database.ts` — une base PostgreSQL jetable, dans un conteneur à
elle.** `createDisposableDatabase()` démarre un PostgreSQL 16
(`@testcontainers/postgresql`, image `postgres:16-alpine` — la même que
`docker-compose.yml`), y crée une base neuve, y applique le SQL des migrations,
et détruit l'une comme l'autre à la demande :

```ts
beforeAll(async () => { database = await createDisposableDatabase(); });
afterAll(async () => { await database?.drop(); });
```

Rien n'est partagé entre suites : le ménage n'a plus à viser chaque ligne semée
sous peine d'emporter celles d'une suite voisine, et plusieurs exécutions
parallèles ne se marchent pas dessus. Le **serveur** non plus n'est plus partagé
depuis [#274](https://github.com/TMap-Works/spa-booking/issues/274) : ni
`docker compose up -d`, ni le service `postgres` de la CI, ni `DATABASE_URL`
n'entrent dans le résultat. Un démon Docker joignable est le seul prérequis. Une
suite d'isolation ne se désactive jamais toute seule quand il manque : elle
annoncerait une garantie que rien n'a vérifiée.

Le conteneur est démarré **par fichier de test**, pas par base : Jest
réinitialise le registre de modules entre fichiers, et le compteur interne du
harnais arrête le moteur quand la dernière base qu'il portait est détruite.
Ce n'est pas qu'une économie : les cas « deux bases jetables ne se voient pas
l'une l'autre » et « la base détruite a disparu de `pg_database` » ne prouvent
quelque chose que si les deux bases vivent sur le même serveur. Un conteneur par
base les rendrait vrais par construction, donc vides.

**Le coût, mesuré.** Windows 11, Docker Desktop 29.6.1, cache ts-jest chaud,
`--runInBand`, image déjà tirée :

| Mesure | Avant #274 | Après #274 |
|---|---|---|
| `appointments-exclusion.integration-spec.ts` (1 fichier) | 1,5 s | 4,5 s |
| `disposable-database` + `tenant-scope` (2 fichiers) | 4,0 s | 10,4 s |
| démarrage d'un conteneur | — | 1,6 à 2,4 s |
| arrêt d'un conteneur | — | ~0,6 s |
| `CREATE DATABASE` + SQL des migrations | ~0,4 s | ~0,4 s |

Soit **environ 3 secondes par fichier de test qui provisionne une base**, et
~21 s sur `npm run verify` pour les **sept fichiers d'aujourd'hui** — ils sont
nommés plus bas, avec la façon de les recompter sans se tromper. L'un d'eux,
`appointments-exclusion.concurrency-spec.ts`, a été séparé de son voisin
d'intégration par #326 pour que `test:concurrency` ait une suite à jouer : c'est
un conteneur de plus, assumé — la cible qui garde le risque n°1 ne peut pas
partager son fichier avec des cas qu'une autre cible exécute. C'est le prix
de l'indépendance vis-à-vis de ce que la machine héberge — version du moteur
comprise. Il croît avec le nombre de **fichiers**, pas de `describe` ni de bases :
regrouper dans un même fichier les cas qui exigent un moteur reste la façon de
ne pas le payer deux fois.

Le tirage de l'image, lui, ne se paie qu'une fois par machine — mais il se paie
dans le `beforeAll` de la première suite, dont le délai est celui de Jest (30 s).
En local, `docker compose up -d` l'a déjà tirée ; en CI, une étape dédiée du job
`test` la tire avant les tests.

**Sept fichiers de test provisionnent une base**, donc sept conteneurs :

| Fichier | Ce qu'il prouve, et que rien d'autre ne prouve |
|---|---|
| `tenant-scope.isolation-spec.ts` | l'extension de scoping Prisma, contre un vrai moteur |
| `appointments-exclusion.integration-spec.ts` | la contrainte d'exclusion anti-double-réservation |
| `appointments-exclusion.concurrency-spec.ts` | qu'elle tient sous des écritures parallèles |
| `disposable-database.isolation-spec.ts` | la base jetable elle-même — neuve, migrée, détruite |
| `payments-webhook.isolation-spec.ts` | que l'idempotence du webhook Stripe est une contrainte d'unicité et non une condition écrite dans le service, et qu'un événement dont les métadonnées désignent le voisin s'applique quand même chez le propriétaire réel de l'encaissement |
| `pos.isolation-spec.ts` | la transaction de `createSale`, les `CHECK` de montants posés par la migration, et les clés étrangères composites `(tenant_id, …)` qui interdisent de facturer sur le ticket d'un salon l'article d'un autre |
| `tenant-settings-constraints.integration-spec.ts` | les cinq bornes de `20260904150000_add_tenant_address_and_opening_hours` — complétude de l'adresse, code pays, jour ISO 8601, plage dans sa journée civile, non-recouvrement de deux plages du même jour — et que le `deleteMany({})` **sans `where`** de la réécriture d'horaires s'arrête à la frontière du tenant |

Ventilés par cible : **deux** sous `test:integration:api`, **quatre** sous
`test:isolation`, **un** sous `test:concurrency`. La colonne « Infrastructure »
du tableau des cibles de test, plus haut dans ce README, porte ces trois nombres
et se met à jour du même geste que ce décompte — les deux avaient dérivé
ensemble.

Les deux suites `appointments-exclusion` partagent leur amorçage dans
`appointments-exclusion.harness.ts` : un seul fichier de harnais, mais **deux**
conteneurs — chacune l'appelle dans son propre `beforeAll`, et Jest réinitialise
le registre de modules entre fichiers.

**Comment recompter.** La liste qui fait foi vient de :

```bash
grep -rl createDisposableDatabase apps/api/test
```

Elle ne se lit pas au nombre de lignes. Deux corrections, dans cet ordre :

1. **retirer ce qui n'est pas une suite** — `utils/disposable-database.ts`, qui
   est l'utilitaire lui-même, et `appointments-exclusion.harness.ts`, qui est un
   harnais ;
2. **ajouter les fichiers qui appellent ces harnais** — un harnais partagé coûte
   autant de conteneurs qu'il a de suites appelantes, jamais un seul.

Aujourd'hui le `grep` rend sept chemins et le décompte tombe sur sept conteneurs :
les deux corrections se compensent exactement (−2 puis +2). Cette coïncidence est
un piège, et elle ne survivra pas au prochain fichier ajouté. C'est faute de
l'avoir défaite que
[#478](https://github.com/TMap-Works/spa-booking/issues/478) annonçait « cinq » :
`payments-webhook.isolation-spec.ts` et `pos.isolation-spec.ts` n'avaient jamais
été inscrites ici.

Le harnais d'isolation et ses assertions, eux, sont exercés par
`tenant-harness.isolation-spec.ts` — y compris **dans le sens négatif** : chaque
assertion y est mise devant la situation qu'elle doit attraper, et vérifiée pour
sa capacité à rougir.
