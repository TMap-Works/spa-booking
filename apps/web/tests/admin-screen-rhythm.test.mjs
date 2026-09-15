/*
 * Back-office — le rythme vertical d'un écran enveloppé
 * =============================================================================
 *
 * Issue #700. La campagne de QA a relevé **0 px** entre les cartes empilées de
 * cinq écrans — /personnel, /catalogue, /catalogue/nouveau, la fiche d'une
 * prestation et /reporting — contre environ 17 px sur /catalogue/rubriques, pris
 * pour référence.
 *
 * La cause n'est pas une valeur d'espacement manquante, c'est la même que #633
 * une couche plus haut : `.spa-admin__content` écarte ses enfants **directs**,
 * et chaque écran du back-office rend une `<section aria-labelledby="…">` qui
 * réunit son titre, sa barre d'outils et ses cartes. L'enveloppe recevait la
 * gouttière pour elle seule ; ce qu'elle contient se rejoignait à 0 px.
 *
 * #633 avait corrigé **le balisage** de deux écrans, ce qui était tenable pour
 * deux. Ici c'est la forme de tous les écrans : les démonter reviendrait à
 * retirer la région nommée de chacun — donc son `aria-labelledby` — pour un
 * défaut d'espacement. La correction est donc **dans la feuille**, et cette suite tient
 * les deux moitiés de la preuve, comme `admin-catalog-rhythm` tient les siennes :
 *
 *   1. LA RÈGLE EXISTE ET DIT LE BON RYTHME. Une enveloppe nue est une colonne
 *      flex, dont la gouttière est exactement celle de la zone de contenu
 *      qu'elle intercepte — aux deux paliers, sans quoi le téléphone aurait deux
 *      rythmes selon qu'un écran s'enveloppe ou non.
 *
 *   2. LE BALISAGE LA LAISSE PASSER. La règle ne s'applique qu'à une `<section>`
 *      **sans classe** : c'est ce qui la distingue d'une carte, qui se met en
 *      page elle-même. Une classe posée demain sur l'enveloppe d'un écran
 *      rouvrirait le défaut sans qu'aucune feuille de style ne change — c'est la
 *      moitié qu'une revue humaine rate.
 *
 * Et une garde de non-régression : la règle ne doit pas être élargie à
 * `.spa-admin__content > section`, qui pèse plus lourd que `.spa-admin__section`
 * et écraserait la gouttière interne des cartes.
 *
 * La preuve visuelle est au navigateur — phase de recette de #700.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent, comme
 * pour les autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Racine du back-office, d'où partent les chemins d'écrans. */
const adminDir = join(here, '..', 'app', '(admin)', '[tenantSlug]', 'admin');

const shell = stripComments(readStyleSheet(styleSheetPath('admin/shell.css')));

/** L'enveloppe d'écran : une `<section>` qui ne met rien en page elle-même. */
const wrapper = '.spa-admin__content > section:not([class])';

/** La zone de contenu, dont l'enveloppe doit rendre le rythme à l'identique. */
const content = '.spa-admin__content';

/**
 * Le palier téléphone de `admin/shell.css`.
 *
 * L'accolade fermante est reconnue à sa position en début de ligne, celle des
 * règles imbriquées étant indentée — même ruse que `withoutMediaQueries`, dont
 * c'est ici l'opération complémentaire : cette suite-ci parle **aussi** des
 * paliers, puisque la gouttière de la zone de contenu y change de valeur et que
 * l'enveloppe doit la suivre.
 */
