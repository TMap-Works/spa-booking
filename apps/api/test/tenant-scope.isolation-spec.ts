import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { runInTenantScope, runWithTenant } from '../src/common/tenant/tenant-context';
import { MissingTenantContextError } from '../src/common/tenant/tenant-context.errors';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Isolation inter-tenant de l'extension Prisma — **contre un vrai moteur
 * PostgreSQL**.
 *
 * `tenant-scope.extension.spec.ts` couvre déjà la réécriture d'arguments par une
 * quarantaine de tests unitaires. Mais dans ces tests, la fonction `query` de
 * l'extension est un **double** : ce qui est vérifié est l'argument qu'elle
 * reçoit, jamais ce que PostgreSQL en fait. La forme produite est légale au sens
 * des types générés — `UserWhereUniqueInput` est un `Prisma.AtLeast<…>` qui
 * accepte un sélecteur unique *plus* des filtres additionnels — mais « légale »
 * n'est pas « vérifiée ».
 *
 * Cette suite ferme l'écart. Elle ne teste ni contrôleur, ni service, ni HTTP :
 * elle prend les deux clients tels que `DatabaseModule` les construit — la
 * racine non scopée et le client étendu — et exerce l'extension **là où une
 * erreur de forme se paie**, c'est-à-dire dans le moteur.
 *
 * Quatre propriétés y sont prouvées, et ce sont celles dont dépendent les huit
 * modules métier :
 *
 * 1. un `findUnique` / `update` / `delete` / `upsert` **par id** depuis un tenant
 *    étranger ne trouve rien — et ne casse rien chez le propriétaire ;
 * 2. un `findMany` ne laisse fuir aucun id du voisin, et les écritures en
 *    aveugle (`updateMany`, `deleteMany`) s'arrêtent à la frontière ;
 * 3. hors contexte, toute opération est refusée **avant** d'atteindre la base ;
 * 4. une création qui soumet un `tenantId` étranger atterrit dans le tenant
 *    courant, sans que la valeur soumise ait le moindre effet.
 *
 * ## Pourquoi `User` et non `Service`
 *
 * Le modèle exercé n'a pas d'importance pour l'extension — elle déduit les
 * modèles scopés du DMMF et les traite tous pareil. `User` est retenu parce que
 * c'est le modèle du module `identity`, celui de ce ticket, et parce que son
 * `@@unique([tenantId, email])` autorise délibérément la **même adresse dans
 * deux établissements** : c'est le cas où une confusion de tenant se voit.
 *
 * ## Prérequis
 *
 * Un serveur PostgreSQL joignable sur `DATABASE_URL`. La suite n'y travaille pas
 * : elle s'y crée une **base jetable**, migrée puis détruite
 * (`utils/disposable-database.ts`, #27). Rien n'est donc partagé avec les autres
 * suites, et le ménage n'a plus à viser chaque ligne semée sous peine
 * d'emporter les leurs.
 *
 * La CI garantit le serveur (services du job `test` de `ci.yml`) ; en local,
 * `docker compose up -d` suffit — la migration de la base jetable est faite par
 * la suite, `npm run db:migrate:deploy` n'est plus un prérequis de celle-ci.
 * L'absence de serveur fait échouer la suite, délibérément : un test d'isolation
 * qui se désactiverait tout seul quand la base manque annoncerait une garantie
 * que rien n'a vérifiée.
 */

/**
 * Options du client de base, déclarées comme **type** et pas seulement comme
 * valeur : c'est de `log` que Prisma déduit les événements que `$on` accepte.
 * Sans ce paramètre de généricité, `$on('query', …)` ne compile pas — même
 * raison que dans `prisma.service.ts`.
 *
 * Le journal `query` est éteint en production (il recopierait les paramètres,
 * donc l'e-mail et le téléphone du client, CDC §5.1). Ici il est allumé pour une
 * raison qu'aucun autre moyen ne donne : c'est la **seule preuve directe** que
 * l'opération refusée hors contexte n'a pas atteint le moteur. Les seules
 * données de cette suite sont synthétiques.
 */
type QueryLoggingOptions = {
  datasourceUrl: string;
  errorFormat: 'minimal';
  log: [{ emit: 'event'; level: 'query' }];
};

/**
 * Charge utile de création **sans** le tenant, tel qu'un repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `identity.repository.ts` et
 * `catalog.repository.ts` : le type généré exige `tenantId` — la colonne est
 * `NOT NULL` — alors que l'appelant du client scopé ne doit justement pas le
 * fournir. `$extends` ne réécrit pas les types d'entrée de Prisma, les deux
 * vérités ne se rencontrent donc pas dans le système de types.
 *
 * La sûreté de la conversion est précisément ce que cette suite vérifie : si
 * l'extension ne posait pas le tenant, l'insertion échouerait en base sur la
 * contrainte `NOT NULL`, bruyamment.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * Ouvre la portée du tenant **et y attend le résultat**.
 *
 * Ce détour n'est pas une commodité : sans lui, la moitié de cette suite passe
 * ou échoue pour de mauvaises raisons. `runWithTenant` s'appuie sur
 * `AsyncLocalStorage`, dont la portée se referme dès que la fonction rend la
 * main — or une opération Prisma est une **promesse paresseuse** : rien n'est
 * exécuté à sa construction, tout l'est au premier `.then()`. Écrire
 *
 * ```ts
 * runWithTenant(autreTenant, () => scoped.user.findUnique({ where: { id } }))
 * ```
 *
 * construit donc la promesse dans la portée et l'exécute **dehors** : l'extension
 * ne trouve aucun tenant et lève `MissingTenantContextError`. Le test rougit là
 * où il devrait prouver un filtrage — ou, pire pour un test qui attend justement
 * cette erreur, il verdit sans avoir rien exercé.
 *
 * En attendant à l'intérieur, la continuation est planifiée dans la portée, et
 * `AsyncLocalStorage` la lui restitue. C'est exactement ce que fait le code de
 * production : `TenantScopeMiddleware` ouvre la portée sur une fonction `async`,
 * et un repository `await` toujours dans la sienne.
 */
async function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithTenant(tenantId, async () => {
    const result = await fn();
    return result;
  });
}

