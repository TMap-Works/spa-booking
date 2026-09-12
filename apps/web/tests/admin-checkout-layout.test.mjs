/*
 * Encaissement — la mise en page du ticket et du panneau de paiement
 * =============================================================================
 *
 * Issue #615. La campagne de QA a relevé, sur `/…/admin/encaissement`, le
 * récapitulatif du ticket et le choix du moyen de paiement restés côte à côte
 * dans une zone bien trop étroite : la colonne TOTAL sortait du cadre, l'en-tête
 * « PRATICIEN » était tranché en « PRATICI », et « 85,00 € » se lisait « 85,0 ».
 *
 * Le piège est qu'un palier **existait déjà** et paraissait suffisant — 48 rem,
 * celui de la coquille. Il ne l'était pas, parce qu'au-dessus de 48 rem le rail
 * garde ses 15 rem : la zone de contenu ne vaut pas la fenêtre, et c'est elle
 * que l'écran doit mesurer. Un contributeur qui aligne « par cohérence » ce
 * palier sur celui de `shell.css` rouvrirait le bug à l'identique, sans qu'aucun
 * test ne s'en aperçoive — le rendu compile, les pages s'affichent.
 *
 * Cette suite est ce qui l'en empêche. Elle ne mesure pas un rendu : elle tient
 * les deux invariants dont le rendu découle, et elle nomme la raison de chacun
 * dans son message d'échec. La preuve visuelle, elle, est au navigateur — phase
 * de recette de #615, captures à 320, 768, 790, 970 et 1280 px.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStyleSheet, stripComments, styleSheetPath } from './support/tokens.mjs';

/** La feuille de l'écran d'encaissement, commentaires neutralisés. */
const checkout = stripComments(readStyleSheet(styleSheetPath('admin/checkout.css')));

/** Le palier de la coquille, sous lequel le rail se replie en bandeau. */
const SHELL_BREAKPOINT_REM = 48;

/**
 * Largeur du rail plus les gouttières de la zone de contenu, en rem.
 *
 * C'est ce que la fenêtre perd avant d'atteindre `.spa-admin-checkout`, tant que
 * le rail n'est pas replié. Mesuré au navigateur : 744 px de grille pour 1024 px
 * de fenêtre.
 */
const SHELL_CHROME_REM = 17.5;

/**
 * Ce que la paire réclame pour tenir, en rem de grille.
 *
 * 19,5 de ticket, 22 de panneau de paiement, 1 de gouttière. Le premier terme
 * n'est pas un arrondi de confort : c'est la mesure du plus mauvais cas encore
 * rendu côte à côte — 961 px de fenêtre, le premier pixel au-dessus du palier —
 * où le récapitulatif garde ses trois colonnes, en enroulant le seul nom de la
 * prestation sur deux lignes. En deçà, la colonne TOTAL commence à sortir.
 */
const PAIR_MIN_CONTENT_REM = 42.5;

/**
 * Les paliers `max-width` déclarés par la feuille, en rem.
 *
 * Les requêtes de média se lisent au texte plutôt qu'en montant un moteur de
 * rendu : ce qu'il y a à vérifier ici est une valeur écrite, pas un calcul de
 * mise en page. `px` est accepté et converti — un contributeur peut très bien
 * écrire le palier en pixels, et le test doit alors juger la valeur, pas la
 * syntaxe.
 */
