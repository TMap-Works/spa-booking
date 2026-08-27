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
| `npm run test:integration:api` | `test/*.integration-spec.ts` — l'API en HTTP | aucune |
| `npm run test:isolation` | `test/*.isolation-spec.ts` — les tests de fuite | PostgreSQL pour deux d'entre elles |
| `npm run test:integration` | les deux précédentes, dans cet ordre | idem |

Les trois premières sont des étapes nommées du job `test` de
[ci.yml](../../.github/workflows/ci.yml) : une ligne rouge y désigne la nature
du problème sans qu'il faille ouvrir les logs.

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

**`disposable-database.ts` — une base PostgreSQL jetable.**
`createDisposableDatabase()` crée une base neuve sur le serveur que
`DATABASE_URL` désigne, y applique le SQL des migrations, et la détruit à la
demande :

```ts
beforeAll(async () => { database = await createDisposableDatabase(); });
afterAll(async () => { await database?.drop(); });
```

Rien n'est partagé entre suites : le ménage n'a plus à viser chaque ligne semée
sous peine d'emporter celles d'une suite voisine, et plusieurs exécutions
parallèles peuvent se servir du même serveur sans se marcher dessus. Le serveur,
lui, reste un prérequis — `docker compose up -d` en local, service `postgres` du
job `test` en CI. Une suite d'isolation ne se désactive jamais toute seule quand
la base manque : elle annoncerait une garantie que rien n'a vérifiée.

> Le critère d'acceptation de [#27](https://github.com/TMap-Works/spa-booking/issues/27)
> disait « via Testcontainers ». La base est bien jetable, mais provisionnée sur
> un serveur existant plutôt que dans un conteneur démarré par la suite :
> `@testcontainers/postgresql` n'est pas installé, et l'ajouter sortait de
> l'empreinte de fichiers du ticket. `DisposableDatabase` est l'interface qu'un
> fournisseur Testcontainers aura à rendre — la bascule se fera dans ce seul
> module.

Deux suites s'en servent : `tenant-scope.isolation-spec.ts`, qui prouve
l'extension de scoping Prisma contre un vrai moteur, et
`disposable-database.isolation-spec.ts`, qui prouve la base jetable elle-même.
Le harnais et ses assertions, eux, sont exercés par
`tenant-harness.isolation-spec.ts` — y compris **dans le sens négatif** : chaque
assertion y est mise devant la situation qu'elle doit attraper, et vérifiée pour
sa capacité à rougir.
