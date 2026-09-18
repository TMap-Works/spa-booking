/*
 * Tunnel de réservation — le squelette réserve la hauteur du contenu
 * =============================================================================
 *
 * Issue #1055, audit `d20260918-1`, critère `ds:etats`. `BM-ECRAN-01`
 * (`docs/design/benchmark/transverse.md`) : *« pendant le chargement, la page a
 * déjà sa forme »*, et `docs/design/appointments/states.md` en règle générale :
 * *« La structure de la page reste stable (pas de saut de mise en page à
 * l'arrivée des données) »*.
 *
 * ## Ce que cette suite tient, et pourquoi elle existe séparément
 *
 * Une réserve de hauteur ne se voit d'aucune autre façon :
 *
 * - `booking-step-skeleton.test.tsx` monte le squelette sous jsdom, qui ne
 *   charge aucune feuille de style : toutes ses assertions passeraient sur des
 *   blocs de hauteur nulle, c'est-à-dire sur le cadre vide que le ticket
 *   supprime ;
 * - la recette et la QA regardent un écran à un instant donné, jamais la
 *   bascule entre deux — et c'est la bascule qui saute.
 *
 * D'où la comparaison, refaite ici : chaque boîte du squelette est confrontée à
 * la boîte réelle qu'elle remplace, en résolvant les mêmes jetons. Une pastille
 * d'horaire dont la hauteur cesserait de suivre la cible tactile, un bloc de
 * date dont le corps changerait d'un côté seulement, rouvrent le saut — et cette
 * suite le dit avec le chiffre.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  declaration,
  readStyleSheet,
  readTokenDeclarations,
  resolveToken,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const tokens = readTokenDeclarations();

const sheet = (name) => withoutMediaQueries(stripComments(readStyleSheet(styleSheetPath(name))));

const booking = sheet('components/booking.css');
const dateBlock = sheet('components/date-block.css');
const slotGrid = sheet('components/slot-grid.css');
const field = sheet('components/field.css');
const button = sheet('components/button.css');
const tabs = sheet('components/tabs.css');

/**
 * La valeur d'une longueur CSS, en `rem`.
 *
 * Elle traverse `calc(…)`, résout les `var(--…)` dans `tokens.css` et évalue les
 * sommes de produits — c'est tout ce que ces déclarations emploient, et une
 * analyse CSS complète serait une dépendance de plus dans un dossier qui n'en a
 * aucune. Un pixel vaut un seizième de `rem` : la bordure d'un champ est la
 * seule de ces longueurs à ne pas être exprimée en jetons.
 */
function rem(expression) {
  const unwrapped = expression.startsWith('calc(')
    ? expression.slice('calc('.length, -1)
    : expression;
  const resolved = unwrapped.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, name) =>
    resolveToken(tokens, name),
  );

  return resolved
    .split('+')
    .reduce(
      (total, term) =>
        total + term.split('*').reduce((product, factor) => product * scalar(factor), 1),
      0,
    );
}

function scalar(text) {
  const trimmed = text.trim();
  const value = Number.parseFloat(trimmed);

  assert.ok(Number.isFinite(value), `longueur illisible : « ${trimmed} »`);

  return trimmed.endsWith('px') ? value / 16 : value;
}

/** La déclaration `property` de la règle `selector`, dans la feuille `css`. */
function value(css, selector, property) {
  const [body] = rulesFor(css, selector);

  assert.ok(body !== undefined, `règle absente : ${selector}`);

  const found = declaration(body, property);

  assert.ok(found !== null, `${selector} : pas de ${property}`);

  return found;
}

