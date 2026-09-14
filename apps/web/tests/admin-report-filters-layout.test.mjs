/*
 * Indicateurs d'activité — l'alignement de la barre de filtres
 * =============================================================================
 *
 * Issue #628. La campagne de QA a relevé, sur `/…/admin/reporting`, une barre de
 * filtres en escalier : le sélecteur « Filtrer » posé 26 px au-dessus de celui
 * de « Période », et, en période personnalisée, quatre champs répartis sur deux
 * hauteurs séparées de 47 px.
 *
 * Ces deux chiffres ne sont pas des accidents de rendu, ce sont des sommes de
 * jetons. Sous `align-items: flex-end`, tout ce qui pend sous un contrôle le
 * remonte d'autant : une ligne de phrase d'aide vaut
 * `--spa-font-size-sm × --spa-line-height-normal` = 21,7 px, plus la gouttière
 * `--spa-space-1` du champ, soit 25,7 px — les 26 px relevés. Deux lignes
 * d'aide, celles que « Au (inclus) » et « Filtrer » enroulent en période
 * personnalisée, en font 47,4 px — les 47 px relevés.
 *
 * Le piège, et la raison d'être de cette suite : `flex-end` **paraît** être le
 * bon choix, et l'était tant qu'aucun champ de la barre ne portait d'aide. Le
 * commentaire d'origine le défendait même explicitement. Un contributeur qui
 * ajoute une phrase d'aide à un cinquième champ, ou qui rétablit l'alignement
 * bas « pour caler les contrôles », rouvre le bug à l'identique — et rien ne
 * l'en avertit : la page compile, la barre s'affiche.
 *
 * Cette suite ne mesure pas un rendu : elle tient les deux invariants dont le
 * rendu découle — la barre s'aligne par le haut, et le bouton, seul contrôle
 * sans étiquette, se voit rendre la ligne d'étiquette qui lui manque. La preuve
 * visuelle, elle, est au navigateur : phase de recette de #628, `boxes=true` en
 * période simple et en période personnalisée.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStyleSheet, stripComments, styleSheetPath } from './support/tokens.mjs';

/** La feuille des indicateurs d'activité, commentaires neutralisés. */
const reporting = stripComments(readStyleSheet(styleSheetPath('admin/reporting.css')));

/**
 * Les blocs de déclarations des règles dont la liste de sélecteurs contient
 * **exactement** `selector`.
 *
 * L'égalité et non la sous-chaîne, pour la même raison qu'en #615 : chercher
 * `.spa-admin-report-filters` par sous-chaîne attraperait aussi la règle du
 * bouton, et un `align-items` déplacé de l'une à l'autre laisserait l'assertion
 * verte alors que la barre aurait changé de comportement.
 */
function rulesFor(selector) {
  const wanted = selector.trim().replace(/\s+/g, ' ');
  const found = [];
  for (const [, prelude, body] of reporting.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
    if (selectors.includes(wanted)) found.push(body);
  }
  return found;
}

describe('La barre de filtres aligne ses libellés en haut', () => {
  it('déclare un alignement de la barre', () => {
    const rules = rulesFor('.spa-admin-report-filters');

    assert.notDeepEqual(rules, [], 'aucune règle ne vise `.spa-admin-report-filters`.');
    assert.match(
      rules.join(' '),
      /align-items\s*:/,
      '`.spa-admin-report-filters` ne déclare plus d’alignement : un conteneur ' +
        'flex s’aligne alors par étirement, et les champs porteurs d’une phrase ' +
        'd’aide reprennent une hauteur propre (#628).',
    );
  });

  it('s’aligne par le haut, jamais par le bas ni sur la ligne de base', () => {
    // Le cœur du correctif. `flex-end` remonte chaque champ de la hauteur de ce
    // qui pend sous son contrôle ; `baseline` aligne les premières lignes de
    // texte, c'est-à-dire les étiquettes, et laisse les contrôles se décaler
    // dès que deux étiquettes n'ont pas la même hauteur.
    for (const rule of rulesFor('.spa-admin-report-filters')) {
      for (const [, value] of rule.matchAll(/align-items\s*:\s*([^;]+)/g)) {
        assert.match(
          value.trim(),
          /^flex-start$/,
          `\`.spa-admin-report-filters\` s’aligne en « ${value.trim()} ». Seul ` +
            '`flex-start` fait tomber le bord haut de chaque contrôle au même ' +
            'endroit : les quatre étiquettes de la barre partagent la même ' +
            'typographie, alors que ce qui pend sous les contrôles — phrase ' +
            'd’aide, message de refus — ne fait jamais la même hauteur. ' +
            '`flex-end` rouvre l’escalier de 26 px en période simple et de 47 px ' +
            'en période personnalisée (#628), et `end` remonte en avertissement ' +
            'de compilation chez autoprefixer.',
        );
      }
    }
  });
});

describe('Le bouton « Afficher » se pose sur la rangée des champs', () => {
  const button = rulesFor('.spa-admin-report-filters > button');

  it('vise bien le bouton de la barre', () => {
    assert.notDeepEqual(
      button,
      [],
      'aucune règle ne vise `.spa-admin-report-filters > button`.',
    );
  });

  it('rattrape la ligne d’étiquette qu’il n’a pas', () => {
    // Sans étiquette au-dessus de lui, un bouton aligné par le haut se pose à la
    // hauteur des **mots** « Période » et « Filtrer », pas à celle des champs :
    // l'escalier change de sens au lieu de disparaître.
    assert.match(
      button.join(' '),
      /margin-block-start\s*:\s*calc\([^)]*\)/,
      '`.spa-admin-report-filters > button` n’est plus décalé : aligné par le ' +
        'haut sans étiquette, il remonte à la hauteur des libellés et se ' +
        'désaligne des champs qu’il commande (#628).',
    );
  });

  it('écrit ce décalage avec les jetons qui composent une étiquette', () => {
    // Un `1.6rem` posé à la main tiendrait aujourd'hui et mentirait au premier
    // jeton typographique qui bouge — le bouton dériverait alors seul, sans
    // qu'aucun test ne s'en aperçoive.
    const offset = button.join(' ');

    for (const token of ['--spa-font-size-sm', '--spa-line-height-normal', '--spa-space-1']) {
      assert.match(
        offset,
        new RegExp(`var\\(\\s*${token}\\s*\\)`),
        `le décalage du bouton n’emploie plus ${token}. Il vaut une ligne ` +
          'd’étiquette — corps `--spa-font-size-sm`, hauteur de ligne ' +
          '`--spa-line-height-normal` — plus la gouttière `--spa-space-1` que ' +
          '`.spa-field` et `.spa-select` posent entre étiquette et contrôle. ' +
          'Exprimé autrement, il cesse de suivre les jetons qu’il rattrape.',
      );
    }
  });
});