function mediaBlock(css, condition) {
  const found = new RegExp(
    `@media\\s*\\(${condition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(css);
  return found === null ? '' : found[1];
}

/** La valeur d'une propriété dans un bloc de déclarations, ou `null`. */
function declaration(body, property) {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  return found === null ? null : found[1].trim().replace(/\s+/g, ' ');
}

/** La gouttière déclarée par `selector` dans `css`, ou `null`. */
function gapOf(css, selector) {
  const body = rulesFor(css, selector).join(' ');
  return body === '' ? null : declaration(body, 'gap');
}

/**
 * Neutralise les commentaires d'un fichier TSX.
 *
 * Même parade que dans `admin-catalog-rhythm` : les écrans expliquent leur
 * balisage en nommant les balises et les classes en cause, et une recherche
 * menée sur le fichier brut y trouverait ce que le rendu ne contient pas.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

/**
 * Les attributs de la balise `<section>` qui porte `aria-labelledby="id"`.
 *
 * On lit les attributs plutôt que la balise entière, et on ne présume pas de
 * leur ordre : l'assertion porte sur l'absence de `className`, et non sur une
 * forme d'écriture exacte qu'un formateur pourrait légitimement redisposer.
 */
function regionAttributes(source, id) {
  const found = new RegExp(`<section\\b([^>]*\\baria-labelledby="${id}"[^>]*)>`).exec(source);
  return found === null ? null : found[1];
}

/**
 * Cette même balise est-elle **ce que l'écran rend**, et rien de plus haut ?
 *
 * L'absence de classe ne suffit pas : le sélecteur est un combinateur enfant, et
 * une enveloppe nue rangée dans un conteneur intermédiaire n'est plus fille de
 * `.spa-admin__content`. Ce n'est pas une hypothèse — c'est l'état de
 * `/reglages`, dont la page pose d'abord la borne de colonne de #630 et rend sa
 * région nommée dedans : la règle ne l'atteint pas, et une garde qui ne
 * regarderait que `className` la déclarerait pourtant conforme.
 *
 * On vérifie donc que la balise suit immédiatement le `return (` de l'écran, ce
 * qui la place à même la zone de contenu que le layout pose autour d'elle.
 */
function isScreenRoot(source, id) {
  return new RegExp(`return \\(\\s*<section\\b[^>]*\\baria-labelledby="${id}"`).test(source);
}

/**
 * Les cinq écrans que la campagne a mesurés en échec, avec l'identifiant de la
 * région que chacun nomme. Les huit autres écrans du back-office suivent la même
 * forme et gagnent la même gouttière — mais ce sont ces cinq-là que le ticket
 * doit prouver corrigés.
 */
const ecrans = [
  ['/personnel', join(adminDir, 'personnel', 'page.tsx'), 'personnel-titre'],
  ['/catalogue', join(adminDir, 'catalogue', 'page.tsx'), 'catalogue-titre'],
  ['/catalogue/nouveau', join(adminDir, 'catalogue', 'nouveau', 'page.tsx'), 'prestation-nouvelle'],
  [
    '/catalogue/[serviceId]',
    join(adminDir, 'catalogue', '[serviceId]', 'page.tsx'),
    'prestation-titre',
  ],
  ['/reporting', join(adminDir, 'reporting', 'page.tsx'), 'reporting-titre'],
];

describe('L’enveloppe nue d’un écran rend la gouttière de la zone de contenu', () => {
  it('l’empile en colonne', () => {
    const body = rulesFor(withoutMediaQueries(shell), wrapper).join(' ');

    assert.notEqual(
      body,
      '',
      `admin/shell.css ne déclare plus \`${wrapper}\` : les blocs d’un écran ` +
        'enveloppé redeviennent des blocs du flux normal, empilés à 0 px (#700).',
    );

    assert.equal(
      declaration(body, 'display'),
      'flex',
      `\`${wrapper}\` n'est plus une boîte flex — un \`gap\` n'y met rien en page.`,
    );

    assert.equal(
      declaration(body, 'flex-direction'),
      'column',
      `\`${wrapper}\` n'empile plus ses enfants en colonne : la barre d'outils, ` +
        'les cartes et le formulaire d’un écran se rangeraient en rangée.',
    );
  });

  for (const [condition, palier] of [
    [null, 'la mise en page nominale, celle du comptoir'],
    ['max-width: 30rem', 'le palier téléphone'],
  ]) {
    it(`pose la même valeur que la zone de contenu — ${palier}`, () => {
      const css = condition === null ? withoutMediaQueries(shell) : mediaBlock(shell, condition);

      assert.notEqual(
        css,
        '',
        `admin/shell.css ne porte plus de bloc \`@media (${condition})\`.`,
      );

      const attendu = gapOf(css, content);

      assert.ok(
        attendu !== null && /var\(\s*--spa-space-\d+\s*\)/.test(attendu),
        `\`${content}\` ne déclare plus de gouttière tirée de l’échelle ` +
          `d’espacement sur ${palier} : il n’y a plus de rythme à rendre.`,
      );

      assert.equal(
        gapOf(css, wrapper),
        attendu,
        `\`${wrapper}\` et \`${content}\` n’écartent plus leurs blocs de la même ` +
          `valeur sur ${palier}. L’enveloppe est transparente : un écran qui ` +
          's’enveloppe et un écran qui rend un fragment — /catalogue/apercu — ' +
          'auraient deux rythmes différents (#700).',
      );
    });
  }

  it('ne déborde pas sur les cartes, qui tiennent leur propre gouttière', () => {
    // `.spa-admin__content > section` pèse 0,1,1 contre 0,1,0 pour
    // `.spa-admin__section` : élargi, le sélecteur écraserait la gouttière
    // interne des cartes — 16 px là où la densité du comptoir veut 12 — et
    // atteindrait la carte de connexion, posée à même la zone de contenu (#699).
    //
    // La feuille est lue **entière**, paliers compris : c'est la seule assertion
    // de cette suite qui n'affirme rien d'un palier en particulier, et un
    // élargissement glissé sous `@media` écraserait les cartes à cette largeur-là
    // sans que le filtre le laisse voir (l'aplatissement décrit dans `tokens.mjs`
    // joue ici en notre faveur).
    assert.equal(
      rulesFor(shell, '.spa-admin__content > section').length,
      0,
      'La règle du rythme d’écran vise désormais toute `<section>` fille de la ' +
        'zone de contenu, et non plus la seule enveloppe sans classe : elle ' +
        'écrase la gouttière de `.spa-admin__section` (#700).',
    );

    assert.equal(
      gapOf(withoutMediaQueries(shell), '.spa-admin__section'),
      'var(--spa-space-3)',
      '`.spa-admin__section` n’écarte plus ses enfants de `--spa-space-3` : la ' +
        'carte et l’écran qui la porte n’ont pas le même rythme, et les ' +
        'confondre densifie ou dilate l’un des deux (#633, #700).',
    );
  });
});

