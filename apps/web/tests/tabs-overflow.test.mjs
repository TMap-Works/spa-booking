/*
 * Onglets — la rangée rogne ce qu'elle laisse dépasser
 * =============================================================================
 *
 * Issue #1154. La campagne de QA `20260922-complet` relève qu'à 360 px la
 * vitrine mesure 434 px de document et l'étape 1 du tunnel 460 px : la page
 * entière défile latéralement, contenu décalé et bande blanche à droite. Les
 * écrans **sans** rangée d'onglets — historique, étapes 2 à 4, connexion —
 * restaient à 360 px.
 *
 * La cause est une règle de rognage que l'on oublie facilement : un conteneur de
 * défilement ne rogne pas un descendant absolument positionné dont le bloc
 * conteneur lui est extérieur. Les onglets logent des textes réservés aux
 * lecteurs d'écran — le « · » qui sépare le libellé de son effectif, la phrase
 * de la marque (`components/ui/tabs.tsx`) —, et `.spa-visually-hidden`
 * (`base.css`) est une boîte en `position: absolute`. Sans référent positionné
 * sur la rangée, la leur remontait jusqu'au bloc conteneur initial et agrandissait
 * la zone défilable de la page, d'autant plus que la rangée est longue.
 *
 * Ce que cette suite tient, et rien d'autre : le **couple** de déclarations dont
 * dépend le rognage. `overflow-x: auto` sans référent positionné ne rogne rien
 * de ce qui est absolument positionné, et un référent positionné sans
 * `overflow-x: auto` ne rogne rien du tout : les deux se lisent donc ensemble ou
 * pas du tout. Aucun test de rendu ne les voit — jsdom ne peint pas, et la
 * structure des onglets (`ui-briques-client.test.tsx`) reste identique des deux
 * côtés du défaut.
 *
 * La preuve à 360 px, elle, est au navigateur : phase de recette de #1154.
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

/** La rangée d'onglets : `Tabs` la porte, `NavTabs` la porte sur sa liste. */
const RANGEE = ['.spa-tabs', '.spa-tabs__list'];

const tabs = withoutMediaQueries(
  stripComments(readStyleSheet(styleSheetPath('components/tabs.css'))),
);
const base = withoutMediaQueries(stripComments(readStyleSheet(styleSheetPath('base.css'))));

describe('La rangée d’onglets ne fait pas déborder la page (#1154)', () => {
  for (const selecteur of RANGEE) {
    it(`fait de \`${selecteur}\` un référent positionné`, () => {
      const regle = rulesFor(tabs, selecteur).join(' ');

      assert.notEqual(
        regle,
        '',
        `Plus aucune règle ne vise \`${selecteur}\` : la rangée d’onglets n’est ` +
          'plus mise en page, et le rognage qui la borne disparaît avec elle.',
      );

      assert.equal(
        declaration(regle, 'overflow-x'),
        'auto',
        `\`${selecteur}\` ne défile plus horizontalement : à 360 px la rangée passe ` +
          'à la ligne au lieu de se parcourir au pouce (`BM-SERVICE-02`, #1044).',
      );

      // Le bloc conteneur des boîtes absolument positionnées de la rangée. Sans
      // lui, le conteneur de défilement ne les rogne pas — c'est la règle même
      // du rognage —, elles se posent par rapport au bloc conteneur initial et
      // la **page** se met à défiler latéralement : 434 px de document pour une
      // fenêtre de 360 sur la vitrine, 460 px à l'étape 1 du tunnel (#1154).
      assert.equal(
        declaration(regle, 'position'),
        'relative',
        `\`${selecteur}\` n’est plus un référent positionné : les textes réservés ` +
          'aux lecteurs d’écran que portent les onglets — le « · » de l’effectif, ' +
          'la phrase de la marque — échappent au rognage de la rangée et font ' +
          'déborder la page à 360 px. C’est exactement l’écart de #1154.',
      );
    });
  }

  it('garde un texte de lecteur d’écran hors flux, et donc à rogner', () => {
    // La prémisse de ce qui précède : si `.spa-visually-hidden` cessait d'être
    // absolument positionné, le référent de la rangée deviendrait inutile — et
    // la règle ci-dessus se lirait comme une survivance. Le jour où cette
    // assertion tombe, c'est le commentaire de `tabs.css` qu'il faut relire.
    const masque = rulesFor(base, '.spa-visually-hidden').join(' ');

    assert.equal(
      declaration(masque, 'position'),
      'absolute',
      '`.spa-visually-hidden` n’est plus absolument positionné : `tabs.css` porte ' +
        'un référent positionné dont la raison d’être a disparu (#1154).',
    );
  });
});
