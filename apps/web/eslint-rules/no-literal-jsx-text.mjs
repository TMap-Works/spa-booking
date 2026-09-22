/**
 * `spa-i18n/no-literal-jsx-text` — aucun texte affichable écrit en dur dans le
 * JSX (#845, avant-dernier critère d'acceptation).
 *
 * ## Ce qu'elle attrape
 *
 * - le texte nu entre deux balises — `<p>Bonjour</p>` ;
 * - la même chose écrite en expression — `<p>{'Bonjour'}</p>` ;
 * - les attributs que l'utilisateur **lit ou entend** : `alt`, `title`,
 *   `placeholder`, `aria-label`, `aria-description`, `aria-placeholder`,
 *   `aria-roledescription`, `aria-valuetext`.
 *
 * ## Ce qu'elle laisse passer, et pourquoi
 *
 * - **la ponctuation seule et les symboles** — `·`, `—`, `*`, `:`, `…`. Ils ne
 *   se traduisent pas, et les exiger dans un catalogue rendrait les catalogues
 *   illisibles sans rien apporter à qui lit l'écran ;
 * - **les chiffres nus** — une quantité n'est pas une phrase ;
 * - **tout ce qui vient d'une variable** — `{t('title')}`, `{salonName}` : c'est
 *   précisément la forme qu'on veut ;
 * - **les attributs techniques** — `className`, `href`, `id`, `name`, `type`,
 *   `lang`… Ils ne sont pas affichés.
 *
 * ## Elle est désactivée par défaut
 *
 * La configuration ne l'active que dans les répertoires qui portent un fichier
 * marqueur `.i18n-lint`. C'est ce qui permet à un ticket d'écran de l'allumer
 * sur **son** périmètre en déposant un fichier vide, sans toucher
 * `eslint.config.mjs` — donc sans entrer en conflit de fusion avec les dix
 * autres tickets de l'épique #843.
 */

/** Ce qui, dans un texte, demande une traduction : au moins une lettre. */
const HAS_LETTER = /\p{L}/u;

/**
 * Les attributs dont la valeur est lue par un humain — les seuls qui comptent.
 *
 * Liste explicite et non « tout sauf » : `className` porte des mots, `href` des
 * chemins, et une règle qui les signalerait serait débranchée le jour même.
 */
const TRANSLATABLE_ATTRIBUTES = new Set([
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);

/** `true` si cette chaîne est du texte destiné à être lu. */
function isDisplayText(value) {
  return HAS_LETTER.test(value);
}

/** Le littéral de chaîne porté par ce nœud, ou `null`. */
function stringLiteral(node) {
  if (node === null || node === undefined) {
    return null;
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }

  // Un gabarit sans substitution est un littéral qui s'ignore.
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }

  return null;
}

export const noLiteralJsxText = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Interdit les textes affichables écrits en dur dans le JSX — ils doivent venir du catalogue de messages.',
    },
    schema: [],
    messages: {
      literal:
        'Texte en dur dans le JSX : « {{text}} ». Passez par le catalogue de messages (useTranslations) — voir apps/web/README.md.',
      attribute:
        'Texte en dur dans l’attribut « {{name}} » : « {{text}} ». Passez par le catalogue de messages — voir apps/web/README.md.',
    },
  },

  create(context) {
    return {
      JSXText(node) {
        const text = node.value.trim();

        if (text === '' || !isDisplayText(text)) {
          return;
        }

        context.report({ node, messageId: 'literal', data: { text } });
      },

      JSXExpressionContainer(node) {
        // Seuls les enfants comptent : un littéral passé en attribut est traité
        // par `JSXAttribute`, avec le nom de l'attribut dans le message.
        if (node.parent?.type !== 'JSXElement' && node.parent?.type !== 'JSXFragment') {
          return;
        }

        const text = stringLiteral(node.expression);

        if (text === null || !isDisplayText(text)) {
          return;
        }

        context.report({ node, messageId: 'literal', data: { text: text.trim() } });
      },

      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;

        if (name === null || !TRANSLATABLE_ATTRIBUTES.has(name)) {
          return;
        }

        const value =
          node.value?.type === 'JSXExpressionContainer'
            ? stringLiteral(node.value.expression)
            : stringLiteral(node.value);

        if (value === null || !isDisplayText(value)) {
          return;
        }

        context.report({
          node,
          messageId: 'attribute',
          data: { name, text: value.trim() },
        });
      },
    };
  },
};

/** Le greffon, tel que `eslint.config.mjs` l'enregistre. */
export const spaI18nPlugin = {
  meta: { name: 'spa-i18n', version: '1.0.0' },
  rules: { 'no-literal-jsx-text': noLiteralJsxText },
};

export default spaI18nPlugin;
