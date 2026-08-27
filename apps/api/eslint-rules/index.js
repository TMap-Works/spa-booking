'use strict';

/**
 * Plugin ESLint local `tenant` — les trois gardes qui ferment les échappatoires
 * au scoping multi-tenant (#169 et #268, suivi de #20).
 *
 * `tenant-scope.extension.ts` rend le scoping mécanique pour tout ce qui passe
 * par le pipeline des opérations de modèle. Restaient trois chemins que seule la
 * discipline de revue tenait :
 *
 * 1. **le SQL brut** — `$queryRaw` / `$executeRaw` restent appelables sur le
 *    client scopé et n'y reçoivent aucun filtre (`raw-sql-tenant-filter`) ;
 * 2. **le nom d'injection** — `PRISMA_UNSCOPED` pouvait être injecté sous
 *    n'importe quel nom, rendant ses usages indiscernables d'un accès scopé
 *    (`unscoped-prisma-name`) ;
 * 3. **le pool `pg` de service** — un second accès à PostgreSQL, entièrement
 *    hors de Prisma, ouvrable par un simple `import` (`service-pool-confinement`).
 *
 * Les trois règles sont branchées en `error` dans `eslint.config.mjs`, donc dans
 * `npm run lint`, donc dans `npm run verify` et dans le job `lint` de la CI. Une
 * garde qui existe sans être exécutée ne garde rien.
 *
 * Chacune est **syntaxique** : aucune ne demande `parserOptions.project`. Ce
 * choix est mesuré et assumé — voir
 * [l'ADR 0006](../../../docs/adr/0006-portee-des-gardes-de-scoping.md), qui dit
 * aussi ce qu'il laisse ouvert.
 *
 * Le plugin est délibérément local et non publié : il ne parle que de
 * conventions de ce dépôt, et un paquet séparé ajouterait une version à tenir
 * pour trois règles de cent lignes.
 */

const rawSqlTenantFilter = require('./raw-sql-tenant-filter');
const servicePoolConfinement = require('./service-pool-confinement');
const unscopedPrismaName = require('./unscoped-prisma-name');

module.exports = {
  meta: {
    name: 'eslint-plugin-tenant',
    version: '1.1.0',
  },
  rules: {
    'raw-sql-tenant-filter': rawSqlTenantFilter,
    'service-pool-confinement': servicePoolConfinement,
    'unscoped-prisma-name': unscopedPrismaName,
  },
};
