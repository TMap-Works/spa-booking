'use strict';

/**
 * Plugin ESLint local `tenant` — les deux gardes qui ferment les échappatoires
 * au scoping multi-tenant (#169, suivi de #20).
 *
 * `tenant-scope.extension.ts` rend le scoping mécanique pour tout ce qui passe
 * par le pipeline des opérations de modèle. Restaient deux chemins que seule la
 * discipline de revue tenait :
 *
 * 1. **le SQL brut** — `$queryRaw` / `$executeRaw` restent appelables sur le
 *    client scopé et n'y reçoivent aucun filtre (`raw-sql-tenant-filter`) ;
 * 2. **le nom d'injection** — `PRISMA_UNSCOPED` pouvait être injecté sous
 *    n'importe quel nom, rendant ses usages indiscernables d'un accès scopé
 *    (`unscoped-prisma-name`).
 *
 * Les deux règles sont branchées en `error` dans `eslint.config.mjs`, donc dans
 * `npm run lint`, donc dans `npm run verify` et dans le job `lint` de la CI. Une
 * garde qui existe sans être exécutée ne garde rien.
 *
 * Le plugin est délibérément local et non publié : il ne parle que de
 * conventions de ce dépôt, et un paquet séparé ajouterait une version à tenir
 * pour deux règles de cent lignes.
 */

const rawSqlTenantFilter = require('./raw-sql-tenant-filter');
const unscopedPrismaName = require('./unscoped-prisma-name');

module.exports = {
  meta: {
    name: 'eslint-plugin-tenant',
    version: '1.0.0',
  },
  rules: {
    'raw-sql-tenant-filter': rawSqlTenantFilter,
    'unscoped-prisma-name': unscopedPrismaName,
  },
};
