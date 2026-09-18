/*
 * Tunnel de réservation — le récapitulatif suit la cliente
 * =============================================================================
 *
 * Issues #735 puis #1047. L'audit `d20260916-1` avait relevé un prix qui
 * disparaissait de l'étape « Prestation » à l'étape « Créneau » ; l'audit
 * `d20260918-1` a relevé ce qu'en a fait la correction — une barre de quatre
 * couples libellé / valeur en capitales, montée à **trois rangées** à l'étape
 * « Coordonnées », où elle masquait environ 160 px du formulaire — et ce qu'elle
 * n'avait pas corrigé : à 1 280 px, aucune colonne latérale, le récapitulatif en
 * pied de carte.
 *
 * `BM-TUNNEL-07` (`docs/design/benchmark/parcours-client.md`) décrit les deux
 * formes attendues : *« à 1280 px, une carte collante à droite (prestations,
 * praticien, total, « Continuer ») ; à 390 px, une barre collée en bas (« 33 € ·
 * 1 prestation · 30 min » et « Continuer ») qui se déplie en détail »*.
 *
 * ## Ce que cette suite tient, et rien d'autre
 *
 * Quatre propriétés que rien d'autre ne signale si elles tombent :
 *
 * 1. la barre basse est **collante** et **opaque** — le contenu défile derrière ;
 * 2. sa ligne de rappel **ne passe pas à la ligne** — c'est le défaut corrigé ;
 * 3. la colonne de bureau est **collante**, dans une grille à deux pistes ;
 * 4. les deux surfaces sont bien **rendues**, l'une par l'étape, l'autre par le
 *    tunnel.
 *
 * `booking-summary-bar.test.tsx` éprouve ce qu'elles disent,
 * `booking-tunnel.test.tsx` à quelles étapes elles apparaissent ; ni l'un ni
 * l'autre ne charge une feuille de style. Une barre qui remonterait avec le
 * contenu compilerait, s'afficherait, passerait les deux — et rouvrirait l'écart
 * à l'identique sur l'étape la plus longue du tunnel, celle du calendrier.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #1047.
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
  withoutMediaQueries,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const summaryBar = join(here, '..', 'components', 'booking', 'summary-bar.tsx');
const steps = join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'steps');
const tunnel = join(
  here,
  '..',
  'app',
  '(booking)',
  '[tenantSlug]',
  'reservation',
  'booking-tunnel.tsx',
);

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));
/** Sans les paliers : la barre basse est la forme **de base**, celle du pouce. */
const base = withoutMediaQueries(booking);

describe('La barre basse du tunnel tient le bas de l’écran (#735, #1047)', () => {
  const rule = rulesFor(base, '.spa-booking__bar').join(' ');

  it('est collée au bas de la fenêtre tant que l’étape déborde', () => {
    assert.notEqual(rule, '', 'Aucune règle ne vise `.spa-booking__bar`.');

    assert.equal(
      declaration(rule, 'position'),
      'sticky',
      'La barre basse n’est plus collante : elle remonte avec le contenu, et le ' +
        'prix comme le bouton redisparaissent dès que l’étape dépasse la hauteur ' +
        'de l’écran — l’écart relevé par l’audit (#735).',
    );

    assert.equal(
      declaration(rule, 'inset-block-end'),
      '0',
      'La barre est `sticky` sans point d’ancrage : sans `inset-block-end`, elle ' +
        'ne se colle à rien et se comporte exactement comme une barre statique.',
    );
  });

  it('est opaque, parce que le contenu défile derrière elle', () => {
    const background = declaration(rule, 'background-color');

    assert.ok(
      background !== null && background.startsWith('var(--spa-color-'),
      'La barre basse n’a plus de fond pris aux jetons sémantiques : le contenu ' +
        `de l’étape se lit au travers (lu : ${String(background)}).`,
    );

    assert.ok(
      declaration(rule, 'border-block-start') !== null,
      'La barre n’a plus de filet supérieur : rien ne la sépare du contenu qui ' +
        'passe dessous, et les deux se lisent comme un seul bloc.',
    );
  });

  it('rejoint les bords de la page, dont elle annule la gouttière', () => {
    assert.equal(
      declaration(rule, 'margin-inline'),
      'calc(var(--booking-gutter) * -1)',
      'La barre ne compense plus la gouttière de la page : elle s’arrête à ' +
        'quelques pixels des bords et laisse voir le contenu défiler au-dessous ' +
        'd’elle — une barre qui ne touche pas le bord ne se lit plus comme une barre.',
    );
  });

  it('tient son rappel sur une seule ligne — le défaut que #1047 corrige', () => {
    const line = rulesFor(base, '.spa-booking__bar-line').join(' ');

    assert.notEqual(line, '', 'Aucune règle ne vise `.spa-booking__bar-line`.');
    assert.equal(
      declaration(line, 'flex-wrap'),
      'nowrap',
      '`.spa-booking__bar-line` autorise le retour à la ligne : le rappel remonte ' +
        'à deux puis trois rangées à 360 px, et masque le formulaire de l’étape ' +
        '« Coordonnées » — l’écart relevé par `d20260918-1`.',
    );

    // Ce qui cède est le nom de la prestation, et lui seul : durée et prix sont
    // ce qu'on relit avant de décider.
    const service = rulesFor(base, '.spa-booking__bar-service').join(' ');

    assert.equal(declaration(service, 'text-overflow'), 'ellipsis');
    assert.equal(declaration(service, 'white-space'), 'nowrap');

    for (const selector of ['.spa-booking__bar-price', '.spa-booking__bar-fact']) {
      assert.equal(
        declaration(rulesFor(base, selector).join(' '), 'white-space'),
        'nowrap',
        `\`${selector}\` se laisse couper : le prix ou la durée peuvent être ` +
          'tronqués, ce qui est exactement le défaut que le rappel doit éviter.',
      );
    }
  });
});

