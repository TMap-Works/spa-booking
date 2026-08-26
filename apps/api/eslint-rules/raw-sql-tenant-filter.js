'use strict';

/**
 * `tenant/raw-sql-tenant-filter` — première des deux gardes de #169.
 *
 * `ScopedPrismaClient` est un `PrismaClient` **étendu**, pas restreint : les
 * méthodes de SQL brut restent appelables sur la porte réputée sûre, et elles
 * ne passent pas par le pipeline `$allOperations` de
 * `tenant-scope.extension.ts`. Aucun `WHERE tenant_id = …` n'y est injecté —
 * l'extension le documente elle-même (« Ce que l'extension ne couvre pas »,
 * angle mort n°1), mais rien jusqu'ici ne le détectait.
 *
 * Le risque n'est pas théorique : la contrainte d'exclusion anti-double-
 * réservation et les verrous consultatifs du moteur de disponibilité passeront
 * nécessairement par du SQL que Prisma n'exprime pas.
 *
 * La règle est donc **fermée par défaut**, exactement comme l'extension :
 *
 * - le SQL littéral du site d'appel mentionne `tenant_id` → accepté ;
 * - il ne le mentionne pas → refusé (`missingTenantFilter`) ;
 * - il n'y a **aucun** littéral à lire, parce que la requête est construite
 *   ailleurs → refusé aussi (`opaqueSql`). Une requête que la garde ne peut pas
 *   lire n'est pas une requête qu'elle peut déclarer sûre.
 *
 * La dérogation existe et reste visible : un `eslint-disable-next-line` nommant
 * la règle, accompagné de son motif. C'est la même discipline que
 * `prismaUnscoped` — un `grep` rend la liste complète des exceptions.
 *
 * ## Ce que cette garde ne couvre pas
 *
 * Le même devoir de franchise que `tenant-scope.extension.ts` : une protection
 * dont on croit à tort qu'elle couvre tout est pire qu'une protection dont on
 * connaît les bords.
 *
 * **1. La position du `tenant_id`.** La garde vérifie que la colonne est
 * *mentionnée*, pas qu'elle *filtre*. `SELECT tenant_id, count(*) FROM
 * appointments GROUP BY tenant_id` — une lecture inter-tenant — la satisfait.
 * Distinguer une projection d'un prédicat demande d'analyser le SQL, pas de le
 * lire : c'est une décision de conception, ouverte en suivi. La garde force
 * aujourd'hui l'auteur à écrire la colonne au site d'appel, donc à y penser ;
 * elle ne dispense pas la revue de lire la requête.
 *
 * **2. Le pool `pg` de service.** `DatabaseConnection` expose PostgreSQL hors
 * de Prisma — `client.query(…)` n'est pas inspecté. `.query` est un nom trop
 * générique pour être intercepté sans faux positifs, et la sonde `/health`
 * (`SELECT 1`) demanderait une exemption. Également ouvert en suivi.
 */

/** Les quatre portes de SQL brut de Prisma, sûres et « unsafe » confondues. */
const RAW_METHODS = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);

/**
 * Le nom de la colonne discriminante **en SQL**, et non celui du champ Prisma :
 * le schéma déclare `tenantId @map("tenant_id")`, et du SQL brut parle à
 * PostgreSQL, pas au client.
 */
const TENANT_COLUMN = /tenant_id/i;

/**
 * Commentaires SQL : la forme ligne (deux tirets) et la forme bloc.
 *
 * Ils sont retirés **avant** la recherche de `tenant_id` : sans cela, un
 * `-- pas de tenant_id ici, c'est global` suffirait à satisfaire la garde. Une
 * garde qu'un commentaire désarme ne garde rien.
 */
const SQL_COMMENT = /--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Nom de la méthode de SQL brut appelée, ou `undefined` si l'expression n'en
 * est pas une. Couvre `prisma.$queryRaw` comme `prisma['$queryRaw']` — la forme
 * calculée n'est pas une échappatoire.
 *
 * @param {any} callee
 * @returns {string | undefined}
 */
function rawMethodName(callee) {
  if (!callee || callee.type !== 'MemberExpression') {
    return undefined;
  }
  const property = callee.property;
  if (callee.computed) {
    return property.type === 'Literal' &&
      typeof property.value === 'string' &&
      RAW_METHODS.has(property.value)
      ? property.value
      : undefined;
  }
  return property.type === 'Identifier' && RAW_METHODS.has(property.name)
    ? property.name
    : undefined;
}

