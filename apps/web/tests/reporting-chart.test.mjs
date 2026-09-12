/*
 * Le graphe d'indicateurs et la largeur de sa carte (issue #616)
 * =============================================================================
 *
 * Le tracé d'un graphique en colonnes mesure au moins 30 rem : en deçà, le texte
 * du SVG — écrit en unités du `viewBox`, donc mis à l'échelle avec lui — cesse
 * d'être lisible. Une carte plus étroite que ce plancher ne comprime donc pas le
 * tracé : elle le fait défiler. C'est la règle posée par #75, et elle tient.
 *
 * Ce que la campagne de QA a relevé n'est pas ce compromis, c'est son silence :
 * là où le navigateur peint ses barres de défilement en surimpression — macOS,
 * tablette, navigateur sans-tête —, rien n'annonçait que la période continuait à
 * droite, et l'axe paraissait s'arrêter cinq jours trop tôt. Le conteneur peint
 * donc lui-même son indice, en fond, sans JavaScript ni mesure.
 *
 * Ces trois invariants vivent dans une feuille de style : aucun test de rendu ne
 * les atteint, et une simplification bien intentionnée les emporterait sans
 * qu'aucune suite ne rougisse. Ils sont donc relus ici, comme `tokens.test.mjs`
 * et `admin-mockups.test.mjs` relisent les leurs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStyleSheet, stripComments, styleSheetPath } from './support/tokens.mjs';

const css = stripComments(readStyleSheet(styleSheetPath('admin/reporting.css')));

/** Le corps d'une règle, sélecteur exact — sans ses commentaires. */
function ruleBody(selector) {
  const match = new RegExp(`(^|\\})\\s*${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  );

  assert.ok(match, `styles/admin/reporting.css ne déclare plus « ${selector} ».`);

  return match[2];
}

describe('Le graphe déborde de sa carte sans déborder de la page', () => {
  it('confine le débordement au canevas, jamais au document', () => {
    // Sans cette ligne, un tracé plus large que la carte pousserait le document
    // entier au-delà de la fenêtre — le défaut que #612 a corrigé sur les
    // tableaux denses, à l'identique.
    assert.match(
      ruleBody('.spa-admin-chart__canvas'),
      /overflow-x:\s*auto/,
      'le canevas du graphe ne défile plus : son débordement irait à la page.',
    );
  });

  it('garde au tracé son plancher de lisibilité', () => {
    // Le descendre ferait tenir le graphe dans n'importe quelle carte, au prix
    // d'un axe écrit sous les 4 px. C'est un compromis, et il se décide — il ne
    // se perd pas dans une passe de nettoyage.
    assert.match(
      ruleBody('.spa-admin-chart__svg'),
      /min-inline-size:\s*30rem/,
      'le tracé n’a plus de largeur minimale : son axe se comprimera jusqu’à l’illisible.',
    );
  });

  it('garde l’anneau de focus du tracé dans le cadre qui le coupe', () => {
    // Le tracé est un arrêt de tabulation (#616) ; l'anneau global de
    // `base.css` est posé en dehors de la boîte, et le canevas coupe sur ses
    // quatre côtés. Sans décalage négatif, l'anneau tombe hors cadre et le
    // tabulateur atteint le graphe sans que rien ne le montre (WCAG 2.4.7).
    assert.match(
      ruleBody('.spa-admin-chart__svg:focus-visible'),
      /outline-offset:\s*calc\(\s*-1\s*\*\s*var\(--spa-focus-ring-width\)\s*\)/,
      'l’anneau de focus du tracé repasse en dehors de sa boîte : le conteneur de ' +
        'défilement le coupera, et l’arrêt de tabulation redeviendra invisible.',
    );
  });

  it('annonce qu’il reste quelque chose à lire, barre de défilement ou non', () => {
    const body = ruleBody('.spa-admin-chart__canvas');

    // Deux voiles collés au contenu, deux ombres collées au cadre : c'est
    // l'écart entre les deux qui découvre l'indice quand le tracé déborde, et
    // qui ne montre rien quand il tient. L'ordre compte autant que le nombre.
    assert.match(
      body,
      /background-attachment:\s*local,\s*local,\s*scroll,\s*scroll/,
      'l’indice de défilement du graphe a perdu son montage : sur un navigateur ' +
        'à barres en surimpression, plus rien ne dira que la période continue.',
    );
    assert.match(
      body,
      /background-image:[\s\S]*linear-gradient/,
      'le canevas ne peint plus d’indice de défilement.',
    );
  });
});
