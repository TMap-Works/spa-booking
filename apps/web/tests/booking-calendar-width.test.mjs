/*
 * Tunnel de réservation — la largeur de l'étape « créneau »
 * =============================================================================
 *
 * Issue #738. L'audit de conception a relevé, sur `/…/reservation`, une bande de
 * journées qui listait quatorze dates et s'arrêtait : huit visibles à 1 280 px,
 * dans un conteneur de 44rem, pendant que des centaines de pixels de page
 * restaient vides de chaque côté. `docs/design/appointments/wireframes.md`
 * prescrit l'inverse pour cette étape-là : *« Desktop : le calendrier passe en
 * vue semaine (colonnes de jours), plus de créneaux visibles d'un coup »*.
 *
 * La mesure de base n'est pourtant pas une erreur : #623 puis #1047 la posent
 * pour que le tunnel rende ses formulaires à la mesure de ceux de l'espace
 * compte, et cinq étapes sur six sont des formulaires. La sixième est un
 * calendrier, et c'est elle seule qui s'élargit — par `:has()`, qui lit l'étape
 * affichée là où elle est déjà plutôt que de la faire remonter jusqu'au cadre.
 *
 * Le porteur de la mesure a changé avec #1047 : la carte englobante a disparu,
 * et c'est `.spa-booking__frame` — la grille du tunnel — qui borne désormais la
 * colonne de contenu. La règle, elle, est la même.
 *
 * Le piège que cette suite tient : rien ne signale la disparition d'un
 * modificateur. `slot-step.tsx` perdrait `--calendar` que l'écran compilerait,
 * s'afficherait, passerait la recette — et rouvrirait l'écart à l'identique. La
 * règle CSS et la classe qui la déclenche sont donc éprouvées **ensemble**.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #738.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { declaration, readStyleSheet, rulesFor, stripComments, styleSheetPath } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const slotStep = join(
  here,
  '..',
  'app',
  '(booking)',
  '[tenantSlug]',
  'reservation',
  'steps',
  'slot-step.tsx',
);

/** Le modificateur que l'étape « créneau » pose, et que la feuille lit. */
const MODIFIER = 'spa-booking__step--calendar';

describe('L’étape « créneau » élargit l’enveloppe du tunnel (#738)', () => {
  const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));

  it('borne la colonne de contenu à la mesure d’un formulaire', () => {
    // La règle de base est lue hors de toute requête de média : c'est elle qui
    // vaut sur un téléphone, et l'élargissement ne doit pas l'avoir remplacée.
    const nominal = declaration(
      rulesFor(booking, '.spa-booking__frame').join(' '),
      'max-inline-size',
    );

    assert.ok(
      nominal !== null && Number.parseFloat(nominal) <= 48,
      '`.spa-booking__frame` ne borne plus ses formulaires à la mesure de lecture ' +
        `(lu : ${String(nominal)}) : les deux rendus du même formulaire — tunnel ` +
        'et espace compte — cessent d’avoir la même mesure (#623).',
    );
  });

  it('s’élargit sur la seule étape qui porte un calendrier', () => {
    const rule = rulesFor(booking, `.spa-booking__frame:has(.${MODIFIER})`).join(' ');

    assert.notEqual(
      rule,
      '',
      'Aucune règle ne vise `.spa-booking__frame:has(.' +
        MODIFIER +
        ')` : la grille du calendrier retombe à la mesure d’un formulaire, et le ' +
        'mois cesse de tenir d’un coup à 1 280 px (#738).',
    );

    const wider = declaration(rule, 'max-inline-size');

    assert.ok(
      wider !== null && Number.parseFloat(wider) > 48,
      `L’étape « créneau » ne s’élargit pas au-delà de la mesure de base (lu : ${String(wider)}).`,
    );
  });

  it('ne l’élargit qu’aux largeurs de bureau', () => {
    // Sous le seuil, `max-inline-size` ne ferait rien de plus que la largeur
    // disponible : l'élargissement n'a de sens que là où il y a de la place.
    assert.match(
      booking,
      new RegExp(`@media[^{]+min-width[^{]+\\{\\s*\\.spa-booking__frame:has\\(\\.${MODIFIER}\\)`),
      'L’élargissement de l’étape « créneau » n’est pas borné à une largeur ' +
        'minimale : il s’appliquerait sur un téléphone, où il ne change rien, ' +
        'et masquerait la régression le jour où le seuil compterait.',
    );
  });

  it('est déclenché par `slot-step.tsx`, et par lui seul', () => {
    const source = readFileSync(slotStep, 'utf8');

    assert.match(
      source,
      new RegExp(`className="spa-booking__step ${MODIFIER}"`),
      '`slot-step.tsx` ne porte plus `' +
        MODIFIER +
        '` : la feuille a beau déclarer la règle, plus rien ne la déclenche.',
    );
  });
});