describe('Le reporting ne rattrape plus la gouttière à la main', () => {
  /*
   * Deux blocs de `/reporting` portaient `margin-block-end: var(--spa-space-6)` :
   * la barre de filtres et la grille d'indicateurs. Ce n'était pas un écart
   * voulu de 24 px, c'était le rattrapage d'une gouttière qui n'arrivait pas —
   * les deux seules coutures non nulles de cet écran. La gouttière rendue, la
   * marge s'ajoutait à elle : ~40 px à ces deux coutures contre 16 partout
   * ailleurs, soit l'irrégularité déplacée plutôt que corrigée.
   */
  const reporting = stripComments(readStyleSheet(styleSheetPath('admin/reporting.css')));

  for (const selector of ['.spa-admin-report-filters', '.spa-admin-report-metrics']) {
    it(`\`${selector}\` laisse l’écran l’espacer`, () => {
      const body = rulesFor(withoutMediaQueries(reporting), selector).join(' ');

      assert.notEqual(body, '', `admin/reporting.css ne déclare plus \`${selector}\`.`);

      for (const property of ['margin-block-end', 'margin-block', 'margin']) {
        assert.equal(
          declaration(body, property),
          null,
          `\`${selector}\` reprend une \`${property}\` : elle s’ajoute à la ` +
            'gouttière de l’écran au lieu de la remplacer, et rouvre à cet ' +
            'endroit précis l’irrégularité que #700 referme.',
        );
      }
    });
  }
});

describe('Le balisage des écrans laisse passer cette gouttière', () => {
  for (const [ecran, fichier, region] of ecrans) {
    it(`${ecran} enveloppe son contenu dans une \`<section>\` sans classe`, () => {
      const source = withoutComments(readFileSync(fichier, 'utf8'));
      const attributs = regionAttributes(source, region);

      assert.notEqual(
        attributs,
        null,
        `${ecran} ne rend plus de \`<section aria-labelledby="${region}">\`. Si ` +
          'la région a changé de nom, mettre à jour cette suite ; si elle a ' +
          'disparu, le `<h1>` de l’écran ne nomme plus rien (web-frontend §7).',
      );

      assert.doesNotMatch(
        attributs,
        /\bclassName=/,
        `L’enveloppe de ${ecran} porte désormais une classe : \`${wrapper}\` ne ` +
          'l’atteint plus, et ses cartes se rejoignent de nouveau à 0 px. Une ' +
          'enveloppe qui doit se mettre en page elle-même reprend la gouttière ' +
          'à son compte — `display: flex`, `flex-direction: column`, ' +
          '`gap: var(--spa-space-4)` — plutôt que de la perdre en silence (#700).',
      );

      assert.ok(
        isScreenRoot(source, region),
        `L’enveloppe de ${ecran} n’est plus ce que l’écran rend : un conteneur ` +
          's’est glissé entre elle et `.spa-admin__content`. Le combinateur ' +
          `enfant de \`${wrapper}\` ne l’atteint plus, et ses blocs se ` +
          'rejoignent de nouveau à 0 px — c’est exactement ce qui prive ' +
          '/reglages de cette gouttière (#700).',
      );
    });
  }
});
