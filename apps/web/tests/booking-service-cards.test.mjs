/*
 * Tunnel de réservation — les cartes de l'étape 1 et leur CTA ancré
 * =============================================================================
 *
 * Issue #741. L'audit de conception a relevé, sur `/…/reservation`, une étape 1
 * réduite à un `<select>` dont les options concaténaient nom, durée et prix : à
 * 360 px, le contrôle refermé affichait « Rituel duo 90 min — 1 h 30 — 14… », le
 * prix coupé, et rien d'autre à l'écran ne le portait. Le CTA, lui, était un
 * bouton de largeur automatique dans le flux.
 * `docs/design/appointments/wireframes.md` — étape 1 — prescrit l'inverse :
 * *« chaque carte affiche durée et prix »*, *« la sélection est un radiogroup »*,
 * et un CTA *« pleine largeur, ancré en bas de l'écran (barre collante) »*.
 *
 * Ce que cette suite tient, et rien d'autre : les propriétés de **feuille de
 * style** dont rien d'autre ne signale la disparition. `service-step.test.tsx`
 * éprouve la structure — un radiogroup, quatre faits par carte, un bouton qui
 * dit pourquoi il est inerte — mais ne charge aucune feuille : un CTA redevenu
 * statique, ou des cartes qui cesseraient de laisser leur texte passer à la
 * ligne, compileraient, passeraient ce test-là, et rouvriraient l'écart à
 * l'identique. C'est le même partage que `booking-summary-bar.test.mjs`, dont
 * cette suite reprend le raisonnement — et la barre dont elle reprend l'ancrage.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #741.
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

const serviceChoice = join(here, '..', 'components', 'booking', 'service-choice.tsx');
const serviceStep = join(
  here,
  '..',
  'app',
  '(booking)',
  '[tenantSlug]',
  'reservation',
  'steps',
  'service-step.tsx',
);

/** Le groupe de cartes, et la carte. */
const CARTES = 'spa-booking__services';
const CARTE = 'spa-booking__service';

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));

describe('Le CTA de l’étape 1 est ancré au bas de l’écran (#741, #1047)', () => {
  it('est porté par la barre basse commune, pleine largeur', () => {
    const source = readFileSync(serviceStep, 'utf8');

    // L'ancrage et l'opacité de cette barre sont tenus par
    // `booking-summary-bar.test.mjs` : depuis #1047 il n'y en a plus qu'une pour
    // toutes les étapes, et l'éprouver deux fois ferait diverger les deux
    // messages d'échec le jour où elle change.
    assert.match(
      source,
      /<BookingActionBar/u,
      '`service-step.tsx` ne monte plus la barre basse : le CTA repart dans le ' +
        'flux, et une liste de prestations un peu longue le repousse sous la ' +
        'ligne de flottaison — l’écart relevé par l’audit (#741).',
    );

    // `block` est ce qui donne au bouton la mesure de la barre
    // (`styles/README.md` §2) : sans lui, le CTA reprend sa largeur automatique
    // au milieu d'une barre pleine largeur, ce que le wireframe écarte.
    assert.match(
      source,
      /<Button[^>]*\sblock\b/su,
      '`service-step.tsx` ne passe plus `block` à son CTA : le bouton cesse de ' +
        'mesurer la barre qui le porte (`wireframes.md`, « CTA primaire pleine largeur »).',
    );
  });
});

