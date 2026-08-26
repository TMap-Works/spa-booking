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

/**
 * Le SQL de toutes les migrations concaténé, dans son ordre d'application.
 *
 * @throws si aucune migration n'est trouvée — sans cette borne, un dossier
 * introuvable ou vide rendrait une chaîne vide, sur laquelle toute assertion
 * « le SQL ne contient pas … » passerait au vert sans rien avoir lu.
 */
export function readMigrationSql(): string {
  const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Prisma préfixe chaque dossier d'un horodatage : l'ordre alphabétique est
    // l'ordre d'application.
    .sort();

  if (directories.length === 0) {
    throw new Error(`aucune migration sous « ${MIGRATIONS_DIR} »`);
  }

  return directories
    .map((directory) => readFileSync(join(MIGRATIONS_DIR, directory, 'migration.sql'), 'utf8'))
    .join('\n');
}
