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
 * - le SQL littéral du site d'appel emploie `tenant_id` **en position
 *   filtrante** → accepté ;
 * - il ne mentionne pas du tout la colonne → refusé (`missingTenantFilter`) ;
 * - il la mentionne, mais nulle part où elle contraigne la requête — projetée,
 *   groupée, triée — → refusé (`tenantNotFiltering`) ;
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
 * connaît les bords. Les deux bords ouverts en suivi (#268) ont été tranchés ;
 * ce qui reste ouvert est décrit ici et dans
 * [l'ADR 0006](../../../docs/adr/0006-portee-des-gardes-de-scoping.md).
 *
 * **1. La position est reconnue par motif, pas par analyse.** Depuis #268, la
 * garde exige que `tenant_id` apparaisse dans une position qui *contraint* la
 * requête — comparaison, `USING`, liste de colonnes d'`INSERT`. Elle ne
 * construit pas d'arbre syntaxique SQL, et ne sait donc pas dire **à quelle
 * table** ni **à quel niveau de sous-requête** le prédicat s'applique. Une
 * requête dont la sous-requête porte le filtre et dont la table externe ne
 * l'a pas — `… FROM appointments WHERE id IN (SELECT id FROM x WHERE
 * tenant_id = $1)` — la satisfait toujours. De même, `UPDATE t SET tenant_id
 * = $1 WHERE id = $2` écrit la colonne sans borner la ligne visée. Aller
 * plus loin demanderait un analyseur SQL : le coût a été jugé disproportionné
 * face à une revue qui lit la requête (ADR 0006).
 *
 * **2. Le pool `pg` de service reste hors du champ de cette règle.** Elle ne
 * connaît que les quatre portes de SQL brut de Prisma. `DatabaseConnection` et
 * son `client.query(…)` sont couverts autrement — par confinement plutôt que
 * par inspection : voir `tenant/service-pool-confinement` et la section
 * « Ce que cette exemption suppose » de `database.connection.ts`.
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
 * La colonne, telle qu'on l'écrit vraiment : éventuellement entre guillemets
 * doubles (`"tenant_id"`) et éventuellement transtypée (`tenant_id::text`).
 * Le qualificatif de table qui la précède — `a.`, `"a".` — n'a pas besoin
 * d'être décrit ici : `\b` s'ancre après le point.
 */
const TENANT_REF = '\\btenant_id\\b"?(?:\\s*::\\s*"?\\w+"?)?';

/** Qualificatif de table facultatif, pour la forme `$1 = a.tenant_id`. */
const QUALIFIER = '(?:[\\w"]+\\s*\\.\\s*)?';

/**
 * Opérateurs de comparaison, symboles puis mots-clés.
 *
 * `IS` porte une exception : `tenant_id IS NULL` et `tenant_id IS NOT NULL` sont
 * bien des prédicats, mais aucun des deux ne borne la lecture à un
 * établissement — `IS NOT NULL` sur une colonne `NOT NULL` lit *tous* les
 * tenants tout en satisfaisant la garde. La négation ne retire que ces deux
 * formes : `tenant_id IS NOT DISTINCT FROM $1` reste accepté.
 */
const COMPARISON = '(?:=|<>|!=|>=|<=|>|<|!?~~?\\*?)';
const COMPARISON_WORD =
  '(?:IS(?!\\s+(?:NOT\\s+)?NULL\\b)|IN|ANY|ALL|BETWEEN|LIKE|ILIKE|SIMILAR|WITH)\\b';

/**
 * Les positions dans lesquelles `tenant_id` **contraint** la requête — par
 * opposition à celles où il n'est que projeté, groupé ou trié (#268).
 *
 * L'ancienne version de la règle se contentait de la *mention* de la colonne.
 * `SELECT tenant_id, count(*) FROM appointments GROUP BY tenant_id` — une
 * lecture de tous les établissements — la satisfaisait.
 *
 * La liste est **délibérément généreuse** : le coût d'un faux positif tombe sur
 * du SQL brut légitime, écrit par le moteur de disponibilité au moment même où
 * cette garde se durcit (#31). Un cas oublié refuse une requête correcte et
 * bloque la CI d'un tiers ; un cas accepté à tort laisse passer une requête que
 * la revue lit de toute façon. On préfère donc accepter large et nommer les
 * bords, plutôt que refuser serré et casser en aval.
 *
 * Cinq positions sont reconnues :
 *
 * - **a.** une comparaison, dans un sens ou dans l'autre : `tenant_id = $1`,
 *   `a.tenant_id = b.tenant_id`, `tenant_id::text = $1`, `tenant_id IN (…)`,
 *   et `tenant_id WITH =` — la forme qu'exige `EXCLUDE USING gist`, donc la
 *   contrainte anti-double-réservation de l'ADR 0002 ;
 * - **b.** la valeur à gauche : `$1 = a.tenant_id` ;
 * - **c.** `JOIN … USING (tenant_id)` — la jointure porte l'égalité sans
 *   l'écrire ;
 * - **d.** `INSERT INTO … (tenant_id, …)` — l'écriture porte le tenant sans
 *   jamais le comparer ;
 * - **e.** la colonne parenthésée, seule ou en comparaison de n-uplet :
 *   `(tenant_id) = $1` et `(tenant_id, staff_id) = ($1, $2)`. La seconde forme
 *   n'a rien d'exotique ici : le schéma est bâti sur des clés composites
 *   `(tenant_id, id)`, et une jointure ou un `WHERE` écrit à la main les
 *   reprend telles quelles.
 */
const FILTERING_TENANT = new RegExp(
  [
    `${TENANT_REF}\\s*(?:${COMPARISON}|${COMPARISON_WORD})`,
    `${COMPARISON}\\s*${QUALIFIER}"?${TENANT_REF}`,
    '\\bUSING\\s*\\([^)]*\\btenant_id\\b',
    '\\bINSERT\\s+INTO\\b[^(]*\\([^)]*\\btenant_id\\b',
    `\\([^()]*\\btenant_id\\b[^()]*\\)\\s*(?:${COMPARISON}|${COMPARISON_WORD})`,
  ].join('|'),
  'i',
);

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
 * Les fragments sortent **dans l'ordre du source**. Ce n'était pas le cas
 * jusqu'à #268 : le parcours les rendait dans l'ordre des clés de l'AST, ce qui
 * était sans effet tant que la garde cherchait une sous-chaîne, mais fausse une
 * lecture de position — `tenant_id` et l'opérateur qui le suit doivent rester
 * voisins. L'ordre des clés ne suffit pas à le garantir : un `TemplateLiteral`
 * de `typescript-eslint` porte `expressions` **avant** `quasis`, si bien qu'un
 * littéral interpolé remonterait devant tout le gabarit. Les fragments sont donc
 * triés sur leur position réelle dans le source (`range[0]`), seule information
 * qui ne dépende ni de la forme du nœud ni de la version du parseur.
 *
 * @param {any} node racine du sous-arbre à parcourir
 * @returns {string[]} fragments littéraux, dans l'ordre du source
 */
