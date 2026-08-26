'use strict';

/**
 * `tenant/unscoped-prisma-name` — seconde des deux gardes de #169.
 *
 * `prisma-clients.ts` annonce une garantie : « `grep -rn PRISMA_UNSCOPED
 * apps/api/src` rend la liste complète des dérogations », et chaque dérogation
 * se reconnaît au nom `prismaUnscoped`. Mais `PRISMA_UNSCOPED` est un symbole
 * d'injection ordinaire : rien n'empêchait jusqu'ici un repository de l'injecter
 * sous `private readonly db`, ce qui laisse la liste des dérogations exacte tout
 * en rendant leurs **usages** invisibles à la relecture — `this.db.user.findMany()`
 * se lit exactement comme un accès scopé.
 *
 * La règle rétablit la garantie au seul endroit qui compte : le site
 * d'injection, dans les **deux** formes que Nest offre — toutes deux doivent
 * lier le nom `prismaUnscoped` :
 *
 * - `@Inject(PRISMA_UNSCOPED)`, sur un paramètre de constructeur, un
 *   paramètre-propriété ou une propriété de classe ;
 * - `{ useFactory: (…) => …, inject: [PRISMA_UNSCOPED] }`, la forme sans
 *   décorateur, celle que `database.module.ts` emploie déjà.
 *
 * Elle ne dit rien du client scopé : `@Inject(PRISMA)` est le chemin normal, et
 * un chemin normal n'a pas à se signaler.
 */

/** Le symbole d'injection dont le nom lié est contraint. */
const UNSCOPED_TOKEN = 'PRISMA_UNSCOPED';

/** Le seul nom admis — celui sur lequel `prisma-clients.ts` fait reposer le grep. */
const REQUIRED_NAME = 'prismaUnscoped';

/**
 * L'expression désigne-t-elle le symbole `PRISMA_UNSCOPED` ?
 *
 * Accepte la forme qualifiée (`clients.PRISMA_UNSCOPED`) : c'est le même
 * symbole, importé autrement.
 *
 * @param {any} token expression du jeton d'injection
 * @returns {boolean}
 */
function isUnscopedToken(token) {
  if (!token) {
    return false;
  }
  if (token.type === 'Identifier') {
    return token.name === UNSCOPED_TOKEN;
  }
  if (token.type === 'MemberExpression' && !token.computed) {
    return token.property.type === 'Identifier' && token.property.name === UNSCOPED_TOKEN;
  }
  return false;
}

/**
 * Le décorateur est-il un `@Inject(PRISMA_UNSCOPED)` ?
 *
 * @param {any} expression expression du décorateur
 * @returns {boolean}
 */
function isUnscopedInject(expression) {
  if (!expression || expression.type !== 'CallExpression') {
    return false;
  }
  const callee = expression.callee;
  if (!callee || callee.type !== 'Identifier' || callee.name !== 'Inject') {
    return false;
  }
  return isUnscopedToken(expression.arguments[0]);
}

/**
 * Propriété non calculée d'un objet littéral, par son nom — `inject`,
 * `useFactory`. Couvre la clé identifiante comme la clé en chaîne.
 *
 * @param {any} objectExpression
 * @param {string} name
 * @returns {any} le nœud `Property`, ou `undefined`
 */
function propertyNamed(objectExpression, name) {
  return objectExpression.properties.find(
    (property) =>
      property.type === 'Property' &&
      !property.computed &&
      ((property.key.type === 'Identifier' && property.key.name === name) ||
        (property.key.type === 'Literal' && property.key.value === name)),
  );
}

/**
 * L'identifiant que le décorateur lie, quelle que soit la forme d'injection.
 *
 * @param {any} decorated nœud portant le décorateur
 * @returns {any} l'identifiant lié, ou `undefined` si la forme est inconnue
 */
function boundIdentifier(decorated) {
  if (!decorated) {
    return undefined;
  }
  switch (decorated.type) {
    // `constructor(@Inject(T) private readonly x: U)` — paramètre-propriété.
    case 'TSParameterProperty':
      return boundIdentifier(decorated.parameter);
    // `constructor(@Inject(T) x: U)` — paramètre nu.
    case 'Identifier':
      return decorated;
    // Paramètre avec valeur par défaut.
    case 'AssignmentPattern':
      return boundIdentifier(decorated.left);
    // `@Inject(T) private readonly x!: U` — propriété de classe, champ
    // `accessor` compris : la seconde forme lie un nom exactement comme la
    // première, et l'exclure rouvrirait la porte que la règle ferme.
    case 'PropertyDefinition':
    case 'AccessorProperty':
      return !decorated.computed && decorated.key.type === 'Identifier'
        ? decorated.key
        : undefined;
    default:
      return undefined;
  }
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Impose le nom `prismaUnscoped` à toute injection de PRISMA_UNSCOPED — le nom est ce qui rend la dérogation au scoping visible en revue.',
    },
    schema: [],
    messages: {
      wrongName:
        "Une injection de `PRISMA_UNSCOPED` doit se nommer `{{required}}`, pas `{{actual}}` : le client non scopé ne porte aucun filtre tenant, et c'est son nom — pas son type — qui signale la dérogation à la relecture (tenant-isolation §3). Renommer, et commenter la raison pour laquelle le scoping ne s'applique pas ici.",
    },
  },

  create(context) {
    /**
     * @param {any} identifier nom lié au client non scopé
     */
    function checkName(identifier) {
      if (!identifier || identifier.name === REQUIRED_NAME) {
        return;
      }
      context.report({
        node: identifier,
        messageId: 'wrongName',
        data: { required: REQUIRED_NAME, actual: identifier.name },
      });
    }

    return {
      // Seconde forme d'injection, et la seule que Nest offre sans décorateur :
      // `{ provide: T, useFactory: (db) => …, inject: [PRISMA_UNSCOPED] }`.
      // C'est le style que `database.module.ts` emploie déjà — sans ce visiteur,
      // il suffirait d'écrire son provider en fabrique pour lier le client non
      // scopé à `db` et rendre la dérogation invisible, décorateur ou pas.
      //
      // La vérification demande une fonction **écrite sur place** : une fabrique
      // désignée par référence (`useFactory: createScanner`) n'expose pas ses
      // paramètres au site d'injection, et la règle ne les suit pas.
      ObjectExpression(node) {
        const inject = propertyNamed(node, 'inject');
        if (!inject || inject.value.type !== 'ArrayExpression') {
          return;
        }
        const factory = propertyNamed(node, 'useFactory');
        if (!factory) {
          return;
        }
        const fn = factory.value;
        if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') {
          return;
        }
        inject.value.elements.forEach((token, index) => {
          if (isUnscopedToken(token)) {
            checkName(boundIdentifier(fn.params[index]));
          }
        });
      },
      Decorator(node) {
        if (!isUnscopedInject(node.expression)) {
          return;
        }
        // Le parent d'un décorateur est toujours la déclaration qu'il décore :
        // `TSParameterProperty` pour un paramètre-propriété, `Identifier` pour
        // un paramètre nu, `PropertyDefinition` pour une propriété de classe.
        checkName(boundIdentifier(node.parent));
      },
    };
  },
};
