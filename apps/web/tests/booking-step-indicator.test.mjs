/*
 * Tunnel de réservation — l'en-tête et la progression tiennent en haut d'écran
 * =============================================================================
 *
 * Issues #740 puis #1047. L'audit `d20260916-1` avait relevé cinq libellés
 * d'étape rendus à l'identique ; l'audit `d20260918-1` a relevé ce qu'en a fait
 * la correction — un fil de cinq pastilles qui occupe **trois lignes** à 360 px,
 * sous un bandeau de page de trois lignes de plus, le contenu de l'étape
 * commençant alors sous la ligne de flottaison.
 *
 * `BM-TUNNEL-09` (`docs/design/benchmark/parcours-client.md`) veut que *« la
 * cliente sache combien il reste à faire »*, et `BM-TUNNEL-10` que l'en-tête se
 * réduise à *« un "←" (étape précédente) et un "×" (quitter), en cibles
 * tactiles larges »*. Le critère d'acceptation de #1047 chiffre le reste : *« à
 * 360 px, en-tête + progression ≤ 120 px de haut »*.
 *
 * ## Ce que cette suite tient, et pourquoi elle existe séparément
 *
 * Un budget de hauteur ne se voit d'aucune autre façon :
 *
 * - `booking-tunnel.test.tsx` éprouve le compte, les titres et la navigation
 *   sous jsdom, qui ne charge aucune feuille de style : toutes ces assertions
 *   passeraient sur un en-tête de 200 px ;
 * - la recette et la QA regardent un écran à un instant donné, pas la règle qui
 *   le peint — et la règle a survécu neuf mois à ce régime-là (#740).
 *
 * D'où le calcul, refait ici à partir des valeurs déclarées : chacune des cinq
 * parts est lue dans la feuille, et leur somme est comparée aux 120 px. Une
 * gouttière élargie ou un titre passé au corps supérieur rouvre l'écart, et
 * cette suite le dit avec le chiffre.
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

const components = join(here, '..', 'components', 'booking');
const header = join(components, 'tunnel-header.tsx');
const progress = join(components, 'tunnel-progress.tsx');
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
/**
 * La feuille sans ses paliers — c'est d'elle que se lit le budget de hauteur.
 *
 * Le critère porte sur **360 px**, c'est-à-dire sur les déclarations de base :
 * un palier posé à 48 rem détend l'espace de tête et grossit le titre, et les
 * lire ensemble ferait conclure sur un écran qui n'est pas celui du critère.
 */
const base = withoutMediaQueries(booking);
const tokens = readTokenDeclarations();

/** `1rem` = 16 px, la racine du socle — `base.css` ne la redéfinit pas. */
const ROOT_FONT_SIZE = 16;

/** « 1.5rem », « var(--spa-space-4) », « 3rem » → pixels. */
function pixels(value) {
  const resolved = value.startsWith('var(')
    ? resolveToken(tokens, value.slice('var('.length, -1).trim())
    : value;

  assert.ok(resolved !== null, `Valeur illisible : ${value}`);

  const rem = /^([\d.]+)rem$/u.exec(resolved);
  if (rem !== null) {
    return Number(rem[1]) * ROOT_FONT_SIZE;
  }

  const px = /^([\d.]+)px$/u.exec(resolved);
  assert.ok(px !== null, `Unité non gérée : ${resolved}`);

  return Number(px[1]);
}

/** La valeur déclarée par une règle, ou l'échec avec le sélecteur en cause. */
function valueOf(selector, property, css = base) {
  const rule = rulesFor(css, selector).join(' ');

  assert.notEqual(rule, '', `Aucune règle ne vise \`${selector}\`.`);

  const value = declaration(rule, property);

  assert.notEqual(value, null, `\`${selector}\` ne déclare plus \`${property}\`.`);

  return value;
}

describe('L’en-tête du tunnel se réduit à revenir et sortir (#1047)', () => {
  it('reste collé en haut, opaque, avec un filet qui le sépare du contenu', () => {
    const rule = rulesFor(booking, '.spa-booking__header').join(' ');

    assert.notEqual(rule, '', 'Aucune règle ne vise `.spa-booking__header`.');
    assert.equal(
      declaration(rule, 'position'),
      'sticky',
      'L’en-tête du tunnel n’est plus collant : « Retour » et « Quitter » sortent ' +
        'de l’écran au premier défilement, et le tunnel n’a plus de sortie visible ' +
        '(BM-TUNNEL-10).',
    );
    assert.equal(declaration(rule, 'inset-block-start'), '0');

    const background = declaration(rule, 'background-color');

    assert.ok(
      background !== null && background.startsWith('var(--spa-color-'),
      'L’en-tête n’a plus de fond pris aux jetons sémantiques : le contenu se lit ' +
        `au travers pendant le défilement (lu : ${String(background)}).`,
    );
    assert.notEqual(declaration(rule, 'border-block-end'), null);
  });

  it('donne à ses deux commandes une cible atteignable au doigt (WCAG 2.5.8)', () => {
    assert.equal(
      valueOf('.spa-booking__header-action', 'min-block-size'),
      'var(--spa-target-min-size)',
      '« Retour » et « Quitter » retombent à la hauteur d’une ligne de texte : ' +
        'BM-TUNNEL-10 les veut « en cibles tactiles larges ».',
    );
  });

  it('est rendu par `tunnel-header.tsx`, et monté par le tunnel', () => {
    assert.match(
      readFileSync(header, 'utf8'),
      /className="spa-booking__header"/u,
      '`tunnel-header.tsx` ne porte plus `.spa-booking__header` : la feuille a beau ' +
        'déclarer la règle, plus rien ne la déclenche.',
    );
    assert.match(
      readFileSync(tunnel, 'utf8'),
      /<BookingTunnelHeader/u,
      '`booking-tunnel.tsx` ne monte plus l’en-tête : le tunnel n’a plus ni retour ' +
        'à l’étape précédente, ni sortie.',
    );
  });
});

