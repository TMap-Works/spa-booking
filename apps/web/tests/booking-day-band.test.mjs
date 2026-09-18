/*
 * Tunnel de réservation — la bande de jours de l'étape « créneau »
 * =============================================================================
 *
 * Issue #1049, audit de conception `d20260918-1`. À 360 px, l'étape mettait la
 * grille d'un mois entier — trente-cinq cases de 40 px, cinq à six lignes —
 * entre le titre de la prestation et le premier horaire : la grille des créneaux
 * passait sous la ligne de flottaison. `BM-CRENEAU-01` décrit l'usage du marché,
 * observé chez cinq plateformes : *« une rangée de jours défilante […] ; le
 * calendrier du mois complet s'ouvre à la demande ; sous la rangée, les seuls
 * horaires du jour sélectionné »*.
 *
 * Ce que le rendu exige, et qui ne se lit que dans la feuille de styles :
 *
 * - la rangée **défile horizontalement**, sans quoi ses quatorze blocs se
 *   compriment pour tenir dans la largeur et la bande cesse d'en être une ;
 * - la grille d'horaires compte **trois colonnes** à 360 px et **six** au
 *   bureau, ce qui est le second constat de l'audit — *« à 1 280 px, la vue
 *   reste la même »* ;
 * - le sélecteur ne se **dédouble plus en deux colonnes** au bureau : c'est
 *   précisément la mise en page qui laissait les horaires dans une colonne
 *   étroite à droite du calendrier.
 *
 * Le piège que cette suite tient est celui de `booking-calendar-width.test.mjs` :
 * rien ne signale la disparition d'une règle de mise en page. L'écran
 * compilerait, s'afficherait, passerait la recette — et rouvrirait l'écart à
 * l'identique.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #1049.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  declaration,
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const calendar = stripComments(readStyleSheet(styleSheetPath('components/calendar.css')));
const slotGrid = stripComments(readStyleSheet(styleSheetPath('components/slot-grid.css')));

describe('La rangée de jours défile plutôt que de se comprimer (#1049)', () => {
  it('laisse la rangée déborder et le doigt la faire glisser', () => {
    const grid = rulesFor(calendar, '.spa-date-band__grid').join(' ');

    assert.equal(
      declaration(grid, 'overflow-x'),
      'auto',
      '`.spa-date-band__grid` ne défile plus : ses quatorze journées se ' +
        'compriment alors pour tenir dans la largeur, et la rangée cesse d’être ' +
        'balayable (`BM-CRENEAU-01`).',
    );
  });

  it('donne à la rangée sa largeur naturelle, et non celle du conteneur', () => {
    const row = rulesFor(calendar, '.spa-date-band__row').join(' ');

    assert.equal(
      declaration(row, 'inline-size'),
      'max-content',
      '`.spa-date-band__row` retombe à la largeur du conteneur : un `overflow-x` ' +
        'sans contenu plus large ne défile pas, et les blocs se tassent.',
    );
  });

  it('tient la cible tactile de 44 px sur chaque journée', () => {
    // WCAG 2.5.8, et la même règle que les cases du calendrier et les créneaux.
    const cell = rulesFor(calendar, '.spa-date-band__cell .spa-button').join(' ');

    assert.match(
      declaration(cell, 'min-block-size') ?? '',
      /--spa-target-min-size/,
      'Une journée de la bande ne garantit plus la cible minimale du bout du doigt.',
    );
  });

  it('distingue une journée fermée autrement que par la couleur', () => {
    // `BM-CRENEAU-04` et #742 : les cinq plateformes observées grisent **ou**
    // barrent les jours impossibles ; le mot est par ailleurs dans le nom
    // accessible (WCAG 1.4.1).
    const closed = rulesFor(
      calendar,
      ".spa-date-band__cell[data-state='ferme'] .spa-date-block__day",
    ).join(' ');

    assert.equal(
      declaration(closed, 'text-decoration'),
      'line-through',
      'Une journée de fermeture ne se distingue plus que par son atténuation : ' +
        'elle redevient indiscernable d’une journée complète avant le clic ' +
        '(`BM-CRENEAU-04`).',
    );
  });
});

describe('Les horaires occupent la largeur rendue par le calendrier (#1049)', () => {
  it('range les créneaux sur trois colonnes à 360 px', () => {
    const base = rulesFor(withoutMediaQueries(slotGrid), '.spa-slot-grid__row').join(' ');

    assert.match(
      declaration(base, 'grid-template-columns') ?? '',
      /repeat\(3,/,
      'La grille d’horaires ne tient plus trois colonnes sur un téléphone : sa ' +
        'trame dépend de nouveau de la longueur du texte d’un créneau, et la ' +
        'promesse « au moins une rangée visible sans défiler » avec elle.',
    );
  });

  it('les étale sur six colonnes au bureau', () => {
    assert.match(
      slotGrid,
      /@media[^{]+min-width[^{]+48rem[^{]*\{\s*\.spa-slot-grid__row\s*\{[^}]*repeat\(6,/,
      'La grille d’horaires ne s’élargit plus à 1 280 px : c’est le second ' +
        'constat de l’audit `d20260918-1` — « la vue reste la même ».',
    );
  });

  it('ne rend plus le sélecteur en deux colonnes', () => {
    // C'est la mise en page qui laissait les horaires dans une colonne étroite à
    // droite du calendrier, lequel vit désormais dans un panneau.
    assert.doesNotMatch(
      calendar,
      /\.spa-slot-picker\s*\{[^}]*grid-template-columns/,
      '`.spa-slot-picker` se redédouble en deux colonnes : la bande cesse ' +
        'd’occuper la largeur de l’étape, et les horaires se resserrent à droite.',
    );
  });
});