/** Le tenant, tel que cette suite le crée — le strict nécessaire du schéma. */
function tenantSeed(label: string): Prisma.TenantCreateInput {
  return {
    slug: `i168-${label}-${randomUUID()}`,
    name: `Établissement ${label}`,
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
  };
}

describe('Extension de scoping tenant — contre un vrai PostgreSQL', () => {
  /**
   * La racine non scopée, c'est-à-dire `PRISMA_UNSCOPED` : elle sert ici à ce
   * pour quoi elle existe — créer les établissements, qui n'ont par définition
   * aucun tenant courant, et **observer** la base sans le filtre dont on teste
   * justement l'effet. Une vérification faite avec le client scopé ne prouverait
   * rien : elle serait filtrée par ce qu'elle prétend mesurer.
   */
  let prismaUnscoped: PrismaClient<QueryLoggingOptions>;
  let scoped: ReturnType<typeof createScopedPrismaClient>;
  /** La base créée pour cette suite, et détruite avec elle. */
  let database: DisposableDatabase | undefined;

  /** Requêtes réellement parties au moteur, dans l'ordre. */
  const executedQueries: string[] = [];

  let tenantA: string;
  let tenantB: string;

  /**
   * Laisse aux événements `query` le temps d'arriver : Prisma les émet de façon
   * asynchrone, après la résolution de la promesse de l'opération. Sans ce
   * répit, une assertion « aucune requête » passerait pour de mauvaises raisons.
   */
  async function flushQueryLog(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  /** Ce que Prisma lève quand aucune ligne ne correspond au `where`. */
  function expectRecordNotFound(error: unknown): void {
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2025');
  }

  beforeAll(async () => {
    // La base est créée et migrée ici, pour cette suite seule : ce qui suit ne
    // peut donc ni voir ni abîmer les données d'une autre suite.
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient<QueryLoggingOptions>({
      datasourceUrl: database.url,
      errorFormat: 'minimal',
      log: [{ emit: 'event', level: 'query' }],
    });
    prismaUnscoped.$on('query', (event) => {
      executedQueries.push(event.query);
    });

    // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
    // que le schéma est bien en place. Une base joignable mais vide produirait
    // sinon une erreur bien plus loin, sur un cas d'isolation, où elle se lirait
    // comme un défaut de l'extension.
    await prismaUnscoped.$connect();
    await prismaUnscoped.tenant.count();

    // Le client scopé est construit **par la fabrique de l'application**, pas
    // recomposé ici : c'est `createScopedPrismaClient` qui est sous test, avec
    // l'extension que `DatabaseModule` applique réellement.
    scoped = createScopedPrismaClient(prismaUnscoped);

    // Les deux établissements passent par le client non scopé — l'extension
    // refuse `Tenant.create` par construction (`UnscopedClientRequiredError`),
    // puisqu'il n'existe alors aucun tenant courant à appliquer.
    tenantA = (await prismaUnscoped.tenant.create({ data: tenantSeed('a') })).id;
    tenantB = (await prismaUnscoped.tenant.create({ data: tenantSeed('b') })).id;
  });

  afterAll(async () => {
    // Le ménage tient en une ligne : la base entière disparaît. Il n'y a plus de
    // lignes à cibler une à une, ni de risque d'emporter celles d'une suite
    // voisine — c'est ce que la base jetable achète.
    //
    // La déconnexion d'abord : `DROP DATABASE … WITH (FORCE)` saurait couper la
    // session, mais fermer proprement évite de laisser Prisma journaliser une
    // rupture de connexion qui se lirait comme un incident.
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  /** Une ligne du tenant courant, créée par le **client scopé**. */
  async function createUserInCurrentTenant(email: string, firstName = 'Alice'): Promise<string> {
    const user = await scoped.user.create({
      data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
        email,
        role: 'CLIENT',
        firstName,
        lastName: 'Martin',
      }),
    });
    return user.id;
  }

  describe('lecture, écriture et suppression par id depuis un tenant étranger', () => {
    let userOfA: string;
    const email = 'alice@example.test';

    beforeEach(async () => {
      userOfA = await inTenant(tenantA, () => createUserInCurrentTenant(email));
    });

    afterEach(async () => {
      await prismaUnscoped.user.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    });

    it('`findUnique` par id ne trouve pas la ligne du voisin', async () => {
      // Le cœur du ticket. L'extension transforme `{ id }` en `{ id, tenantId }`,
      // ce que `Prisma.AtLeast<…>` autorise à la compilation — reste à savoir ce
      // que le moteur en fait. Deux issues étaient possibles : le filtre
      // additionnel est appliqué (`null`), ou il est ignoré et la ligne du voisin
      // remonte. C'est une fuite ou une garantie, et rien entre les deux.
      const found = await inTenant(tenantB, () =>
        scoped.user.findUnique({ where: { id: userOfA } }),
      );

      expect(found).toBeNull();
    });

    it('`findUniqueOrThrow` par id échoue plutôt que de rendre la ligne du voisin', async () => {
      // La variante « ou lève » emprunte le même chemin ; la vérifier écarte
      // l'hypothèse d'un traitement particulier côté moteur, où l'absence de
      // ligne se traduit par une erreur plutôt que par `null`.
      const error = await inTenant(tenantB, () =>
        scoped.user.findUniqueOrThrow({ where: { id: userOfA } }).then(
          () => undefined,
          (caught: unknown) => caught,
        ),
      );

      expectRecordNotFound(error);
    });

    it('`update` par id ne modifie pas la ligne du voisin, qui reste intacte', async () => {
      const error = await inTenant(tenantB, () =>
        scoped.user
          .update({ where: { id: userOfA }, data: { firstName: 'Intrus' } })
          .then(() => undefined, (caught: unknown) => caught),
      );

      expectRecordNotFound(error);

      // La moitié qui compte vraiment : « n'a pas trouvé » ne suffit pas, il
      // faut que rien n'ait bougé chez le propriétaire. Relu par le client non
      // scopé, donc sans le filtre que l'on teste.
      const owned = await prismaUnscoped.user.findUnique({ where: { id: userOfA } });
      expect(owned).not.toBeNull();
      expect(owned?.firstName).toBe('Alice');
      expect(owned?.tenantId).toBe(tenantA);
    });

    it('`delete` par id ne supprime pas la ligne du voisin, qui reste intacte', async () => {
      const error = await inTenant(tenantB, () =>
        scoped.user.delete({ where: { id: userOfA } }).then(
          () => undefined,
          (caught: unknown) => caught,
        ),
      );

      expectRecordNotFound(error);

      const owned = await prismaUnscoped.user.findUnique({ where: { id: userOfA } });
      expect(owned).not.toBeNull();
      expect(owned?.tenantId).toBe(tenantA);
    });

    it('`upsert` par id ne touche pas la ligne du voisin — il crée chez lui', async () => {
      // `upsert` est la seule famille d'`OPERATION_SHAPES` à avoir sa propre
      // branche dans `applyTenantScope` — elle scope le `where` *et* pose le
      // tenant sur le `create`. Ne l'exercer que hors contexte ne prouve rien de
      // cette branche : le refus tombe avant qu'elle ne s'exécute. Si le `where`
      // scopé y disparaissait, un `upsert` par id depuis B prendrait la branche
      // `update` sur la ligne de A — une fuite en écriture, silencieuse.
      const result = await inTenant(tenantB, () =>
        scoped.user.upsert({
          where: { id: userOfA },
          create: withScopedTenant<Prisma.UserUncheckedCreateInput>({
            email: 'upsert-intrus@example.test',
            role: 'CLIENT',
            firstName: 'Intrus',
            lastName: 'Martin',
          }),
          update: { firstName: 'Intrus' },
        }),
      );

      // La branche `update` n'est pas prise : le `where` scopé ne trouve rien
      // chez B. Prisma bascule sur `create`, et la ligne créée porte B.
      expect(result.id).not.toBe(userOfA);
      expect(result.tenantId).toBe(tenantB);

      const owned = await prismaUnscoped.user.findUnique({ where: { id: userOfA } });
      expect(owned?.firstName).toBe('Alice');
      expect(owned?.tenantId).toBe(tenantA);

      // Contrôle négatif : chez le propriétaire, la branche `update` est bien
      // prise — sans quoi « n'a rien touché » se lirait aussi bien comme « ne
      // touche jamais rien ».
      const own = await inTenant(tenantA, () =>
        scoped.user.upsert({
          where: { id: userOfA },
          create: withScopedTenant<Prisma.UserUncheckedCreateInput>({
            email: 'upsert-proprio@example.test',
            role: 'CLIENT',
            firstName: 'Alix',
            lastName: 'Martin',
          }),
          update: { firstName: 'Alix' },
        }),
      );
      expect(own.id).toBe(userOfA);
      expect(own.firstName).toBe('Alix');
    });

    it('`updateMany` et `deleteMany` s’arrêtent à la frontière du tenant', async () => {
      // Les écritures **en aveugle** : l'appelant ne fournit aucun `where`, donc
      // c'est l'extension seule qui les borne. Ce sont aussi les seules dont une
      // régression emporte tout un établissement d'un coup, sans erreur.
      const userOfB = await inTenant(tenantB, () =>
        createUserInCurrentTenant('bea@example.test', 'Bea'),
      );

      const updated = await inTenant(tenantB, () =>
        scoped.user.updateMany({ data: { firstName: 'Écrasé' } }),
      );
      expect(updated.count).toBe(1);
      expect((await prismaUnscoped.user.findUnique({ where: { id: userOfB } }))?.firstName).toBe(
        'Écrasé',
      );
      expect((await prismaUnscoped.user.findUnique({ where: { id: userOfA } }))?.firstName).toBe(
        'Alice',
      );

      const deleted = await inTenant(tenantB, () => scoped.user.deleteMany({}));
      expect(deleted.count).toBe(1);
      expect(await prismaUnscoped.user.findUnique({ where: { id: userOfA } })).not.toBeNull();
    });

    it('le propriétaire, lui, retrouve et modifie sa ligne par le même chemin', async () => {
      // Contrôle négatif indispensable : sans lui, une extension qui refuserait
      // *tout* — y compris au propriétaire — passerait les quatre tests
      // précédents avec les honneurs.
      const found = await inTenant(tenantA, () =>
        scoped.user.findUnique({ where: { id: userOfA } }),
      );
      expect(found?.id).toBe(userOfA);

      const updated = await inTenant(tenantA, () =>
        scoped.user.update({ where: { id: userOfA }, data: { firstName: 'Alix' } }),
      );
      expect(updated.firstName).toBe('Alix');
    });

    it('`findMany` ne laisse fuir aucun id du voisin', async () => {
      // Le voisin a sa propre ligne, avec la **même adresse** : le schéma
      // l'autorise (`@@unique([tenantId, email])`), et c'est ce qui rend le test
      // probant — une liste vide côté B ne prouverait pas grand-chose.
      const userOfB = await inTenant(tenantB, () => createUserInCurrentTenant(email, 'Bea'));

      const seenByB = await inTenant(tenantB, () => scoped.user.findMany());
      const ids = seenByB.map((user) => user.id);

      expect(ids).toContain(userOfB);
      expect(ids).not.toContain(userOfA);
      // Aucune ligne d'un autre établissement, quel qu'il soit : la base de test
      // est partagée, et le filtre doit être positif (« seulement B »), pas
      // négatif (« pas A »).
      expect(seenByB.every((user) => user.tenantId === tenantB)).toBe(true);
    });

    it('`count` et `findFirst` sont bornés au tenant courant', async () => {
      await inTenant(tenantB, () => createUserInCurrentTenant(email, 'Bea'));

      const countB = await inTenant(tenantB, () => scoped.user.count());
      expect(countB).toBe(1);

      const firstFromB = await inTenant(tenantB, () =>
        scoped.user.findFirst({ where: { email } }),
      );
      expect(firstFromB?.tenantId).toBe(tenantB);
    });

    it('la racine `Tenant` est bornée à l’établissement courant', async () => {
      // `Tenant` ne porte pas de `tenant_id` — elle *est* le tenant — et
      // l'extension la scope donc sur son `id`. Sans cela,
      // `prisma.tenant.findMany()` énumérerait tous les salons de la plateforme.
      const seenByA = await inTenant(tenantA, () => scoped.tenant.findMany());

      expect(seenByA.map((tenant) => tenant.id)).toEqual([tenantA]);
    });
  });

  describe('hors contexte de tenant', () => {
    /**
     * Chaque famille de `OPERATION_SHAPES` est représentée : filtre, création,
     * mise à jour, upsert. Une opération qui échapperait au refus serait une
     * lecture — ou une écriture — sur *tous* les établissements.
     */
    const operations: ReadonlyArray<[string, (client: typeof scoped) => Promise<unknown>]> = [
      ['findUnique', (client) => client.user.findUnique({ where: { id: randomUUID() } })],
      ['findFirst', (client) => client.user.findFirst()],
      ['findMany', (client) => client.user.findMany()],
      ['count', (client) => client.user.count()],
      ['aggregate', (client) => client.user.aggregate({ _count: true })],
      ['groupBy', (client) => client.user.groupBy({ by: ['role'] })],
      [
        'create',
        (client) =>
          client.user.create({
            data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
              email: 'hors-contexte@example.test',
              role: 'CLIENT',
              firstName: 'Hors',
              lastName: 'Contexte',
            }),
          }),
      ],
      [
        'update',
        (client) =>
          client.user.update({ where: { id: randomUUID() }, data: { firstName: 'Hors' } }),
      ],
      ['updateMany', (client) => client.user.updateMany({ data: { firstName: 'Hors' } })],
      [
        'upsert',
        (client) =>
          client.user.upsert({
            where: { id: randomUUID() },
            create: withScopedTenant<Prisma.UserUncheckedCreateInput>({
              email: 'hors-contexte-upsert@example.test',
              role: 'CLIENT',
              firstName: 'Hors',
              lastName: 'Contexte',
            }),
            update: { firstName: 'Hors' },
          }),
      ],
      ['delete', (client) => client.user.delete({ where: { id: randomUUID() } })],
      ['deleteMany', (client) => client.user.deleteMany({})],
      ['findMany (Tenant)', (client) => client.tenant.findMany()],
    ];

    it.each(operations)(
      '`%s` lève `MissingTenantContextError` sans qu’aucune requête ne parte',
      async (_name, run) => {
        // La preuve tient en deux moitiés. L'erreur seule ne dirait pas *quand*
        // le refus a lieu : une opération partie au moteur puis rejetée aurait la
        // même signature côté appelant. Le journal `query` tranche — il ne peut
        // contenir que ce que le moteur a réellement reçu.
        await flushQueryLog();
        executedQueries.length = 0;

        await expect(run(scoped)).rejects.toThrow(MissingTenantContextError);

        await flushQueryLog();
        expect(executedQueries).toEqual([]);
      },
    );

    it('une portée ouverte mais non résolue est traitée comme une absence', async () => {
      // Le middleware ouvre la portée à l'entrée HTTP, *avant* que la garde
      // d'authentification n'y pose le tenant. Entre les deux, le store existe
      // mais son `tenantId` vaut `undefined` — l'état par lequel une requête non
      // authentifiée arriverait jusqu'à un repository.
      //
      // L'opération est attendue **dans** la portée, pour la même raison que
      // `inTenant` : awaiter dehors refermerait le store avant que la promesse
      // paresseuse ne s'exécute, et l'erreur obtenue serait celle de « aucune
      // portée » — le test verdirait sans avoir exercé l'état qu'il décrit.
      await flushQueryLog();
      executedQueries.length = 0;

      await expect(
        runInTenantScope(async () => {
          const rows = await scoped.user.findMany();
          return rows;
        }),
      ).rejects.toThrow(MissingTenantContextError);

      await flushQueryLog();
      expect(executedQueries).toEqual([]);
    });

    it('le client non scopé, lui, atteint bien la base — le refus vient de l’extension', async () => {
      // Contrôle négatif du bloc : si `executedQueries` restait vide quoi qu'il
      // arrive — journal mal branché, événement jamais émis — tous les tests
      // ci-dessus passeraient sans rien prouver.
      await flushQueryLog();
      executedQueries.length = 0;

      await prismaUnscoped.user.findMany({ where: { tenantId: tenantA } });

      await flushQueryLog();
      expect(executedQueries.length).toBeGreaterThan(0);
    });
  });

  describe('création avec un `tenantId` soumis par l’appelant', () => {
    afterEach(async () => {
      await prismaUnscoped.user.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } });
    });

    it('atterrit dans le tenant courant, la valeur soumise restant sans effet', async () => {
      // Le scénario de fuite en écriture : une valeur qui aurait traversé la
      // validation et prétendrait rattacher la ligne à un autre établissement.
      // L'extension **écrase** plutôt que de rejeter — la valeur soumise n'a
      // aucun effet, et ne peut donc pas servir de sonde d'existence.
      const email = 'intrus@example.test';

      const created = await inTenant(tenantA, () =>
        scoped.user.create({
          data: {
            tenantId: tenantB,
            email,
            role: 'CLIENT',
            firstName: 'Intrus',
            lastName: 'Martin',
          },
        }),
      );

      expect(created.tenantId).toBe(tenantA);

      // Relu en base, et non dans la valeur de retour : c'est la ligne écrite
      // qui compte, pas ce que le client en dit.
      const persisted = await prismaUnscoped.user.findUnique({ where: { id: created.id } });
      expect(persisted?.tenantId).toBe(tenantA);
      expect(await prismaUnscoped.user.count({ where: { tenantId: tenantB } })).toBe(0);
    });

    it('`createMany` pose le tenant courant sur chaque ligne, y compris celles qui en soumettent un', async () => {
      await inTenant(tenantA, () =>
        scoped.user.createMany({
          data: [
            {
              tenantId: tenantB,
              email: 'lot-1@example.test',
              role: 'CLIENT',
              firstName: 'Un',
              lastName: 'Martin',
            },
            withScopedTenant<Prisma.UserCreateManyInput>({
              email: 'lot-2@example.test',
              role: 'CLIENT',
              firstName: 'Deux',
              lastName: 'Martin',
            }),
          ],
        }),
      );

      expect(await prismaUnscoped.user.count({ where: { tenantId: tenantA } })).toBe(2);
      expect(await prismaUnscoped.user.count({ where: { tenantId: tenantB } })).toBe(0);
    });
  });
});
