/*
 * Vitrine du salon — ce que seule la feuille de style tient
 * =============================================================================
 *
 * Issue #1046. L'audit de conception `d20260918-1` relève trois écarts de mise
 * en page que `styles/components/salon.css` est seul à corriger, et dont aucun
 * test de rendu ne signalerait la disparition : jsdom ne peint rien, et
 * `salon-vitrine-identite.test.tsx` — qui éprouve la structure, les libellés et
 * les destinations — resterait vert si la barre de réservation redevenait
 * statique ou si les panneaux de rubriques cessaient de se refermer.
 *
 * Même partage que `booking-service-cards.test.mjs`, dont cette suite reprend le
 * raisonnement, et la barre dont elle reprend l'ancrage.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #1046.
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

const salon = stripComments(readStyleSheet(styleSheetPath('components/salon.css')));
const nominal = withoutMediaQueries(salon);

/** La barre de réservation du pouce, et le panneau d'une rubrique. */
const BOOKBAR = 'spa-salon-bookbar';
const PANEL = 'spa-salon__panel';
const SERVICE = 'spa-salon-service';

describe('La barre de réservation ne quitte jamais l’écran (BM-VITRINE-04)', () => {
  const rule = rulesFor(nominal, `.${BOOKBAR}`).join(' ');

  it('est collée au bas de la fenêtre tant que la page déborde', () => {
    assert.notEqual(rule, '', `Aucune règle ne vise \`.${BOOKBAR}\`.`);

    assert.equal(
      declaration(rule, 'position'),
      'sticky',
      'La barre doit rester collée au bas de l’écran : c’est tout l’objet de ' +
        'BM-VITRINE-04, et un `position: static` la ferait disparaître au ' +
        'premier défilement — le constat exact de l’audit.',
    );
    assert.equal(declaration(rule, 'inset-block-end'), '0');
  });

  it('s’efface au-delà de 48 rem, où l’en-tête du gabarit porte déjà le bouton', () => {
    // Le palier est lu dans la feuille **entière** : c'est de lui qu'on parle.
    const large = rulesFor(salon, `.${BOOKBAR}`).some(
      (body) => declaration(body, 'display') === 'none',
    );

    assert.ok(
      large,
      'Sans ce palier, deux appels à l’action collants se disputeraient ' +
        'l’attention sur un écran large — l’en-tête du salon en porte déjà un (#1045).',
    );
  });
});

describe('Une rubrique fermée l’est vraiment (#1046)', () => {
  it('reprend `display: none` sur le panneau masqué', () => {
    // `[hidden] { display: none }` vient de la feuille de l'agent utilisateur et
    // pèse moins qu'une classe : sans cette règle-ci, toutes les rubriques
    // restent affichées à la fois, et les onglets ne commandent plus rien. Le
    // défaut est invisible en test de rendu — `getByRole` lit l'attribut, pas la
    // cascade.
    const hidden = rulesFor(nominal, `.${PANEL}[hidden]`).join(' ');

    assert.notEqual(hidden, '', `Aucune règle ne vise \`.${PANEL}[hidden]\`.`);
    assert.equal(declaration(hidden, 'display'), 'none');
  });
});

describe('Une prestation est une ligne, pas une carte (BM-SERVICE-01)', () => {
  it('borne la description à deux lignes plutôt que de laisser filer la ligne', () => {
    // BM-SERVICE-04 : « une longue description allonge-t-elle la ligne au point
    // de repousser les suivantes ? » — la réponse tient dans cette borne.
    const rule = rulesFor(nominal, `.${SERVICE}__description`).join(' ');

    assert.notEqual(rule, '', `Aucune règle ne vise \`.${SERVICE}__description\`.`);
    assert.equal(declaration(rule, '-webkit-line-clamp'), '2');
    assert.equal(declaration(rule, 'overflow'), 'hidden');
  });

  it('range le prix et l’action à l’opposé du nom', () => {
    const rule = rulesFor(nominal, `.${SERVICE}`).join(' ');

    assert.notEqual(rule, '', `Aucune règle ne vise \`.${SERVICE}\`.`);
    assert.equal(declaration(rule, 'justify-content'), 'space-between');
  });

  it('ne remet pas de grille de cartes là où l’audit en a retiré une', () => {
    // « Une grille qui laisse la moitié droite de l'écran vide à 1280 px » :
    // c'est le constat, et une liste en colonne est ce qui le corrige.
    const rule = rulesFor(nominal, '.spa-salon__services').join(' ');

    assert.notEqual(rule, '', 'Aucune règle ne vise `.spa-salon__services`.');
    assert.equal(declaration(rule, 'display'), 'flex');
    assert.equal(declaration(rule, 'flex-direction'), 'column');
  });
});

describe('Les informations pratiques tiennent la colonne latérale (BM-VITRINE-04)', () => {
  it('sont collantes au-delà de 64 rem, et seulement là', () => {
    const base = rulesFor(nominal, '.spa-salon__aside').join(' ');

    assert.equal(
      declaration(base, 'position'),
      null,
      'Au pouce, les horaires et l’adresse se lisent à leur place, sous le ' +
        'catalogue : une colonne collante y mangerait la hauteur de l’écran.',
    );

    const sticky = rulesFor(salon, '.spa-salon__aside').some(
      (body) => declaration(body, 'position') === 'sticky',
    );

    assert.ok(sticky, 'Aucun palier ne rend la colonne latérale collante.');
  });
});