/**
 * Rassemble tout le texte SQL **littéral** lisible au site d'appel : les
 * fragments de gabarit et les chaînes passées en argument, y compris à travers
 * un `Prisma.sql` imbriqué.
 *
 * Volontairement limité aux littéraux : un identifiant renvoie à une valeur que
 * la règle ne peut pas suivre, et prétendre le contraire donnerait une garantie
 * fausse. L'absence de littéral se traite comme un refus, pas comme un silence.
 *
 * @param {any} node racine du sous-arbre à parcourir
 * @returns {string[]} fragments littéraux, dans un ordre non garanti
 */
function collectLiteralSql(node) {
  /** @type {string[]} */
  const chunks = [];
  /** @type {any[]} */
  const stack = [node];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current.type !== 'string') {
      continue;
    }

    if (current.type === 'TemplateElement') {
      chunks.push(current.value.cooked ?? current.value.raw);
      continue;
    }
    if (current.type === 'Literal' && typeof current.value === 'string') {
      chunks.push(current.value);
      continue;
    }

    for (const key of Object.keys(current)) {
      // `parent` remonte l'arbre : le suivre ferait sortir du site d'appel et
      // ramasserait le SQL du voisin.
      if (key === 'parent') {
        continue;
      }
      stack.push(current[key]);
    }
  }

  return chunks;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Exige un filtre `tenant_id` explicite dans tout SQL brut Prisma — le scoping automatique ne couvre pas $queryRaw/$executeRaw.',
    },
    schema: [],
    messages: {
      missingTenantFilter:
        "`{{method}}` ne passe pas par l'extension de scoping : aucun filtre tenant n'y est injecté. Ce SQL ne mentionne pas `tenant_id` — écrire le filtre à la main, ou justifier la dérogation par un `eslint-disable-next-line tenant/raw-sql-tenant-filter` commenté.",
      opaqueSql:
        "`{{method}}` reçoit un SQL construit ailleurs : la garde ne peut pas vérifier qu'il porte `tenant_id`, et le SQL brut échappe à l'extension de scoping. Écrire la requête au site d'appel, ou justifier la dérogation par un `eslint-disable-next-line tenant/raw-sql-tenant-filter` commenté.",
    },
  },

  create(context) {
    /**
     * @param {any} node site d'appel complet — c'est lui que le rapport désigne
     * @param {any} sqlRoot sous-arbre qui **porte le SQL**, et lui seul
     * @param {string} method nom de la méthode brute appelée
     */
    function check(node, sqlRoot, method) {
      const sql = collectLiteralSql(sqlRoot).join(' ');

      if (sql.trim() === '') {
        context.report({ node, messageId: 'opaqueSql', data: { method } });
        return;
      }
      // Les commentaires ne filtrent rien : ce qui est lu est le SQL exécuté.
      if (!TENANT_COLUMN.test(sql.replace(SQL_COMMENT, ' '))) {
        context.report({ node, messageId: 'missingTenantFilter', data: { method } });
      }
    }

    return {
      // `prisma.$queryRaw`SELECT …`` — la forme sûre, paramétrée par gabarit.
      // Seul le gabarit porte du SQL : le `tag` est la méthode elle-même.
      TaggedTemplateExpression(node) {
        const method = rawMethodName(node.tag);
        if (method !== undefined) {
          check(node, node.quasi, method);
        }
      },
      // `prisma.$executeRawUnsafe('…', …)` et `prisma.$queryRaw(Prisma.sql`…`)`.
      //
      // **Seul le premier argument** est lu : c'est le contrat de Prisma —
      // `$queryRawUnsafe(query, ...values)` et `$queryRaw(Prisma.sql`…`)`
      // portent le SQL en position 0, les suivants sont des valeurs liées.
      // Élargir la lecture à tous les arguments laisserait un littéral de
      // valeur — `$queryRawUnsafe(build(cols), 'tenant_id')` — se faire passer
      // pour le SQL et satisfaire la garde sur une requête qu'elle n'a jamais
      // lue. Le `callee` est exclu pour la même raison : un accès calculé
      // (`prisma['$queryRawUnsafe']`) ferait passer son propre nom de méthode
      // pour du SQL lisible.
      //
      // Un appel sans argument, ou dont le premier est un `...spread`, ne
      // fournit aucun littéral : `opaqueSql`, comme toute requête illisible.
      CallExpression(node) {
        const method = rawMethodName(node.callee);
        if (method !== undefined) {
          check(node, node.arguments[0], method);
        }
      },
    };
  },
};