describe('Squelette du tunnel — la hauteur est réservée', () => {
  /*
   * Le bloc de date ne porte aucun texte à imiter : sa hauteur est réécrite en
   * jetons dans `booking.css`. Elle doit valoir celle que `date-block.css`
   * compose — `line-height: 1` y fait que chaque ligne vaut exactement son
   * corps, deux abréviations en `xs` et le quantième en `lg`, plus deux
   * gouttières et le rembourrage vertical.
   */
  it('la journée de la bande a la hauteur de `.spa-date-block`', () => {
    assert.equal(value(dateBlock, '.spa-date-block', 'line-height'), '1');

    const reelle =
      2 * rem(value(dateBlock, '.spa-date-block__weekday', 'font-size')) +
      rem(value(dateBlock, '.spa-date-block__day', 'font-size')) +
      2 * rem(value(dateBlock, '.spa-date-block', 'gap')) +
      2 * rem(value(dateBlock, '.spa-date-block', 'padding-block'));

    assert.equal(rem(value(booking, '.spa-booking__skeleton-day', 'block-size')), reelle);
    assert.equal(
      value(booking, '.spa-booking__skeleton-day', 'inline-size'),
      value(dateBlock, '.spa-date-block', 'inline-size'),
    );
  });

  it('la pastille d’horaire a la hauteur du bouton de créneau', () => {
    assert.equal(
      rem(value(booking, '.spa-booking__skeleton-slot', 'block-size')),
      rem(value(slotGrid, '.spa-slot-grid__cell .spa-button', 'min-block-size')),
    );
  });

  it('le contrôle de formulaire a la hauteur d’un champ réel', () => {
    assert.equal(
      rem(value(booking, '.spa-booking__skeleton-control', 'block-size')),
      rem(value(field, '.spa-field__control', 'min-block-size')),
    );
  });

  /*
   * Le champ long — le seul `TextArea` du formulaire, à ses trois lignes par
   * défaut. Le calcul est celui de `.spa-field__control` : trois lignes de son
   * corps, son rembourrage vertical, sa bordure.
   */
  it('le champ long a la hauteur des trois lignes qu’il attend', () => {
    const control = rulesFor(field, '.spa-field__control')[0];
    const attendue =
      3 * rem(declaration(control, 'font-size')) * rem(declaration(control, 'line-height')) +
      2 * rem(declaration(control, 'padding-block')) +
      2 / 16;

    assert.equal(
      rem(value(booking, '.spa-booking__skeleton-control--tall', 'block-size')),
      attendue,
    );
  });

  it('la rangée d’onglets a la hauteur d’un onglet', () => {
    assert.equal(
      rem(value(booking, '.spa-booking__skeleton-tabs', 'block-size')),
      rem(value(tabs, '.spa-tabs__tab', 'min-block-size')),
    );
  });

  it('l’action de la barre basse a la hauteur d’un bouton', () => {
    assert.equal(
      rem(value(booking, '.spa-booking__skeleton-button', 'block-size')),
      rem(value(button, '.spa-button', 'min-block-size')),
    );
  });

  /*
   * La barre grise qui tient lieu de texte est posée **dans** l'élément
   * typographique réel. Deux conditions pour qu'elle n'en change pas la hauteur :
   * elle est `inline-block` — un bloc imposerait la sienne —, et elle reste en
   * deçà de l'ascendante de la police, que `0.7em` ne dépasse jamais.
   */
  it('la barre de texte ne fait pas grandir la ligne qui la porte', () => {
    assert.equal(value(booking, '.spa-booking__skeleton-text', 'display'), 'inline-block');

    const hauteur = value(booking, '.spa-booking__skeleton-text', 'block-size');

    assert.ok(hauteur.endsWith('em'), `hauteur relative attendue, lu « ${hauteur} »`);
    assert.ok(
      Number.parseFloat(hauteur) < 0.8,
      `« ${hauteur} » dépasse l’ascendante : la ligne grandirait`,
    );
  });

  it('le squelette n’est ni cliquable ni survolable', () => {
    assert.equal(value(booking, '.spa-booking__step--skeleton', 'pointer-events'), 'none');
  });
});

describe('Squelette du tunnel — un seul dessin des horaires', () => {
  /*
   * L'étape « Créneau » attend deux fois : avant l'hydratation, puis pendant
   * l'appel aux disponibilités que `SlotStep` lance à son montage. Si les deux
   * attentes ne dessinaient pas la même chose, la cliente verrait un squelette
   * céder la place à un autre — un saut de plus, là où le ticket en supprime un.
   *
   * La feuille ne peut pas le dire : c'est la source qui le porte, et les deux
   * fichiers doivent monter le **même** composant.
   */
  it('le tunnel et le sélecteur montent le même squelette', () => {
    const tunnel = readFileSync(
      join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'booking-tunnel.tsx'),
      'utf8',
    );
    const picker = readFileSync(join(here, '..', 'components', 'booking', 'slot-picker.tsx'), 'utf8');

    assert.match(tunnel, /BookingStepSkeleton/);
    assert.match(tunnel, /components\/booking\/step-skeleton/);
    assert.match(picker, /SlotGridSkeleton/);
    assert.match(picker, /components\/booking\/step-skeleton/);
  });
});