describe('La progression tient sur une ligne, et le budget de 120 px (#1047)', () => {
  it('ne laisse pas la ligne de progression passer à la ligne', () => {
    const rule = rulesFor(booking, '.spa-booking__progress-line').join(' ');

    assert.notEqual(rule, '', 'Aucune règle ne vise `.spa-booking__progress-line`.');
    assert.match(rule, /display\s*:\s*flex/u);
    assert.equal(
      declaration(rule, 'flex-wrap'),
      null,
      '`.spa-booking__progress-line` autorise le retour à la ligne : le compte et ' +
        'le filet se remettent à occuper deux rangées, l’écart que #1047 corrige.',
    );
  });

  it('tient en-tête et progression sous 120 px à 360 px', () => {
    // Les cinq parts de la hauteur, dans l'ordre où elles s'empilent.
    const bar = pixels(valueOf('.spa-booking__header-bar', 'min-block-size'));
    const lead = pixels(valueOf('.spa-booking__main', 'padding-block').split(/\s+/u)[0]);
    const gap = pixels(valueOf('.spa-booking__progress', 'gap'));
    const count =
      pixels(valueOf('.spa-booking__progress-count', 'font-size')) *
      Number(resolveToken(tokens, '--spa-line-height-normal'));
    const title =
      pixels(valueOf('.spa-booking__title', 'font-size')) *
      Number(resolveToken(tokens, '--spa-line-height-tight'));

    const total = bar + lead + count + gap + title;

    assert.ok(
      total <= 120,
      `En-tête + progression mesurent ${Math.round(total)} px à 360 px, pour un ` +
        'budget de 120 px (#1047) : le contenu de l’étape repart sous la ligne de ' +
        `flottaison. Parts : barre ${bar}, espace de tête ${lead}, compte ` +
        `${Math.round(count)}, gouttière ${gap}, titre ${Math.round(title)}.`,
    );
  });

  it('remplit le filet jusqu’à l’étape courante, sans doubler le compte d’une classe d’état', () => {
    const done = rulesFor(booking, '.spa-booking__progress-segment--done').join(' ');

    assert.notEqual(done, '', 'Aucune règle ne vise le segment franchi du filet.');
    assert.equal(declaration(done, 'background-color'), 'var(--spa-color-accent)');

    // Le filet est décoratif : c'est le texte « Étape n sur 4 » qui porte
    // l'information, et lui seul. Un `role="progressbar"` la dirait une seconde
    // fois, et les deux sources finiraient par diverger.
    assert.match(
      readFileSync(progress, 'utf8'),
      /aria-hidden="true"/u,
      '`tunnel-progress.tsx` n’écarte plus le filet de l’arbre d’accessibilité : ' +
        'la progression s’entend deux fois.',
    );
    assert.match(
      readFileSync(progress, 'utf8'),
      /Étape \{rank \+ 1\} sur \{total\}/u,
      '`tunnel-progress.tsx` n’écrit plus le compte en toutes lettres : la ' +
        'progression ne se lit plus qu’à la couleur d’un filet de 3 px (WCAG 1.4.1).',
    );
  });

  it('pose le titre de l’étape en `<h1>`, et le tunnel n’en a qu’un', () => {
    const source = readFileSync(progress, 'utf8');

    assert.match(
      source,
      /<h1\b/u,
      '`tunnel-progress.tsx` ne pose plus de titre de niveau 1 : la page du tunnel ' +
        'n’a plus de titre du tout depuis que le layout a cessé d’en porter un.',
    );

    const layout = readFileSync(
      join(here, '..', 'app', '(booking)', '[tenantSlug]', 'reservation', 'layout.tsx'),
      'utf8',
    );

    assert.equal(
      layout.includes('<h1'),
      false,
      'Le layout du tunnel pose de nouveau un `<h1>` : deux titres de niveau 1 se ' +
        'disputent la page, et celui du layout ne dit pas ce que l’étape demande ' +
        '(BM-TUNNEL-11).',
    );
  });
});

describe('Le tunnel n’est plus une carte dans une page (#1047)', () => {
  it('ne rend plus le panneau à fond creusé que l’audit a relevé', () => {
    assert.equal(
      booking.includes('spa-booking__panel'),
      false,
      '`booking.css` décrit de nouveau `.spa-booking__panel` : le tunnel redevient ' +
        'une carte grise posée dans la page, l’écart relevé par `d20260918-1`.',
    );
  });

  it('occupe la page sur le fond de surface', () => {
    assert.equal(
      valueOf('.spa-booking', 'background-color'),
      'var(--spa-color-surface)',
      '`.spa-booking` n’occupe plus la page sur le fond de surface.',
    );
    assert.equal(valueOf('.spa-booking', 'min-block-size'), '100dvh');
  });
});
