/*
 * Tunnel de réservation — rubriques, lignes de prestation et cartes de praticien
 * =============================================================================
 *
 * Issues #741 puis #1048. L'audit `d20260916-1` avait relevé un `<select>` dont
 * les options concaténaient nom, durée et prix ; #741 y a posé un `radiogroup`.
 * L'audit `d20260918-1` relève ce qui restait, au critère `ds:standard` :
 * *« trois cartes à rond radio sans regroupement par catégorie alors que la
 * vitrine en a deux »*, *« durée et prix collés sur la même ligne »*, *« à
 * 1280 px une seule colonne pleine largeur »*, et un praticien qui *« est une
 * `<select>` grisée »*. Quatre motifs du benchmark décrivent l'inverse
 * (`docs/design/benchmark/parcours-client.md`) : `BM-SERVICE-01`,
 * `BM-SERVICE-06`, `BM-PRATICIEN-01`, `BM-PRATICIEN-02`.
 *
 * Ce que cette suite tient, et rien d'autre : les propriétés de **feuille de
 * style** dont rien d'autre ne signale la disparition. `service-step.test.tsx`
 * éprouve la structure — des onglets de rubriques, un `radiogroup`, des cartes de
 * praticien, un bouton qui dit quoi faire — mais ne charge aucune feuille : une
 * grille redevenue à une colonne, une coche qui cesserait de paraître, ou un
 * bouton radio masqué au point de perdre le clavier compileraient, passeraient ce
 * test-là, et rouvriraient l'écart à l'identique. C'est le même partage que
 * `booking-summary-bar.test.mjs`.
 *
 * La preuve visuelle, elle, est au navigateur : phase de recette de #1048.
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

const serviceChoice = join(here, '..', 'components', 'booking', 'service-choice.tsx');
const staffChoice = join(here, '..', 'components', 'booking', 'staff-choice.tsx');
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

/** La liste d'une rubrique, et la ligne d'une prestation. */
const LISTE = 'spa-booking__services';
const LIGNE = 'spa-booking__service';
/** La rangée de praticiens, et la carte de l'un d'eux. */
const RANGEE = 'spa-booking__staff-row';
const CARTE = 'spa-booking__staff-option';

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));
/** La feuille sans ses paliers : la mise en page **nominale**, au pouce. */
const base = withoutMediaQueries(booking);

/**
 * Le contenu des blocs `@media` dont la condition est exactement `query`.
 *
 * `rulesFor` aplatit la feuille et ne distingue pas une règle de palier d'une
 * règle de base — c'est même le défaut contre lequel `withoutMediaQueries`
 * existe. Ici on veut l'inverse : lire **le palier**, puisque c'est de lui que
 * parle le critère d'acceptation (« à 1280 px deux colonnes »). L'accolade
 * fermante du bloc est reconnue à sa position en début de ligne, celle des règles
 * imbriquées étant indentée — même ruse que `withoutMediaQueries`.
 */