function collectLiteralSql(node) {
  /** @type {{ start: number; text: string }[]} */
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

    const start = Array.isArray(current.range) ? current.range[0] : 0;
    if (current.type === 'TemplateElement') {
      chunks.push({ start, text: current.value.cooked ?? current.value.raw });
      continue;
    }
    if (current.type === 'Literal' && typeof current.value === 'string') {
      chunks.push({ start, text: current.value });
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

  return chunks.sort((left, right) => left.start - right.start).map((chunk) => chunk.text);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Exige un filtre `tenant_id` en position contraignante dans tout SQL brut Prisma — le scoping automatique ne couvre pas $queryRaw/$executeRaw.',
    },
    schema: [],
    messages: {
      missingTenantFilter:
        "`{{method}}` ne passe pas par l'extension de scoping : aucun filtre tenant n'y est injecté. Ce SQL ne mentionne pas `tenant_id` — écrire le filtre à la main, ou justifier la dérogation par un `eslint-disable-next-line tenant/raw-sql-tenant-filter` commenté.",
      tenantNotFiltering:
        "`{{method}}` mentionne `tenant_id` sans jamais s'en servir pour contraindre la requête : projeter, grouper ou trier sur la colonne ne borne pas la lecture à un établissement. Écrire une comparaison (`tenant_id = $1`), une jointure (`USING (tenant_id)` ou `ON a.tenant_id = b.tenant_id`) ou une liste de colonnes d'`INSERT` — ou justifier la dérogation par un `eslint-disable-next-line tenant/raw-sql-tenant-filter` commenté.",
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
      const statement = sql.replace(SQL_COMMENT, ' ');

      // Deux diagnostics distincts, parce qu'ils appellent deux corrections
      // distinctes : ajouter la colonne, ou la déplacer là où elle contraint.
      if (!TENANT_COLUMN.test(statement)) {
        context.report({ node, messageId: 'missingTenantFilter', data: { method } });
        return;
      }
      if (!FILTERING_TENANT.test(statement)) {
        context.report({ node, messageId: 'tenantNotFiltering', data: { method } });
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
