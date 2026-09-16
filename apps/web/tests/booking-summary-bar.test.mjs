/*
 * Tunnel de réservation — la barre de résumé tient le bas de l'écran
 * =============================================================================
 *
 * Issue #735. L'audit de conception a relevé, sur `/…/reservation`, un prix qui
 * disparaissait au passage de l'étape « Prestation » à l'étape « Créneau », et
 * une étape « Coordonnées » où plus rien ne rappelait ni la prestation, ni la
 * date, ni l'heure, ni le prix. `docs/design/appointments/README.md` — « Mobile
 * d'abord » — prescrit l'inverse : *« Barre de résumé collante en bas rappelant
 * service, praticien, date/heure et prix dès qu'ils sont connus »*, et
 * `wireframes.md` ajoute que *« le contenu défile derrière »*.
 *
 * Ce que cette suite tient, et rien d'autre : **collante**, et **opaque**. Ce
 * sont les deux propriétés qui font la barre, et les deux que rien ne signale si
 * elles tombent. `booking-summary-bar.test.tsx` éprouve ce qu'elle dit,
 * `booking-tunnel.test.tsx` à quelles étapes elle apparaît ; ni l'un ni l'autre
 * ne charge une feuille de style. Une barre qui remonterait avec le contenu
 * compilerait, s'afficherait, passerait les deux — et rouvrirait l'écart à
 * l'identique sur l'étape la plus longue du tunnel, celle du calendrier.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #735.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  declaration,
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const summaryBar = join(here, '..', 'components', 'booking', 'summary-bar.tsx');
const tunnel = join(
  here,
  '..',
  'app',
  '(booking)',
  '[tenantSlug]',
  'reservation',
  'booking-tunnel.tsx',
);

/** La classe que le composant porte, et que la feuille décrit. */
const BAR = 'spa-booking__summary';

describe('La barre de résumé du tunnel tient le bas de l’écran (#735)', () => {
  const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));
  const rule = rulesFor(booking, `.${BAR}`).join(' ');

  it('est collée au bas de la fenêtre tant que l’étape déborde', () => {
    assert.notEqual(rule, '', `Aucune règle ne vise \`.${BAR}\`.`);

    assert.equal(
      declaration(rule, 'position'),
      'sticky',
      'La barre de résumé n’est plus collante : elle remonte avec le contenu, et ' +
        'le prix redisparaît dès que l’étape « Créneau » dépasse la hauteur de ' +
        'l’écran — l’écart relevé par l’audit (#735).',
    );

    assert.equal(
      declaration(rule, 'inset-block-end'),
      '0',
      'La barre est `sticky` sans point d’ancrage : sans `inset-block-end`, elle ' +
        'ne se colle à rien et se comporte exactement comme une barre statique.',
    );
  });

  it('est opaque, parce que le contenu défile derrière elle', () => {
    const background = declaration(rule, 'background');

    assert.ok(
      background !== null && background.startsWith('var(--spa-color-'),
      'La barre de résumé n’a plus de fond pris aux jetons sémantiques : le ' +
        `contenu de l’étape se lit au travers (lu : ${String(background)}).`,
    );

    assert.ok(
      declaration(rule, 'border-block-start') !== null,
      'La barre n’a plus de filet supérieur : rien ne la sépare du contenu qui ' +
        'passe dessous, et les deux se lisent comme un seul bloc.',
    );
  });

  it('rejoint les bords du panneau, dont elle annule le remplissage', () => {
    const padding = declaration(rulesFor(booking, '.spa-booking__panel').join(' '), 'padding');

    assert.ok(padding !== null, '`.spa-booking__panel` ne déclare plus de remplissage.');

    // Les marges négatives sont exactement l'opposé de ce remplissage : sinon la
    // barre s'arrête à quelques pixels des bords et laisse voir le fond du
    // panneau au-dessous d'elle pendant le défilement.
    for (const property of ['margin-inline', 'margin-block-end']) {
      assert.equal(
        declaration(rule, property),
        `calc(${padding} * -1)`,
        `\`${property}\` de la barre ne compense plus le remplissage du panneau ` +
          `(${padding}) : la barre ne touche plus le bas de la carte.`,
      );
    }
  });

  it('est rendue par `summary-bar.tsx`, et montée par le tunnel', () => {
    assert.match(
      readFileSync(summaryBar, 'utf8'),
      new RegExp(`className="${BAR}"`),
      `\`summary-bar.tsx\` ne porte plus \`${BAR}\` : la feuille a beau déclarer ` +
        'la règle, plus rien ne la déclenche.',
    );

    assert.match(
      readFileSync(tunnel, 'utf8'),
      /<BookingSummaryBar/,
      '`booking-tunnel.tsx` ne monte plus la barre de résumé : elle n’apparaît ' +
        'sur aucune étape, et l’écart de l’audit rouvre en entier.',
    );
  });
});