describe('La colonne récapitulative suit la cliente au bureau (#1047)', () => {
  it('ouvre une seconde piste de 22 rem à partir de 64 rem', () => {
    // Lu sur la feuille **entière** : cette règle est un palier, c'est tout son
    // objet.
    const grid = rulesFor(booking, '.spa-booking__frame--aside').join(' ');

    assert.notEqual(grid, '', 'Aucune règle ne vise `.spa-booking__frame--aside`.');
    assert.equal(
      declaration(grid, 'grid-template-columns'),
      'minmax(0, 1fr) 22rem',
      'Le cadre du tunnel n’ouvre plus la colonne récapitulative : le tunnel ' +
        'redevient une colonne unique au centre d’un écran de 1 280 px, l’écart ' +
        'relevé par `d20260918-1`.',
    );

    assert.match(
      booking,
      /@media[^{]+min-width[^{]+\{\s*\.spa-booking__frame--aside/u,
      'La grille à deux pistes n’est plus sous un palier de largeur : la colonne ' +
        'récapitulative se retrouve à 22 rem sur un écran de 360 px.',
    );
  });

  it('colle la carte pendant tout le défilement', () => {
    const aside = rulesFor(booking, '.spa-booking__aside').join(' ');

    assert.equal(
      declaration(aside, 'position'),
      'sticky',
      'La colonne récapitulative n’est plus collante : le total sort de l’écran ' +
        'au premier défilement, alors que BM-TUNNEL-07 le veut visible « à chaque ' +
        'étape ».',
    );
    assert.notEqual(
      declaration(aside, 'inset-block-start'),
      null,
      'La colonne est `sticky` sans point d’ancrage : elle ne se colle à rien.',
    );
  });
});

describe('Les deux surfaces sont bien rendues', () => {
  const source = readFileSync(summaryBar, 'utf8');

  it('portent les classes que la feuille décrit', () => {
    for (const className of ['spa-booking__bar', 'spa-booking__aside']) {
      assert.ok(
        source.includes(`className="${className}"`),
        `\`summary-bar.tsx\` ne porte plus \`${className}\` : la feuille a beau ` +
          'déclarer la règle, plus rien ne la déclenche.',
      );
    }
  });

  it('la barre est montée par chaque étape, l’action primaire avec elle', () => {
    // Elle est rendue par l'étape et non par le tunnel : l'action primaire est
    // un `type="submit"`, et un bouton de soumission doit rester dans son
    // `<form>` (`summary-bar.tsx`).
    for (const step of ['service-step', 'slot-step', 'contact-step', 'summary-step']) {
      assert.match(
        readFileSync(join(steps, `${step}.tsx`), 'utf8'),
        /<BookingActionBar/u,
        `\`${step}.tsx\` ne monte plus la barre basse : son écran perd son rappel ` +
          'et son action ancrée au pouce.',
      );
    }
  });

  it('la colonne est montée par le tunnel, qui seul connaît la grille', () => {
    assert.match(
      readFileSync(tunnel, 'utf8'),
      /<BookingSummaryAside/u,
      '`booking-tunnel.tsx` ne monte plus la colonne récapitulative : elle n’est ' +
        'la sœur d’aucune piste de grille, et l’écart de l’audit rouvre en entier.',
    );
  });
});
