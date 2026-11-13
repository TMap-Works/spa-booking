/*
 * Tunnel de réservation — l'entrée des listes filtrées (P2-03, #1458)
 * =============================================================================
 *
 * Les horaires et les praticiens qui apparaissent après un filtre entrent en
 * fondu. Deux choses ne se lisent que dans la feuille de styles, et cette
 * suite les tient :
 *
 * - l'animation n'existe **que** sous `prefers-reduced-motion: no-preference` ;
 * - ses durées viennent des jetons de mouvement, pas d'une valeur en dur.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readStyleSheet, rulesFor, stripComments, styleSheetPath, withoutMediaQueries } from './support/tokens.mjs';

const slotGrid = stripComments(readStyleSheet(styleSheetPath('components/slot-grid.css')));

describe('Entrée des listes filtrées (#1458)', () => {
  it("n'anime rien hors de `prefers-reduced-motion: no-preference`", () => {
    const outside = withoutMediaQueries(slotGrid);
    for (const selector of ['.spa-slot-grid__cell', '.spa-booking__staff-option']) {
      const body = rulesFor(outside, selector).join(' ');
      assert.doesNotMatch(body, /animation/, `${selector} s'anime aussi quand on demande moins de mouvement.`);
    }
    const block = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*)\}\s*$/.exec(slotGrid);
    assert.ok(block, "Le bloc `prefers-reduced-motion: no-preference` de l'entrée des listes a disparu.");
    assert.match(block[1], /spa-list-enter/);
  });

  it('prend sa durée et sa courbe dans les jetons', () => {
    const block = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*)\}\s*$/.exec(slotGrid);
    assert.match(block?.[1] ?? '', /animation:\s*spa-list-enter\s+var\(--spa-duration-normal\)\s+var\(--spa-easing-standard\)/);
  });
});
