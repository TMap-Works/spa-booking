/*
 * Le champ téléphone international tient dans une colonne de 360 px
 * =============================================================================
 *
 * Issue #825, huitième critère : « le composant tient à 360 px, sans
 * débordement ». jsdom ne met rien en page, et la suite Vitest du composant
 * (`unit/phone-field.test.tsx`) ne peut donc pas le voir. Ce qui se vérifie
 * ici, ce sont les trois déclarations dont dépend la tenue :
 *
 * 1. la boîte et le numéro acceptent de **rétrécir** (`min-inline-size: 0`) —
 *    sans quoi un `<input>`, dont la largeur minimale est celle de son
 *    attribut `size`, pousse la boîte hors de la colonne ;
 * 2. le bouton du pays **ne rétrécit pas** (`flex: 0 0 auto`) — c'est au
 *    numéro, qui défile dans son champ, de céder la place, pas au drapeau ;
 * 3. les cibles tactiles mesurent au moins le jeton `--spa-target-min-size`
 *    (44 px), dans le champ comme dans la liste des pays.
 *
 * Les règles sont lues **hors paliers** (`withoutMediaQueries`) : c'est la
 * règle de base qui sert à 360 px, et un palier ne doit pas faire passer la
 * suite à sa place.
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

const phone = withoutMediaQueries(stripComments(readStyleSheet(styleSheetPath('components/phone.css'))));

function single(selector) {
  const rules = rulesFor(phone, selector);
  assert.equal(rules.length, 1, `une règle et une seule attendue pour \`${selector}\`.`);
  return rules[0];
}

describe('Le champ téléphone rétrécit au lieu de déborder', () => {
  it('la boîte peut rétrécir sous la largeur de son contenu', () => {
    assert.equal(declaration(single('.spa-phone__control'), 'min-inline-size'), '0');
  });

  it('le numéro prend la place restante et peut rétrécir', () => {
    const input = single('.spa-phone__input');
    assert.equal(declaration(input, 'flex'), '1 1 auto');
    assert.equal(declaration(input, 'min-inline-size'), '0');
  });

  it('le bouton du pays garde sa largeur', () => {
    assert.equal(declaration(single('.spa-phone__country'), 'flex'), '0 0 auto');
  });

  it('un nom de pays long passe à la ligne dans la liste', () => {
    const name = single('.spa-phone-picker__name');
    assert.equal(declaration(name, 'min-inline-size'), '0');
    assert.equal(declaration(name, 'overflow-wrap'), 'anywhere');
  });
});

describe('Les cibles tactiles font au moins 44 px', () => {
  for (const [selector, property] of [
    ['.spa-phone__control', 'min-block-size'],
    ['.spa-phone__country', 'min-inline-size'],
    ['.spa-phone-picker__option', 'min-block-size'],
  ]) {
    it(`${selector} — ${property}`, () => {
      assert.equal(declaration(single(selector), property), 'var(--spa-target-min-size)');
    });
  }
});

describe('Le numéro ne déclenche pas le zoom d’iOS', () => {
  it('le champ est en `md` au moins — sous 16 px, iOS zoome à la mise au point', () => {
    assert.equal(declaration(single('.spa-phone__input'), 'font-size'), 'var(--spa-font-size-md)');
  });
});