describe('Les prestations se comparent en cartes (#741)', () => {
  it('est un radiogroup, rendu par `service-choice.tsx`', () => {
    const source = readFileSync(serviceChoice, 'utf8');

    assert.match(
      source,
      /type="radio"/,
      '`service-choice.tsx` ne rend plus de boutons radio : la sélection cesse ' +
        'd’être le `radiogroup` que `wireframes.md` prescrit à l’étape 1, et la ' +
        'navigation aux flèches disparaît avec lui.',
    );

    assert.match(
      source,
      new RegExp(`className="${CARTES}"`),
      `\`service-choice.tsx\` ne porte plus \`${CARTES}\` : la grille de cartes ` +
        'n’est plus mise en page.',
    );
  });

  it('pose les cartes en grille, sans point de rupture sur la fenêtre', () => {
    const rule = rulesFor(booking, `.${CARTES}`).join(' ');

    assert.notEqual(rule, '', `Aucune règle ne vise \`.${CARTES}\`.`);

    assert.equal(
      declaration(rule, 'display'),
      'grid',
      'Les cartes ne sont plus en grille : « Desktop : grille de 2–3 cartes par ' +
        'ligne » (`wireframes.md`, étape 1) n’est plus tenu.',
    );

    // Un `<fieldset>` porte `min-inline-size: min-content` dans la feuille de
    // l'agent utilisateur : sans cette remise à zéro, la boîte refuse de
    // descendre sous la largeur de son contenu le plus large et déborde du
    // panneau à 360 px — le défaut qu'on vient de corriger, rouvert par la mise
    // en page.
    assert.equal(
      declaration(rule, 'min-inline-size'),
      '0',
      '`min-inline-size: 0` a disparu du `<fieldset>` des cartes : il reprend le ' +
        '`min-content` du navigateur et déborde du panneau sur un écran étroit.',
    );
  });

  it('laisse le texte d’une carte passer à la ligne plutôt que déborder', () => {
    const body = rulesFor(booking, `.${CARTE}-body`).join(' ');

    assert.equal(
      declaration(body, 'min-inline-size'),
      '0',
      'Le corps d’une carte ne peut plus se réduire : un mot plus long que la ' +
        'colonne — une description d’un seul tenant — pousse la carte hors de la ' +
        'grille au lieu de passer à la ligne.',
    );

    const facts = rulesFor(booking, `.${CARTE}-facts`).join(' ');

    // Durée et prix ne sont plus des morceaux d'une chaîne composée : ce sont
    // deux boîtes, et elles passent à la ligne l'une sous l'autre plutôt que
    // d'être coupées. C'est précisément ce qui rend le prix illisible à 360 px
    // quand cela tombe.
    assert.equal(
      declaration(facts, 'flex-wrap'),
      'wrap',
      'La durée et le prix ne passent plus à la ligne : à 360 px, l’un des deux ' +
        'est tronqué — l’écart exact relevé par l’audit (#741).',
    );
  });

  it('marque la carte retenue autrement que par la seule couleur', () => {
    const selected = rulesFor(booking, `.${CARTE}:has(.${CARTE}-input:checked)`).join(' ');

    assert.notEqual(
      selected,
      '',
      'Plus aucune règle ne distingue la carte retenue : la sélection ne se voit ' +
        'plus qu’à la pastille du bouton radio.',
    );

    const input = rulesFor(booking, `.${CARTE}-input`).join(' ');

    // La pastille reste **visible** (aucune mise à l'écart visuelle du contrôle) :
    // c'est le signal non chromatique de l'état retenu, celui que WCAG 1.4.1
    // exige en plus de la couleur du cadre.
    assert.equal(
      declaration(input, 'accent-color'),
      'var(--spa-color-accent)',
      'Le bouton radio de la carte n’est plus peint aux couleurs du produit : ' +
        's’il a été masqué, l’état « retenue » ne tient plus qu’à la couleur du ' +
        'cadre et du fond (WCAG 1.4.1).',
    );
  });

  it('réserve à la barre collante la place qu’elle prend au défilement', () => {
    const rule = rulesFor(booking, `.${CARTE}`).join(' ');

    // Le navigateur amène la carte focalisée à ras du bord bas de la fenêtre et
    // ne sait rien de ce qui la recouvre : sans cette marge, la dernière carte
    // atteinte à la flèche bas arrive **sous** la barre d'action — constaté à
    // 360 px pendant la recette de #741.
    assert.ok(
      declaration(rule, 'scroll-margin-block-end') !== null,
      'La carte ne réserve plus la hauteur de la barre collante au défilement : ' +
        'la dernière carte atteinte au clavier se retrouve à moitié cachée ' +
        'derrière le CTA.',
    );
  });

  it('rend le focus visible sur la carte entière, et non sur la seule pastille', () => {
    const focus = rulesFor(booking, `.${CARTE}:has(.${CARTE}-input:focus-visible)`).join(' ');

    assert.ok(
      declaration(focus, 'outline') !== null,
      'La carte ne porte plus d’anneau de focus : le parcours de réservation doit ' +
        'rester praticable sans souris, focus visible compris (skill web-frontend §7).',
    );
  });
});
