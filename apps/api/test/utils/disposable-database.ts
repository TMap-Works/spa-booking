import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

import { readMigrationSql } from '../../src/infrastructure/database/__tests__/migration-sql';

/**
 * Base PostgreSQL **jetable** — une base neuve et migrée par suite, détruite à
 * la fin, dans un conteneur que la suite démarre elle-même (#27, #274).
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
 * ## Pourquoi Testcontainers
 *
 * La base était jusqu'à #274 provisionnée sur le serveur que `DATABASE_URL`
 * désigne. Elle était jetable, mais le **serveur** restait un prérequis
 * extérieur : un poste sans `docker compose up -d`, ou une CI sans service
 * `postgres`, faisait rougir les suites pour une raison qui n'était pas la
 * leur, et la version du moteur dépendait de ce que la machine hébergeait.
 *
 * Le conteneur est désormais démarré par la suite, sur l'image
 * {@link POSTGRES_IMAGE} — la même que `docker-compose.yml`. `DATABASE_URL`
 * n'est plus lue ici : rien de ce que la machine héberge n'entre dans le
 * résultat.
 *
 * ## Un conteneur, plusieurs bases
 *
 * Un conteneur **par module de test**, pas par base : il est démarré à la
 * première base jetable du fichier et arrêté quand la dernière est détruite
 * (Jest réinitialise le registre de modules entre fichiers de test, la portée de
 * ce compteur est donc exactement celle d'un fichier).
 *
 * Ce n'est pas qu'une économie de quelques secondes. C'est ce qui garde leur
 * sens aux suites qui comparent deux bases jetables entre elles : « deux bases
 * ne se voient pas l'une l'autre » et « la base détruite a disparu de
 * `pg_database` » ne prouvent quelque chose que si les deux bases vivent sur le
 * **même** serveur. Un conteneur par base rendrait ces cas vrais par
 * construction, donc vides.
 *
 * Le coût mesuré est écrit dans `apps/api/README.md` — l'arbitrage doit rester
 * visible.
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
   * Détruit la base, et arrête le conteneur si c'était la dernière qu'il
   * portait. Idempotent : un second appel ne fait rien, ce qui permet de
   * l'appeler dans un `afterAll` que l'échec du `beforeAll` a rendu incertain.
   */
  drop(): Promise<void>;
}

/**
 * L'image du moteur, épinglée sur la même que `docker-compose.yml`.
 *
 * `16` parce que c'est la version de production (CDC §2.2, RDS PostgreSQL 16) :
 * un harnais qui testerait sur une autre majeure prouverait autre chose que ce
 * qui sera déployé. `-alpine` parce qu'elle est trois fois plus légère à tirer
 * et embarque les mêmes modules contrib — `btree_gist`, dont dépend la
 * contrainte d'exclusion anti-double-réservation.
 *
 * Une balise fixe, jamais `latest` : un test qui change de moteur sans qu'aucun
 * commit ne le dise est un test dont le vert ne veut rien dire.
 */
const POSTGRES_IMAGE = 'postgres:16-alpine';

/**
 * Les noms sont générés ici, jamais reçus : `CREATE DATABASE` n'accepte pas de
 * paramètre lié, le nom part donc dans le texte de la requête. Le tirage et
 * cette vérification sont ce qui tient l'invariant — un nom venu de l'extérieur
 * serait une injection SQL.
 */
const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * La base de maintenance sur laquelle `CREATE DATABASE` et `DROP DATABASE` sont
 * émis.
 *
 * Ni l'une ni l'autre ne peut s'exécuter depuis la base concernée. `postgres`
 * est la base de maintenance que tout cluster PostgreSQL possède, y compris
 * celui du conteneur, qui n'ouvre par ailleurs que la sienne.
 */
const MAINTENANCE_DATABASE = 'postgres';

