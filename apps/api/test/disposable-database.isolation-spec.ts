import { Client } from 'pg';

import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * La base jetable, exercée sur elle-même (#27).
 *
 * `tenant-scope.isolation-spec.ts` s'en sert pour prouver le scoping contre un
 * vrai moteur : si la base qu'elle reçoit n'était pas migrée, ou pas neuve, ses
 * vingt-sept cas verdiraient ou rougiraient pour des raisons qui n'ont rien à
 * voir avec l'extension Prisma. Trois propriétés sont donc vérifiées ici, et ce
 * sont exactement celles dont dépendent les suites qui l'utilisent :
 *
 * 1. la base est **neuve** — aucune donnée d'une autre suite n'y traîne ;
 * 2. elle est **migrée** — le schéma du dépôt s'y trouve, `tenant_id` compris ;
 * 3. elle est **détruite** — un serveur de test ne se remplit pas d'une base par
 *    exécution.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre (#27, #274). La suite ne se
 * connecte à aucun serveur préexistant : `createDisposableDatabase()` démarre
 * son propre PostgreSQL 16 (`postgres:16-alpine`, `@testcontainers/postgresql`)
 * et y crée la base qu'elle exerce. `DATABASE_URL` n'est plus lue depuis #274 —
 * rien de ce que la machine héberge n'entre dans le résultat.
 *
 * Un échec ne se débogue donc ni du côté d'un serveur local, ni du côté des
 * services de la CI : il vient du démon Docker, de l'image, ou de cette suite.
 * En local, Docker Desktop démarré suffit ; le premier lancement tire l'image,
 * et ce tirage se paie dans le délai du `beforeAll` de Jest —
 * `docker pull postgres:16-alpine` une fois pour toutes l'évite.
 */

/** Ouvre une connexion sur la base jetable, le temps d'une vérification. */
async function query<T extends Record<string, unknown>>(url: string, sql: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

describe('Base PostgreSQL jetable — #27', () => {
  let database: DisposableDatabase;

  beforeAll(async () => {
    database = await createDisposableDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('porte le schéma migré du dépôt, `tenant_id` compris', async () => {
    // Le nom des tables vient du schéma Prisma, pas d'une liste tenue à la main :
    // ce qui est vérifié, c'est que le SQL de migration s'est **appliqué**, pas
    // qu'une table précise existe.
    const tables = await query<{ table_name: string }>(
      database.url,
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = tables.map((row) => row.table_name);

    expect(names).toContain('tenants');
    expect(names).toContain('users');

    // La contrainte non négociable du projet : toute table métier porte un
    // `tenant_id` non nullable. `prisma-schema.spec.ts` la vérifie sur le texte
    // du SQL ; ici elle est vérifiée sur le schéma réellement construit.
    const colonnes = await query<{ table_name: string; is_nullable: string }>(
      database.url,
      "select table_name, is_nullable from information_schema.columns " +
        "where table_schema = 'public' and column_name = 'tenant_id'",
    );

    expect(colonnes.length).toBeGreaterThan(0);
    expect(colonnes.filter((colonne) => colonne.is_nullable !== 'NO')).toEqual([]);
  });

  it('est vide de toute donnée métier', async () => {
    // Une base recyclée entre suites laisserait des établissements derrière elle,
    // et un test « la liste ne contient rien du voisin » deviendrait un test de
    // la propreté du ménage précédent.
    const [compte] = await query<{ total: string }>(
      database.url,
      'select count(*)::text as total from tenants',
    );

    expect(compte?.total).toBe('0');
  });

  it('deux bases jetables ne se voient pas l’une l’autre', async () => {
    // La propriété qui remplace le ménage ligne à ligne de l'ancienne suite : ce
    // qu'une base contient n'existe pas pour l'autre, sans qu'aucune des deux
    // n'ait à cibler ses suppressions.
    const voisine = await createDisposableDatabase();
    try {
      expect(voisine.name).not.toBe(database.name);

      // `updated_at` est explicite : Prisma tient `@updatedAt` côté client, la
      // colonne n'a donc aucune valeur par défaut en base.
      await query(
        voisine.url,
        'insert into tenants (id, slug, name, timezone, default_currency, updated_at) ' +
          "values (gen_random_uuid(), 'voisine-i27', 'Voisine', 'Europe/Paris', 'EUR', now())",
      );

      const [ici] = await query<{ total: string }>(
        database.url,
        'select count(*)::text as total from tenants',
      );
      expect(ici?.total).toBe('0');
    } finally {
      await voisine.drop();
    }
  });

  it('disparaît quand on la détruit, et `drop` est idempotent', async () => {
    const ephemere = await createDisposableDatabase();
    await ephemere.drop();
    // Un second appel ne doit pas lever : un `afterAll` s'exécute même quand le
    // `beforeAll` a déjà nettoyé derrière un échec.
    await ephemere.drop();

    const restantes = await query<{ datname: string }>(
      database.url,
      `select datname from pg_database where datname = '${ephemere.name}'`,
    );

    expect(restantes).toEqual([]);
  });
});
