'use strict';

/**
 * `tenant/service-pool-confinement` — troisième garde du scoping, ouverte par
 * #169 et tranchée par #268.
 *
 * ## Le problème posé
 *
 * `DatabaseConnection` ouvre un pool `pg` **hors de Prisma** : ni l'extension de
 * scoping ni `tenant/raw-sql-tenant-filter` n'y voient quoi que ce soit. Un
 * `client.query('SELECT * FROM appointments')` écrit là passerait toutes nos
 * barrières.
 *
 * ## Pourquoi ce n'est pas `.query` qui est inspecté
 *
 * L'inspection directe des appels `.query(…)` a été pesée et écartée
 * (ADR 0006). Trois obstacles, tous mesurés sur ce dépôt :
 *
 * 1. `.query` est un nom trop générique pour être intercepté sur son seul nom :
 *    distinguer un pool `pg` d'un autre objet demande le **type**, donc
 *    `parserOptions.project`, mesuré à ×2 sur le temps de lint (2,9 s → 5,8 s à
 *    chaud) et croissant avec le dépôt ;
 * 2. les quatre seuls appels `.query(…)` du dépôt sont **tous** légitimement
 *    sans tenant — le `SELECT 1` de la sonde `/health`, et les `CREATE
 *    DATABASE` / `DROP DATABASE` / rejeu de migration du harnais de test
 *    jetable. Une garde sur `.query` serait aujourd'hui à 100 % de faux
 *    positifs, et n'existerait que par ses exemptions ;
 * 3. un verrou consultatif (`pg_advisory_xact_lock`) dérive sa clé du tenant
 *    sans jamais nommer la colonne : aucune lecture du SQL ne peut le valider.
 *
 * ## Ce que cette règle fait à la place : confiner, pas inspecter
 *
 * Le pool est déjà fermé **par construction** — `DatabaseConnection.pool` est
 * privé, et la classe n'expose aucune méthode qui exécute du SQL fourni par
 * l'appelant. Le seul moyen d'ouvrir un second chemin brut vers le schéma est
 * d'importer `pg` ailleurs. C'est cela que la règle interdit.
 *
 * Une seule exemption, et elle est nommée ici plutôt que dispersée en
 * `eslint-disable` : le fichier qui *est* le pool de service. Le harnais de test
 * n'a pas besoin d'y figurer — la règle n'est branchée que sur `src/**`, et ce
 * qu'il fait (créer et détruire des bases) n'est pas un accès au schéma métier.
 *
 * Ce que la règle ne couvre pas, et qui reste tenu par la revue : une méthode
 * de passe-plat ajoutée *à l'intérieur* de `database.connection.ts`. Le fichier
 * est court et son en-tête le dit ; c'est le prix assumé de ne pas typer le
 * lint.
 */

/**
 * Les modules qui donnent un accès PostgreSQL direct. `pg-native` et `pg-pool`
 * sont des portes dérobées du même paquet : les omettre laisserait le
 * contournement à un `import` près.
 */
const RESTRICTED_MODULES = new Set(['pg', 'pg-pool', 'pg-native']);

/**
 * Le paquet visé par un spécificateur, ou `undefined` s'il n'en vise aucun.
 *
 * Comparer le spécificateur entier laisserait le contournement à un sous-chemin
 * près : `pg/lib/client` exporte exactement le même `Client` que `pg`. On
 * compare donc la **racine** du chemin — ce qui laisse passer `pgfmt`, qui n'est
 * pas `pg`.
 *
 * @param {string} specifier chemin de module écrit dans le source
 * @returns {string | undefined}
 */
function restrictedModule(specifier) {
  const root = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  return RESTRICTED_MODULES.has(root) ? specifier : undefined;
}

/**
 * Le seul fichier autorisé à ouvrir le pool. Comparé par suffixe de chemin
 * normalisé : ESLint rend un chemin absolu, en séparateurs Windows sur cette
 * plateforme.
 */
const POOL_OWNER = 'src/infrastructure/database/database.connection.ts';

/**
 * @param {string} filename chemin du fichier analysé, tel qu'ESLint le rend
 * @returns {boolean}
 */
function isPoolOwner(filename) {
  return filename.replace(/\\/g, '/').endsWith(POOL_OWNER);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Confine le pool `pg` de service à `database.connection.ts` — hors de lui, aucun accès PostgreSQL n'échappe à Prisma et à son scoping.",
    },
    schema: [],
    messages: {
      poolOutsideOwner:
        "`{{module}}` ouvre un accès PostgreSQL direct, hors de Prisma et hors de l'extension de scoping : aucune de nos gardes tenant ne voit ce qui y passe. Le seul pool de service du projet vit dans `database.connection.ts` et n'exécute que la sonde `/health` ; l'accès aux données métier passe par le client Prisma scopé (`PRISMA`). Si un besoin de SQL brut le justifie, l'écrire avec `$queryRaw` — que `tenant/raw-sql-tenant-filter` inspecte.",
    },
  },

  create(context) {
    if (isPoolOwner(context.filename)) {
      return {};
    }

    /**
     * @param {any} node nœud à désigner dans le rapport
     * @param {any} source littéral de chemin de module, ou `null`
     */
    function check(node, source) {
      if (
        source === null ||
        source === undefined ||
        source.type !== 'Literal' ||
        typeof source.value !== 'string'
      ) {
        return;
      }
      const module = restrictedModule(source.value);
      if (module !== undefined) {
        context.report({ node, messageId: 'poolOutsideOwner', data: { module } });
      }
    }

    return {
      // `import { Pool } from 'pg'`, `import type { PoolClient } from 'pg'`.
      // Les imports de type ne sont pas exemptés : un fichier qui manipule les
      // types de `pg` est un fichier qui manipule `pg`.
      ImportDeclaration(node) {
        check(node, node.source);
      },
      // `export { Pool } from 'pg'` et `export * from 'pg'` — réexporter le
      // module reviendrait à le déplacer sans le confiner.
      ExportNamedDeclaration(node) {
        check(node, node.source);
      },
      ExportAllDeclaration(node) {
        check(node, node.source);
      },
      // `await import('pg')`.
      ImportExpression(node) {
        check(node, node.source);
      },
      // `require('pg')` — hors d'atteinte en TypeScript, où
      // `@typescript-eslint/no-require-imports` l'interdit déjà, mais la règle
      // ne doit pas dépendre d'une autre pour tenir.
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, node.arguments[0]);
        }
      },
      // `import pg = require('pg')` — la seconde forme de `require`, propre à
      // TypeScript. Même raison de la couvrir que la première.
      TSImportEqualsDeclaration(node) {
        const reference = node.moduleReference;
        if (reference !== undefined && reference.type === 'TSExternalModuleReference') {
          check(node, reference.expression);
        }
      },
    };
  },
};