/**
 * Le conteneur partagé par le fichier de test courant, et le nombre de bases
 * jetables encore vivantes dessus.
 *
 * `startup` porte la **promesse** de démarrage et non le conteneur démarré :
 * deux `createDisposableDatabase()` lancés de front — ce que fait
 * `Promise.all` dans une suite — doivent attendre le même conteneur, pas en
 * démarrer deux.
 */
let startup: Promise<StartedPostgreSqlContainer> | undefined;
let live = 0;

/** Démarre le moteur, ou explique ce qui manque plutôt que de laisser Docker le dire. */
async function startContainer(): Promise<StartedPostgreSqlContainer> {
  try {
    return await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  } catch (error) {
    throw new Error(
      `démarrage du conteneur PostgreSQL (${POSTGRES_IMAGE}) impossible. Les suites ` +
        'd’isolation provisionnent leur propre moteur : un démon Docker joignable ' +
        'est leur seul prérequis.\n' +
        'En local : Docker Desktop démarré. Le premier lancement tire l’image — ' +
        `\`docker pull ${POSTGRES_IMAGE}\` une fois pour toutes évite de payer ce ` +
        'tirage dans le délai d’un `beforeAll` (`docker compose up -d` l’a déjà ' +
        'tirée : le compose utilise la même).\n' +
        `Cause : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Réserve le conteneur du fichier courant, en le démarrant s'il le faut. */
async function acquireContainer(): Promise<StartedPostgreSqlContainer> {
  startup ??= startContainer();
  try {
    const container = await startup;
    live += 1;
    return container;
  } catch (error) {
    // Un démarrage raté ne condamne pas les appels suivants : sans cette remise
    // à zéro, la promesse rejetée resterait mémoïsée et chaque suite du fichier
    // échouerait sur l'erreur de la première.
    startup = undefined;
    throw error;
  }
}

/**
 * Rend le conteneur, et l'arrête quand plus aucune base ne s'y trouve.
 *
 * C'est ce qui tient la promesse « aucun conteneur ne survit à la suite » sans
 * exiger de `globalTeardown` : le dernier `drop()` d'un fichier de test emporte
 * le moteur avec lui.
 */
async function releaseContainer(): Promise<void> {
  live -= 1;
  if (live > 0 || startup === undefined) {
    return;
  }
  const pending = startup;
  startup = undefined;
  const container = await pending.catch(() => undefined);
  await container?.stop();
}

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
      `PostgreSQL injoignable dans le conteneur de test (${what}). Le conteneur a ` +
        'démarré mais n’accepte pas la connexion : moteur arrêté entre-temps, ou ' +
        'port republié.\n' +
        `Cause : ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return client;
}

/**
 * Crée une base neuve dans un conteneur PostgreSQL démarré pour l'occasion, y
 * applique toutes les migrations, et rend de quoi s'y connecter et la détruire.
 *
 * Le coût se lit en deux parts : le démarrage du conteneur, payé une fois par
 * fichier de test, et la création plus migration de la base, payée à chaque
 * appel. Les deux sont chiffrées dans `apps/api/README.md`.
 */
export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const container = await acquireContainer();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) {
      return;
    }
    released = true;
    await releaseContainer();
  };

  const name = `spa_iso_${randomUUID().replace(/-/g, '')}`;
  if (!SAFE_NAME.test(name)) {
    await release();
    throw new Error(`nom de base jetable inattendu : « ${name} »`);
  }

  const maintenanceUrl = urlForDatabase(container.getConnectionUri(), MAINTENANCE_DATABASE);

  try {
    const admin = await connect(maintenanceUrl, 'création de la base jetable');
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
  } catch (error) {
    // La base n'existe pas : il n'y a rien à détruire, mais le conteneur a été
    // réservé et doit l'être défait, sans quoi il survivrait à la suite.
    await release();
    throw error;
  }

  const url = urlForDatabase(container.getConnectionUri(), name);
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
    // Après le drapeau, et hors du `finally` : un `drop()` qui a échoué ne rend
    // pas le conteneur, puisque la base y est peut-être encore.
    await release();
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
