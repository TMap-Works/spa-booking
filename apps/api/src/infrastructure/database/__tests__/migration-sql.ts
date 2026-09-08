import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lecture du SQL de migration réellement appliqué — la source unique.
 *
 * Deux suites interrogent ce texte, pour deux raisons différentes :
 *
 * - `prisma-schema.spec.ts` y vérifie les contraintes non négociables du projet
 *   (`tenant_id` non nullable, montants entiers, migration additive) — aucune
 *   n'est exprimable en TypeScript, et `schema.prisma` ne dit pas ce qui
 *   s'exécutera vraiment sur PostgreSQL ;
 * - `modules/identity/__tests__/roles.spec.ts` y vérifie l'ordre de déclaration
 *   du type `UserRole`, que le client généré ne peut pas trahir : un `ADD VALUE`
 *   sans voisin place le libellé en queue du type quel que soit son rang dans le
 *   schéma, et c'est l'ordre du type que rend `orderBy: { role: 'asc' }`.
 *
 * Chacune a d'abord porté son propre lecteur. Deux lecteurs qui dérivent
 * assertent sur des textes différents, et celui qui garantit qu'aucune migration
 * n'est destructive est le plus mal placé pour se tromper de texte (#217).
 *
 * **Ce module n'est pas une suite de test** : il vit sous `__tests__/` pour
 * rester hors du `tsconfig.build.json` de production, mais son nom ne se termine
 * pas par `.spec.ts` — le seul suffixe que ramasse le `testMatch` de
 * `jest.unit.config.js`. Jest ne l'exécute donc jamais comme une suite, et il ne
 * doit contenir aucun `expect()` : hors d'un test, une assertion Jest n'a pas de
 * suite à faire échouer. Ce qui ne va pas se signale par une exception, dont le
 * message nomme la cause.
 */

/** `apps/api/prisma`, résolu depuis ce fichier et non depuis l'appelant. */
export const PRISMA_DIR = join(__dirname, '..', '..', '..', '..', 'prisma');

/** `apps/api/prisma/migrations`. */
export const MIGRATIONS_DIR = join(PRISMA_DIR, 'migrations');

/** Une migration, telle qu'elle sera jouée : son dossier et son SQL. */
export interface Migration {
  /** Le nom du dossier — l'horodatage Prisma suivi du libellé. */
  readonly name: string;
  /** Le contenu de son `migration.sql`. */
  readonly sql: string;
}

/**
 * Les migrations une à une, dans leur ordre d'application.
 *
 * ## Pourquoi la découpe, alors que la concaténation suffisait jusqu'ici
 *
 * Parce qu'une migration est l'**unité d'atomicité** : Prisma la joue dans une
 * transaction, et ce qui s'y trouve s'applique ensemble ou pas du tout. Un
 * garde qui raisonne sur le texte concaténé ne peut donc pas distinguer « cet
 * index est retiré puis recréé dans le même souffle » de « cet index a été
 * retiré ici, et un homonyme créé trois migrations plus loin » — deux situations
 * qui n'ont pas du tout la même conséquence sur une base de production.
 *
 * C'est ce dont `prisma-schema.spec.ts` a besoin depuis #534 pour admettre un
 * `DROP INDEX` de remplacement sans ouvrir la porte à un retrait sec.
 *
 * @throws si aucune migration n'est trouvée — même borne que ci-dessous.
 */
export function readMigrations(): readonly Migration[] {
  const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Prisma préfixe chaque dossier d'un horodatage : l'ordre alphabétique est
    // l'ordre d'application.
    .sort();

  if (directories.length === 0) {
    throw new Error(`aucune migration sous « ${MIGRATIONS_DIR} »`);
  }

  return directories.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
  }));
}

/**
 * Le SQL de toutes les migrations concaténé, dans son ordre d'application.
 *
 * @throws si aucune migration n'est trouvée — sans cette borne, un dossier
 * introuvable ou vide rendrait une chaîne vide, sur laquelle toute assertion
 * « le SQL ne contient pas … » passerait au vert sans rien avoir lu.
 */
export function readMigrationSql(): string {
  return readMigrations()
    .map((migration) => migration.sql)
    .join('\n');
}