function stackingBreakpointsRem() {
  const found = [];
  for (const match of checkout.matchAll(/@media[^{]*\(\s*max-width\s*:\s*([\d.]+)(rem|px)\s*\)[^{]*\{([\s\S]*?)\n\}/g)) {
    const [, amount, unit, body] = match;
    // Seuls comptent les paliers qui empilent réellement la grille. Un palier
    // qui ne ferait que resserrer une gouttière n'a rien à prouver ici.
    if (!/\.spa-admin-checkout\s*\{[^}]*grid-template-columns\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/.test(body)) {
      continue;
    }
    found.push(unit === 'px' ? Number(amount) / 16 : Number(amount));
  }
  return found;
}

describe('Le ticket et le moyen de paiement s’empilent avant d’être écrasés', () => {
  it('déclare un palier d’empilement pour la grille de l’encaissement', () => {
    assert.notDeepEqual(
      stackingBreakpointsRem(),
      [],
      'admin/checkout.css ne fait plus repasser `.spa-admin-checkout` en une ' +
        'colonne : sous 60 rem les deux colonnes se partagent une zone où le ' +
        'récapitulatif n’a plus la place de ses trois colonnes (#615).',
    );
  });

  it('empile au-dessus du palier de la coquille, et non au même endroit', () => {
    // Le cœur du correctif de #615, et la seule chose qu'une relecture humaine
    // rate : 48 rem paraît le bon chiffre parce que c'est celui de `shell.css`.
    for (const palier of stackingBreakpointsRem()) {
      assert.ok(
        palier > SHELL_BREAKPOINT_REM,
        `admin/checkout.css empile à ${palier} rem, soit au palier de la ` +
          `coquille (${SHELL_BREAKPOINT_REM} rem) ou en dessous. Au-dessus de ce ` +
          `palier le rail garde ses 15 rem : la fenêtre mesure ${palier} rem mais ` +
          `la grille n’en reçoit que ${palier - SHELL_CHROME_REM}, dont 22 pour le ` +
          `panneau de paiement. C’est exactement l’état relevé par la QA — colonne ` +
          `TOTAL hors cadre et montant coupé (#615).`,
      );
    }
  });

  it('empile assez tôt pour que le récapitulatif garde ses trois colonnes', () => {
    for (const palier of stackingBreakpointsRem()) {
      assert.ok(
        palier - SHELL_CHROME_REM >= PAIR_MIN_CONTENT_REM,
        `admin/checkout.css empile à ${palier} rem de fenêtre, ce qui laisse ` +
          `${palier - SHELL_CHROME_REM} rem à la grille là où la paire en réclame ` +
          `${PAIR_MIN_CONTENT_REM} — 19,5 pour les trois colonnes du ` +
          `récapitulatif, 22 pour le panneau de paiement, 1 de gouttière.`,
      );
    }
  });
});

describe('Le montant à encaisser reste lisible d’un coup d’œil', () => {
  /**
   * Les blocs de déclarations des règles dont la liste de sélecteurs contient
   * **exactement** `selector`.
   *
   * L'égalité est le point important, et non la sous-chaîne : chercher
   * `.spa-admin-checkout__total-value` par sous-chaîne attrape aussi
   * `.spa-admin-checkout__total-row--grand .spa-admin-checkout__total-value`,
   * si bien qu'une déclaration déplacée de la règle de base vers celle du grand
   * total laisserait l'assertion verte alors que les lignes ordinaires —
   * horaire, moyen de paiement — auraient perdu le comportement vérifié.
   *
   * Le corps est borné à `[^{}]*` : une règle imbriquée dans une requête de
   * média est alors lue comme une règle à part entière, et le prélude
   * `@media (…)` ne peut pas passer pour une liste de sélecteurs.
   */
  function rulesFor(selector) {
    const wanted = selector.trim().replace(/\s+/g, ' ');
    const found = [];
    for (const [, prelude, body] of checkout.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
      if (selectors.includes(wanted)) found.push(body);
    }
    return found;
  }

  it('laisse la ligne du total s’enrouler plutôt que de se comprimer', () => {
    const rules = rulesFor('.spa-admin-checkout__total-row').join(' ');
    assert.match(
      rules,
      /flex-wrap\s*:\s*wrap/,
      '`.spa-admin-checkout__total-row` ne s’enroule plus : dans une colonne ' +
        'étroite, « À encaisser » et son montant se rognent l’un l’autre (#615).',
    );
  });

  it('tient la valeur au bord droit, y compris sur une ligne enroulée', () => {
    const rules = rulesFor('.spa-admin-checkout__total-value').join(' ');
    assert.match(
      rules,
      /margin-inline-start\s*:\s*auto/,
      '`.spa-admin-checkout__total-value` a perdu sa marge automatique : seule ' +
        'sur sa ligne, la valeur repasserait à gauche et la colonne des montants ' +
        'perdrait le bord droit qui la rend comparable d’un coup d’œil.',
    );
  });

  it('interdit au montant à encaisser de se couper en deux', () => {
    // C'est le seul chiffre que l'opératrice annonce à voix haute. Les autres
    // valeurs du bloc — un horaire, un moyen de paiement — peuvent s'enrouler.
    const grand = rulesFor(
      '.spa-admin-checkout__total-row--grand .spa-admin-checkout__total-value',
    );

    assert.notDeepEqual(grand, [], 'aucune règle ne vise la valeur du total à encaisser.');
    assert.match(
      grand.join(' '),
      /white-space\s*:\s*nowrap/,
      'le montant à encaisser peut de nouveau se couper : « 85,00 € » rendu ' +
        '« 85,00 » puis « € » à la ligne suivante est un prix qu’on lit de ' +
        'travers devant la cliente (#615).',
    );
  });
});
