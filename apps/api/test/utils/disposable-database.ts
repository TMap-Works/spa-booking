import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { readMigrationSql } from '../../src/infrastructure/database/__tests__/migration-sql';

/**
 * Base PostgreSQL **jetable** — une base neuve et migrée par suite, détruite à
 * la fin (#27).
 *
 * ## Pourquoi une base jetable
 *
 * Les suites d'isolation qui exigent un vrai moteur partageaient jusqu'ici la
 * base nommée par `DATABASE_URL`. Deux conséquences, l'une gênante et l'autre
 * dangereuse :
 *
 * - le ménage devait viser chaque ligne semée, jamais un `deleteMany` nu, sous
 *   peine d'emporter les données d'une suite voisine — une discipline qu'un seul
 *   oubli suffit à rompre ;
 * - plusieurs agents de jalon partagent le même conteneur local : recréer le
 *   volume pour repartir propre coupe la base sous les autres.
 *
 * Une base par suite supprime les deux : rien n'est partagé, donc rien n'est à
 * ménager, et une suite qui laisse des lignes derrière elle ne laisse rien du
 * tout puisque la base disparaît.
 *
 * ## Ce qu'elle n'est pas encore
 *
 * Le critère d'acceptation de #27 dit « via Testcontainers ». Ce module
 * provisionne la base sur le serveur que `DATABASE_URL` désigne — le service
 * `postgres` du job `test` en CI, `docker compose` en local — et non dans un
 * conteneur démarré par la suite. Le paquet `@testcontainers/postgresql`
 * n'est pas installé, et l'ajouter touche `apps/api/package.json` et
 * `package-lock.json`, hors de l'empreinte de ce ticket. `DisposableDatabase`
 * est l'interface exacte qu'un fournisseur Testcontainers devra rendre : la
 * bascule se fera ici, sans toucher aux suites qui en dépendent.
 *
 * ## Comment le schéma est posé
 *
 * Par le SQL des migrations, lu par `readMigrationSql()` — la source unique du
 * dépôt (#217), celle-là même que `prisma-schema.spec.ts` inspecte. Pas par
 * `prisma migrate deploy` : la CLI se lance dans un sous-processus, et le chemin
 * de ce dépôt contient une esperluette que `cmd.exe` coupe (#139). Lire le même
 * texte que celui qui s'applique en production évite le sous-processus **et**
 * garantit qu'aucune divergence ne s'installe entre les deux chemins.
 */

/** Une base jetable, ouverte et prête à être migrée par son propriétaire. */
export interface DisposableDatabase {
  /** Le nom PostgreSQL de la base — utile aux messages de diagnostic. */
  readonly name: string;
  /** L'URL de connexion, à passer telle quelle à Prisma ou à `pg`. */
  readonly url: string;
  /**
   * Détruit la base. Idempotent : un second appel ne fait rien, ce qui permet de
   * l'appeler dans un `afterAll` que l'échec du `beforeAll` a rendu incertain.
   */
  drop(): Promise<void>;
}

/**
 * Les noms sont générés ici, jamais reçus : `CREATE DATABASE` n'accepte pas de
 * paramètre lié, le nom part donc dans le texte de la requête. Le tirage et
 * cette vérification sont ce qui tient l'invariant — un nom venu de l'extérieur
 * serait une injection SQL.
 */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * L'URL du serveur sur lequel la base est créée.
 *
 * `test/setup-env.ts` en pose une par défaut : son absence signale que le
 * fichier de setup n'a pas été chargé, pas qu'il n'y a pas de base.
 */
function requireServerUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL est absent : une base jetable se crée sur un serveur ' +
        'PostgreSQL existant. `test/setup-env.ts` en pose un par défaut — son ' +
        'absence signale que le fichier de setup n’a pas été chargé.',
    );
  }
  return url;
}

/**
 * La base de maintenance sur laquelle `CREATE DATABASE` et `DROP DATABASE` sont
 * émis.
 *
 * Ni l'une ni l'autre ne peut s'exécuter depuis la base concernée, et rien ne
 * garantit que celle nommée par `DATABASE_URL` existe : `docker-compose.yml`
 * crée `spa_dev`, la CI crée `spa_test`, et un poste fraîchement cloné n'a ni
 * l'une ni l'autre tant qu'aucune migration n'est passée. `postgres` est la base
 * de maintenance que tout cluster PostgreSQL possède.
 */
const MAINTENANCE_DATABASE = 'postgres';

/** La même URL, pointée sur une autre base du même serveur. */
function urlForDatabase(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Ouvre une connexion, ou explique ce qui manque plutôt que de laisser `pg` le dire. */
async function connect(url: string, what: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw new Error(
      `PostgreSQL injoignable (${what}). Les suites d’isolation exigent une vraie ` +
        'base : `docker compose up -d` en local, service `postgres` du job `test` ' +
        `en CI. Cause : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return client;
}

/**
 * Crée une base neuve, y applique toutes les migrations, et rend de quoi s'y
 * connecter et la détruire.
 *
 * Le coût est celui d'un `CREATE DATABASE` depuis `template1` et de quatre
 * fichiers SQL : quelques centaines de millisecondes, payées une fois par suite.
 */
export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const serverUrl = requireServerUrl();
  const name = `spa_iso_${randomUUID().replace(/-/g, '')}`;
  if (!SAFE_NAME.test(name)) {
    throw new Error(`nom de base jetable inattendu : « ${name} »`);
  }

  const maintenanceUrl = urlForDatabase(serverUrl, MAINTENANCE_DATABASE);

  const admin = await connect(maintenanceUrl, 'création de la base jetable');
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = urlForDatabase(serverUrl, name);
  let dropped = false;

  const drop = async (): Promise<void> => {
    if (dropped) {
      return;
    }
    const closer = await connect(maintenanceUrl, 'destruction de la base jetable');
    try {
      // `WITH (FORCE)` termine les sessions restées ouvertes — un client Prisma
      // qu'une suite aurait oublié de déconnecter bloquerait sinon la
      // suppression, et la base survivrait au test qui l'a créée.
      await closer.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      // Le drapeau n'est posé qu'ici, et jamais avant : le poser à l'entrée
      // rendrait un `drop()` mis en échec — serveur momentanément injoignable —
      // indiscernable d'un succès au second appel, et la base survivrait sans
      // que rien ne le dise.
      dropped = true;
    } finally {
      await closer.end();
    }
  };

  // Tout ce qui suit la création se fait sous filet : la base existe déjà, et
  // le moindre échec — connexion refusée autant que SQL invalide — la laisserait
  // sinon derrière lui. Un serveur de test qui se remplit d'une base par
  // exécution ratée est exactement ce que ce module existe pour éviter.
  try {
    const migrator = await connect(url, `migration de « ${name} »`);
    try {
      await migrator.query(readMigrationSql());
    } finally {
      await migrator.end();
    }
  } catch (error) {
    await drop();
    throw new Error(
      `l’application des migrations sur « ${name} » a échoué. Cause : ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { name, url, drop };
}