function atWidth(css, query) {
  return [...css.matchAll(/@media([^{]*)\{([\s\S]*?)\n\}/g)]
    .filter(([, prelude]) => prelude.trim() === query)
    .map(([, , body]) => body)
    .join('\n');
}

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

describe('Les prestations se comparent en lignes (#741, #1048)', () => {
  it('est un radiogroup, rendu par `service-choice.tsx`', () => {
    const source = readFileSync(serviceChoice, 'utf8');

    assert.match(
      source,
      /type="radio"/u,
      '`service-choice.tsx` ne rend plus de boutons radio : la sélection cesse ' +
        'd’être le `radiogroup` que `wireframes.md` prescrit à l’étape 1, et la ' +
        'navigation aux flèches disparaît avec lui.',
    );

    assert.match(
      source,
      new RegExp(`className="${LISTE}"`, 'u'),
      `\`service-choice.tsx\` ne porte plus \`${LISTE}\` : la liste des ` +
        'prestations n’est plus mise en page.',
    );
  });

  it('range les prestations par rubrique, avec le découpage de la vitrine', () => {
    const source = readFileSync(serviceChoice, 'utf8');

    // Le découpage n'est pas réécrit ici : `groupServicesByCategory` est déjà le
    // seul endroit où l'ordre du catalogue est décidé, et deux versions du même
    // rangement finiraient par montrer deux catalogues différents à la cliente
    // (vitrine puis tunnel).
    assert.match(
      source,
      /groupServicesByCategory/u,
      '`service-choice.tsx` ne groupe plus les prestations par rubrique : l’étape ' +
        'empile à nouveau tout le catalogue en une coulée, alors que la vitrine le ' +
        'range en rubriques (`BM-SERVICE-02`, audit `d20260918-1`).',
    );

    assert.match(
      source,
      /<Tabs\b/u,
      '`service-choice.tsx` ne monte plus `Tabs` : les rubriques cessent d’être ' +
        'une rangée d’onglets navigable au clavier (motif « tabs » de l’APG, #1044).',
    );
  });

  it('marque l’onglet de la rubrique retenue, par une coche et non par la couleur', () => {
    assert.match(
      readFileSync(serviceChoice, 'utf8'),
      /marked:/u,
      '`service-choice.tsx` ne marque plus l’onglet de la rubrique qui porte la ' +
        'prestation retenue : en changeant d’onglet, plus rien à l’écran ne ' +
        'rappelle qu’un choix est fait — l’écart exact de #1079 ' +
        '(`BM-SERVICE-06`, « la catégorie porte aussi la marque »).',
    );

    // La marque vit dans `tabs.css` et non dans `booking.css` : c'est une brique
    // du design system que la vitrine et l'espace client montent aussi.
    const mark = rulesFor(
      stripComments(readStyleSheet(styleSheetPath('components/tabs.css'))),
      '.spa-tabs__mark',
    ).join(' ');

    assert.notEqual(
      mark,
      '',
      'Aucune règle ne vise `.spa-tabs__mark` : la coche de l’onglet retenu n’est ' +
        'plus mise en page, et la marque se réduit à rien.',
    );

    // Un aplat plein, comme la coche d'une ligne retenue : c'est la **forme**
    // qui distingue l'onglet, la couleur ne faisant que l'accompagner
    // (WCAG 1.4.1).
    assert.equal(
      declaration(mark, 'background-color'),
      'var(--spa-color-accent)',
      'La pastille de la marque n’est plus un aplat d’accent : elle cesse de se ' +
        'lire comme la coche des lignes et des cartes du même écran (`booking.css`).',
    );
  });

  it('pose deux colonnes à partir de 48 rem, et une seule en dessous', () => {
    const rule = rulesFor(base, `.${LISTE}`).join(' ');

    assert.notEqual(rule, '', `Aucune règle de base ne vise \`.${LISTE}\`.`);

    assert.equal(
      declaration(rule, 'display'),
      'grid',
      'Les prestations ne sont plus en grille : « à 1280 px deux colonnes » ' +
        '(critère d’acceptation de #1048) n’est plus tenable.',
    );

    assert.equal(
      declaration(rule, 'grid-template-columns'),
      'minmax(0, 1fr)',
      'La liste ne tient plus sur une colonne au pouce : à 360 px, deux ' +
        'prestations côte à côte rendent le prix illisible.',
    );

    const palier = rulesFor(atWidth(booking, '(min-width: 48rem)'), `.${LISTE}`).join(' ');

    assert.equal(
      declaration(palier, 'grid-template-columns'),
      'repeat(2, minmax(0, 1fr))',
      'La liste ne passe plus à deux colonnes à 48 rem : c’est exactement ' +
        'l’écart relevé par l’audit — « à 1280 px une seule colonne pleine largeur » ' +
        '— et le premier critère d’acceptation de #1048.',
    );

    // Un `<fieldset>` porte `min-inline-size: min-content` dans la feuille de
    // l'agent utilisateur : sans cette remise à zéro, la boîte refuse de
    // descendre sous la largeur de son contenu le plus large et déborde du
    // panneau à 360 px.
    assert.equal(
      declaration(rule, 'min-inline-size'),
      '0',
      '`min-inline-size: 0` a disparu du `<fieldset>` des prestations : il reprend ' +
        'le `min-content` du navigateur et déborde du panneau sur un écran étroit.',
    );
  });

  it('laisse le texte d’une ligne passer à la ligne plutôt que déborder', () => {
    const main = rulesFor(base, `.${LIGNE}-main`).join(' ');

    assert.equal(
      declaration(main, 'min-inline-size'),
      '0',
      'Le corps d’une ligne ne peut plus se réduire : un mot plus long que la ' +
        'colonne — une description d’un seul tenant — pousse la ligne hors de la ' +
        'grille au lieu de passer à la ligne.',
    );

    const description = rulesFor(base, `.${LIGNE}-description`).join(' ');

    // `BM-SERVICE-04`, et la même borne que la vitrine : une description longue
    // ne repousse pas le prix de la prestation suivante hors de l'écran.
    assert.equal(
      declaration(description, 'line-clamp'),
      '2',
      'La description n’est plus bornée à deux lignes : une prestation bavarde ' +
        'repousse les suivantes, et deux lignes cessent d’être comparables ' +
        '(`BM-SERVICE-04`).',
    );

    const aside = rulesFor(base, `.${LIGNE}-aside`).join(' ');

    // Durée et prix ne sont plus dans la même boîte — c'est l'écart « 1 h
    // 85,00 € » relevé par l'audit. Au pouce, le prix tient sa propre ligne sous
    // le nom plutôt que de se serrer contre la durée.
    assert.equal(
      declaration(aside, 'inline-size'),
      '100%',
      'Le prix ne prend plus la largeur de la ligne au pouce : il se range contre ' +
        'la durée, et les deux se lisent comme un seul nombre — l’écart exact ' +
        'relevé par l’audit (« 1 h 85,00 € »).',
    );
  });

  it('marque la ligne retenue par une coche, et non par la seule couleur', () => {
    const selected = rulesFor(booking, `.${LIGNE}:has(.${LIGNE}-input:checked)`).join(' ');

    assert.notEqual(
      selected,
      '',
      'Plus aucune règle ne distingue la ligne retenue : la sélection cesse de se ' +
        'voir.',
    );

    // Le signal non chromatique que WCAG 1.4.1 exige en plus du cadre et du
    // fond, et que `BM-SERVICE-06` décrit — « son "+" devient une coche ». La
    // pastille du navigateur ne le porte plus : #1048 l'a décalée hors de
    // l'écran.
    const mark = rulesFor(booking, `.${LIGNE}-check-mark`).join(' ');

    assert.equal(
      declaration(mark, 'visibility'),
      'hidden',
      'La coche est visible sur toutes les lignes : elle ne distingue plus rien.',
    );

    const marked = rulesFor(
      booking,
      `.${LIGNE}:has(.${LIGNE}-input:checked) .${LIGNE}-check-mark`,
    ).join(' ');

    assert.equal(
      declaration(marked, 'visibility'),
      'visible',
      'La coche ne paraît plus sur la ligne retenue : l’état ne tient alors qu’à ' +
        'la couleur du cadre et du fond (WCAG 1.4.1, `BM-SERVICE-06`), et le ' +
        'troisième critère d’acceptation de #1048 tombe.',
    );
  });

  it('décale le bouton radio hors de l’écran sans le retirer du clavier', () => {
    const input = rulesFor(booking, `.${LIGNE}-input`).join(' ');

    assert.equal(
      declaration(input, 'position'),
      'absolute',
      'Le bouton radio n’est plus décalé hors de l’écran : la pastille du ' +
        'navigateur reparaît au milieu d’une ligne qui porte déjà sa coche.',
    );

    // `display: none` et `visibility: hidden` retireraient le contrôle de
    // l'ordre de tabulation, et avec lui le groupe, la position (« 2 sur 5 ») et
    // la navigation aux flèches — tout ce qu'un `radiogroup` natif donne pour
    // rien, et qu'il faudrait réécrire à la main.
    assert.equal(
      declaration(input, 'display'),
      null,
      'Le bouton radio est masqué par `display` : le `radiogroup` perd le clavier, ' +
        'et l’étape cesse d’être praticable sans souris (skill web-frontend §7).',
    );
    assert.equal(
      declaration(input, 'visibility'),
      null,
      'Le bouton radio est masqué par `visibility` : le `radiogroup` perd le ' +
        'clavier (skill web-frontend §7).',
    );

    const line = rulesFor(base, `.${LIGNE}`).join(' ');

    // Le contrôle décalé se mesure sur son référent positionné : sans lui,
    // l'`absolute` remonte jusqu'au bloc conteneur initial et le décalage porte
    // sur la page entière.
    assert.equal(
      declaration(line, 'position'),
      'relative',
      'La ligne n’est plus un référent positionné : le bouton radio décalé se ' +
        'place par rapport à la page et peut la faire déborder.',
    );
  });

  it('réserve à la barre collante la place qu’elle prend au défilement', () => {
    for (const cible of [LIGNE, CARTE]) {
      const rule = rulesFor(booking, `.${cible}`).join(' ');

      // Le navigateur amène l'élément focalisé à ras du bord bas de la fenêtre et
      // ne sait rien de ce qui le recouvre : sans cette marge, la dernière ligne
      // atteinte à la flèche bas arrive **sous** la barre d'action — constaté à
      // 360 px pendant la recette de #741.
      assert.ok(
        declaration(rule, 'scroll-margin-block-end') !== null,
        `\`.${cible}\` ne réserve plus la hauteur de la barre collante au ` +
          'défilement : le dernier élément atteint au clavier se retrouve à moitié ' +
          'caché derrière le CTA.',
      );
    }
  });

  it('rend le focus visible sur la ligne entière, et non sur le seul contrôle', () => {
    const focus = rulesFor(booking, `.${LIGNE}:has(.${LIGNE}-input:focus-visible)`).join(' ');

    assert.ok(
      declaration(focus, 'outline') !== null,
      'La ligne ne porte plus d’anneau de focus : le contrôle étant décalé hors de ' +
        'l’écran, plus rien ne montre où l’on est au clavier (skill web-frontend §7).',
    );
  });
});

describe('Le praticien se choisit en cartes (#1048, BM-PRATICIEN-01)', () => {
  it('a remplacé la liste déroulante de l’étape 1', () => {
    const source = readFileSync(serviceStep, 'utf8');

    assert.doesNotMatch(
      source,
      /<Select\b/u,
      '`service-step.tsx` remonte une liste déroulante : « le praticien se ' +
        'choisit sans liste déroulante, au clavier comme au doigt » est le ' +
        'deuxième critère d’acceptation de #1048.',
    );

    assert.match(
      source,
      /<StaffChoice\b/u,
      '`service-step.tsx` ne monte plus `StaffChoice` : le choix du praticien a ' +
        'disparu de l’étape.',
    );
  });

  it('est un radiogroup, avec une pastille par praticien', () => {
    const source = readFileSync(staffChoice, 'utf8');

    assert.match(
      source,
      /type="radio"/u,
      '`staff-choice.tsx` ne rend plus de boutons radio : le choix du praticien ' +
        'perd le groupe, la position et la navigation aux flèches.',
    );

    // `BM-PRATICIEN-02` — « un visage, sinon des initiales ». `Avatar` (#1044)
    // rend les secondes tant que le modèle de données ne porte pas de photo.
    assert.match(
      source,
      /<Avatar\b/u,
      '`staff-choice.tsx` ne rend plus de pastille : un praticien sans photo perd ' +
        'tout repère visuel (`BM-PRATICIEN-02`).',
    );

    // La pastille de « Premier disponible » loge un pictogramme et non des
    // initiales : elle ne passe pas par `Avatar`, mais elle demande ses classes
    // au même endroit (#1079). Recopiée, elle dériverait de toutes les autres au
    // premier renommage de classe.
    assert.match(
      source,
      /avatarClasses\(/u,
      '`staff-choice.tsx` ne demande plus ses classes à `avatarClasses()` : la ' +
        'pastille de « Premier disponible » retombe sur une chaîne recopiée, que ' +
        'le premier renommage de `.spa-avatar--*` laissera derrière (#1079).',
    );

    assert.doesNotMatch(
      source,
      /'spa-avatar spa-avatar--/u,
      '`staff-choice.tsx` recopie à nouveau les classes d’une pastille au lieu de ' +
        'les demander à `avatarClasses()` (`components/ui/avatar.tsx`, #1079).',
    );
  });

  it('défile horizontalement au pouce, et passe en grille dès 30 rem', () => {
    const rule = rulesFor(base, `.${RANGEE}`).join(' ');

    assert.equal(
      declaration(rule, 'overflow-x'),
      'auto',
      'La rangée de praticiens ne défile plus : à 360 px, trois cartes passent à ' +
        'la ligne et repoussent la liste des prestations hors de l’écran ' +
        '(direction de #1048).',
    );

    const palier = rulesFor(atWidth(booking, '(min-width: 30rem)'), `.${RANGEE}`).join(' ');

    assert.equal(
      declaration(palier, 'display'),
      'grid',
      'La rangée de praticiens ne passe plus en grille au-delà de 30 rem : elle ' +
        'garde un défilement horizontal là où toutes les cartes tiendraient.',
    );
  });

  it('marque le praticien retenu par une coche, et non par la seule couleur', () => {
    const mark = rulesFor(booking, `.${CARTE.replace('-option', '')}-check-mark`).join(' ');

    assert.equal(
      declaration(mark, 'visibility'),
      'hidden',
      'La coche est visible sur toutes les cartes de praticien : elle ne distingue ' +
        'plus rien.',
    );

    const marked = rulesFor(
      booking,
      `.${CARTE}:has(.spa-booking__staff-input:checked) .spa-booking__staff-check-mark`,
    ).join(' ');

    assert.equal(
      declaration(marked, 'visibility'),
      'visible',
      'La coche ne paraît plus sur le praticien retenu : l’état ne tient alors ' +
        'qu’à la couleur du cadre et du fond (WCAG 1.4.1).',
    );
  });
});
