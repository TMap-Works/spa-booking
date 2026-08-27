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
| `npm run test:integration:api` | `test/*.integration-spec.ts` — l'API en HTTP | Docker pour une d'entre elles |
| `npm run test:isolation` | `test/*.isolation-spec.ts` — les tests de fuite | Docker pour deux d'entre elles |
| `npm run test:integration` | les deux précédentes, dans cet ordre | idem |

Les trois premières sont des étapes nommées du job `test` de
[ci.yml](../../.github/workflows/ci.yml) : une ligne rouge y désigne la nature
du problème sans qu'il faille ouvrir les logs.

« Docker » et non « PostgreSQL » : les trois suites qui exigent un vrai moteur
démarrent le leur (voir plus bas). Aucune ne lit `DATABASE_URL`, et les autres —
l'immense majorité — n'ont toujours besoin de rien.

Le contrat entre ces cibles est tenu par une garde du job `test`, et non par une
convention : la CI appelle les **feuilles** (`test:integration:api`,
`test:isolation`) pour ne pas rejouer les suites d'isolation deux fois, tandis
que `npm run verify` passe par l'alias `test:integration`. Un workspace qui
déclarerait l'alias sans ses feuilles serait sauté en silence par `--if-present`
en CI ; un alias qui oublierait une feuille la sauterait en silence dans
`verify`. L'étape « Contrat des cibles de test d'intégration » refuse les deux.

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
~9 s sur `npm run verify` pour les trois fichiers d'aujourd'hui. C'est le prix
de l'indépendance vis-à-vis de ce que la machine héberge — version du moteur
comprise. Il croît avec le nombre de **fichiers**, pas de suites ni de bases :
regrouper dans un même fichier les cas qui exigent un moteur reste la façon de
ne pas le payer deux fois.

Le tirage de l'image, lui, ne se paie qu'une fois par machine — mais il se paie
dans le `beforeAll` de la première suite, dont le délai est celui de Jest (30 s).
En local, `docker compose up -d` l'a déjà tirée ; en CI, une étape dédiée du job
`test` la tire avant les tests.

Trois suites s'en servent : `tenant-scope.isolation-spec.ts`, qui prouve
l'extension de scoping Prisma contre un vrai moteur,
`appointments-exclusion.integration-spec.ts`, qui prouve la contrainte
d'exclusion anti-double-réservation, et
`disposable-database.isolation-spec.ts`, qui prouve la base jetable elle-même.
Le harnais et ses assertions, eux, sont exercés par
`tenant-harness.isolation-spec.ts` — y compris **dans le sens négatif** : chaque
assertion y est mise devant la situation qu'elle doit attraper, et vérifiée pour
sa capacité à rougir.
