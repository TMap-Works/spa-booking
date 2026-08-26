/*
 * Intégrité du système de jetons
 * =============================================================================
 *
 * Le contrat annoncé en tête de `tokens.css` — deux couches, aucune couleur
 * littérale hors du fichier de jetons — n'a de valeur que s'il est vérifié.
 * Sans cette suite, il ne serait qu'un commentaire, et la première couleur
 * codée en dur dans un composant casserait silencieusement la personnalisation
 * par tenant : le salon substitue sa rampe, et cette couleur-là ne bouge pas.
 *
 * Exécution : `node --test apps/web/tests/`
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  listStyleSheets,
  readStyleSheet,
  readTokenDeclarations,
  relativeName,
  resolveToken,
  stripComments,
  tokensFile,
} from './support/tokens.mjs';

const declarations = readTokenDeclarations();
const sheets = listStyleSheets();

/** Mots-clés qui ressemblent à une couleur mais n'en fixent aucune. */
const COLOR_KEYWORDS_ALLOWED = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
]);

/** Couleurs nommées CSS les plus susceptibles d'être écrites par réflexe. */
const NAMED_COLORS =
  /\b(?:white|black|red|green|blue|yellow|orange|purple|pink|brown|grey|gray|silver|gold|teal|cyan|magenta|navy|olive|maroon|lime|aqua|fuchsia|beige|ivory|tan|coral|salmon|khaki|indigo|violet|crimson|tomato|orchid|plum|wheat|azure|linen|snow|mintcream|seashell)\b/;

/** Fonctions de couleur CSS — toutes interdites hors de `tokens.css`. */
const COLOR_FUNCTIONS = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/;

/** Littéral hexadécimal. */
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;

describe('Deux couches, et une seule qui porte des littéraux', () => {
  it('chaque jeton sémantique délègue à une primitive', () => {
    const semantic = [...declarations.keys()].filter((name) =>
      name.startsWith('--spa-color-'),
    );

    assert.ok(semantic.length > 0, 'aucun jeton sémantique de couleur trouvé.');

    for (const name of semantic) {
      const raw = declarations.get(name);
      assert.match(
        raw,
        /^var\(\s*--spa-palette-[\w-]+\s*\)$/,
        `${name} vaut « ${raw} » : un jeton sémantique doit toujours pointer un ` +
          `var(--spa-palette-*), jamais une couleur littérale. C'est ce qui permet ` +
          `à un salon de substituer sa rampe sans toucher aux rôles.`,
      );
    }
  });

  it('chaque primitive se résout en une valeur littérale', () => {
    const primitives = [...declarations.keys()].filter((name) =>
      name.startsWith('--spa-palette-'),
    );

    for (const name of primitives) {
      const value = resolveToken(declarations, name);
      assert.doesNotMatch(
        value,
        /var\(/,
        `${name} vaut « ${value} » : une primitive est une valeur littérale, ` +
          `pas une indirection.`,
      );
    }
  });

  it('aucune couleur littérale hors de tokens.css', () => {
    for (const sheet of sheets) {
      if (sheet === tokensFile) continue;

      const name = relativeName(sheet);
      const css = stripComments(readStyleSheet(sheet));

      // Balayage sur le texte entier, et non ligne à ligne : une règle écrite
      // d'un seul tenant (`.x { color: #f00; }`) échapperait à une analyse qui
      // exige la déclaration en début de ligne. Le terminateur accepte `}` parce
      // que CSS autorise l'omission du point-virgule final.
      for (const match of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+)[;}]/g)) {
        // On n'inspecte que la valeur : un sélecteur peut légitimement contenir
        // « --danger » ou « --success ».
        const value = match[2].trim();
        if (COLOR_KEYWORDS_ALLOWED.has(value.toLowerCase())) continue;

        const line = css.slice(0, match.index).split('\n').length;
        const where = `${name}:${line} — « ${match[0].trim()} »`;
        assert.doesNotMatch(
          value,
          HEX_COLOR,
          `couleur hexadécimale littérale dans ${where}. Passer par un jeton sémantique.`,
        );
        assert.doesNotMatch(
          value,
          COLOR_FUNCTIONS,
          `fonction de couleur littérale dans ${where}. Passer par un jeton sémantique.`,
        );
        assert.doesNotMatch(
          value,
          NAMED_COLORS,
          `couleur nommée littérale dans ${where}. Passer par un jeton sémantique.`,
        );
      }
    }
  });
});

describe('Cohérence des références', () => {
  it('tout var(--spa-*) employé par un composant est déclaré', () => {
    const used = new Map();

    for (const sheet of sheets) {
      if (sheet === tokensFile) continue;
      const css = stripComments(readStyleSheet(sheet));
      for (const match of css.matchAll(/var\(\s*(--spa-[\w-]+)/g)) {
        if (!used.has(match[1])) used.set(match[1], relativeName(sheet));
      }
    }

    assert.ok(used.size > 0, 'aucune référence de jeton trouvée dans les composants.');

    for (const [token, sheet] of used) {
      assert.ok(
        declarations.has(token),
        `${sheet} emploie ${token}, qui n'est déclaré nulle part dans tokens.css.`,
      );
    }
  });

  it('les composants n’emploient jamais une primitive directement', () => {
    // Une primitive employée dans un composant court-circuite la couche
    // sémantique : le rôle devient invisible, et la substitution de rampe par un
    // tenant ne l'atteint plus.
    for (const sheet of sheets) {
      if (sheet === tokensFile) continue;
      const css = stripComments(readStyleSheet(sheet));
      const direct = css.match(/var\(\s*--spa-palette-[\w-]+/);
      assert.equal(
        direct,
        null,
        `${relativeName(sheet)} emploie la primitive ${direct?.[0]} directement. ` +
          `Passer par un jeton sémantique --spa-color-*.`,
      );
    }
  });

  it('index.css importe chaque feuille du système, une seule fois', () => {
    // Le point d'entrée liste ses imports à la main pour garder un ordre de
    // cascade lisible ; le prix de ce choix est qu'un fichier ajouté peut être
    // oublié. Ce test est ce qui rend ce prix acceptable.
    const indexPath = sheets.find((sheet) => relativeName(sheet) === 'index.css');
    assert.ok(indexPath, 'styles/index.css est introuvable.');

    const imported = [
      ...stripComments(readStyleSheet(indexPath)).matchAll(
        /@import\s+['"]\.\/([^'"]+)['"]/g,
      ),
    ].map((match) => match[1]);

    const expected = sheets
      .map(relativeName)
      .filter((name) => name !== 'index.css');

    assert.deepEqual(
      [...imported].sort(),
      [...expected].sort(),
      'les imports de index.css ne correspondent pas aux feuilles présentes ' +
        'dans styles/ (fichier ajouté sans import, ou import orphelin).',
    );
    assert.equal(
      new Set(imported).size,
      imported.length,
      'index.css importe deux fois la même feuille.',
    );
  });

  it('déclare les jetons dans l’ordre annoncé : primitives puis sémantiques', () => {
    const names = [...declarations.keys()];
    const lastPrimitive = names.findLastIndex((name) =>
      name.startsWith('--spa-palette-'),
    );
    const firstSemantic = names.findIndex((name) => name.startsWith('--spa-color-'));

    assert.ok(
      firstSemantic > lastPrimitive,
      'une primitive est déclarée après le premier jeton sémantique : ' +
        'la lecture en deux couches de tokens.css ne tient plus.',
    );
  });
});
