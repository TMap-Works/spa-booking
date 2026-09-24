/*
 * Indicateurs d'activité — l'alignement de la barre de filtres
 * =============================================================================
 *
 * Issues #628 puis #656. La campagne de QA a relevé, sur `/…/admin/reporting`,
 * une barre de filtres en escalier : le sélecteur « Filtrer » posé 26 px
 * au-dessus de celui de « Période », et, en période personnalisée, quatre champs
 * répartis sur deux hauteurs séparées de 47 px.
 *
 * Ces deux chiffres ne sont pas des accidents de rendu, ce sont des sommes de
 * jetons. Sous `align-items: flex-end`, tout ce qui pend sous un contrôle le
 * remonte d'autant : une ligne de phrase d'aide vaut
 * `--spa-font-size-sm × --spa-line-height-normal` = 21,7 px, plus la gouttière
 * `--spa-space-1` du champ, soit 25,7 px — les 26 px relevés. Deux lignes
 * d'aide, celles que « Au (inclus) » et « Filtrer » enroulent en période
 * personnalisée, en font 47,4 px — les 47 px relevés.
 *
 * Le piège, et la raison d'être de cette suite : `flex-end` **paraît** être le
 * bon choix, et l'était tant qu'aucun champ de la barre ne portait d'aide. Le
 * commentaire d'origine le défendait même explicitement. Un contributeur qui
 * ajoute une phrase d'aide à un cinquième champ, ou qui rétablit l'alignement
 * bas « pour caler les contrôles », rouvre le bug à l'identique — et rien ne
 * l'en avertit : la page compile, la barre s'affiche.
 *
 * ## Ce que #656 y a ajouté
 *
 * Rendre au bouton la ligne d'étiquette qu'il n'a pas le pose à la hauteur des
 * champs tant qu'il **partage leur ligne**. Le même décalage devient ~26 px de
 * vide dès que l'enroulement le laisse seul en tête de sa propre ligne : il n'a
 * alors plus d'étiquette voisine à rattraper. Aucune écriture de ce décalage ne
 * s'en tire — marge ou vraie ligne d'étiquette vide occupent la même hauteur
 * dans la ligne flex, et CSS n'offre aucun sélecteur pour « premier élément
 * d'une ligne flex ».
 *
 * Ce qui se tient, c'est donc la cause : **le bouton n'est plus un élément de la
 * barre**. Le dernier champ et lui n'en forment qu'un, insécable, qui s'enroule
 * d'un bloc — une ligne ouverte par ce couple commence toujours par
 * l'étiquette « Filtrer ». L'invariant a deux moitiés, et les deux se perdent
 * en silence : le balisage qui groupe (`report-filters.tsx`) et le
 * `flex-wrap: nowrap` qui interdit au couple de se rompre (`reporting.css`).
 * Séparées, elles rouvrent le défaut sans qu'aucune page cesse de compiler.
 *
 * ## Ce que #678 y a ajouté
 *
 * Une troisième moitié, si l'on veut : `mockups/admin/reporting.html`. La
 * maquette montrait encore le bouton nu au bout de la barre — elle se peignait
 * juste, la règle du bouton étant écrite en descendant, mais elle rejouait le
 * défaut dans la bande où le bouton s'isole, et surtout **aucune maquette
 * n'exerçait les trois règles du couple**.
 *
 * Cette dernière lacune ne se comble pas dans `admin-mockups.test.mjs` : son
 * garde-fou raisonne sur les classes — aucune classe inventée, aucun style admin
 * sans maquette qui l'emploie — et le couple n'a volontairement pas de classe à
 * lui. Un sélecteur sans classe propre lui échappe par construction. C'est donc
 * ici, avec le reste de l'invariant, que le groupement de la maquette se tient.
 *
 * Cette suite ne mesure pas un rendu : elle tient les invariants dont le rendu
 * découle. La preuve visuelle, elle, est au navigateur : phase de recette de
 * #628 et de #656, à 1280, 768 et 360 px, en période simple et personnalisée,
 * plus la bande ~800-900 px où le bouton s'isolait. Celle de #678 a repris la
 * maquette à 850, 736, 480 et 344 px de largeur de contenu — 480 px est sa
 * propre bande d'isolement, la barre n'y portant que deux champs, et le bouton
 * y reste désormais sur la ligne de « Filtrer ».
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readStyleSheet, rulesFor, stripComments, styleSheetPath } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** La feuille des indicateurs d'activité, commentaires neutralisés. */
const reporting = stripComments(readStyleSheet(styleSheetPath('admin/reporting.css')));

/*
 * Le source de la barre de filtres, ses commentaires neutralisés — même raison
 * qu'en #636 pour le récapitulatif de réservation : la prose qui explique le
 * groupement cite le balisage qu'elle décrit, et l'assertion échouerait sur le
 * commentaire qui la justifie.
 */
const filters = stripComments(
  readFileSync(
    join(here, '..', 'app', '(admin)', '[tenantSlug]', 'admin', 'components', 'report-filters.tsx'),
    'utf8',
  ),
);

/**
 * Neutralise les commentaires HTML, en blancs de même longueur.
 *
 * Locale et non partagée : `support/tokens.mjs` est un lecteur de **CSS**, et y
 * monter de quoi lire du HTML sortait de l'empreinte de #678.
 * `admin-mockups.test.mjs` en porte la même dizaine de caractères, pour la même
 * raison qu'ici — la prose d'une maquette cite le balisage qu'elle décrit.
 */
const stripHtmlComments = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));

/** La barre de filtres de la maquette, commentaires neutralisés. */
const mockupFilters = (() => {
  const html = stripHtmlComments(
    readFileSync(join(here, '..', 'mockups', 'admin', 'reporting.html'), 'utf8'),
  );
  const bar = html.match(/<form class="spa-admin-report-filters">([\s\S]*?)<\/form>/);

  assert.notEqual(
    bar,
    null,
    'mockups/admin/reporting.html ne porte plus de `<form class="spa-admin-report-filters">`. ' +
      'C’est la seule maquette qui exerce les règles du couple (#678).',
  );

  return bar[1];
})();

/** Le couple « Filtrer » + « Afficher », tel que la feuille le désigne. */
const PAIR = '.spa-admin-report-filters > div:has(> button)';

/*
 * `rulesFor` — les blocs de déclarations des règles dont la liste de sélecteurs
 * contient **exactement** le sélecteur demandé — vit dans `support/tokens.mjs`
 * depuis #657, et l'égalité stricte y est justifiée une fois pour toutes. Pour
 * cette barre-ci, elle empêche `.spa-admin-report-filters` d'attraper aussi la
 * règle du bouton : un `align-items` déplacé de l'une à l'autre laisserait
 * l'assertion verte alors que la barre aurait changé de comportement.
 */

describe('La barre de filtres aligne ses libellés en haut', () => {
  it('déclare un alignement de la barre', () => {
    const rules = rulesFor(reporting, '.spa-admin-report-filters');

    assert.notDeepEqual(rules, [], 'aucune règle ne vise `.spa-admin-report-filters`.');
    assert.match(
      rules.join(' '),
      /align-items\s*:/,
      '`.spa-admin-report-filters` ne déclare plus d’alignement : un conteneur ' +
        'flex s’aligne alors par étirement, et les champs porteurs d’une phrase ' +
        'd’aide reprennent une hauteur propre (#628).',
    );
  });

  it('s’aligne par le haut, jamais par le bas ni sur la ligne de base', () => {
    // Le cœur du correctif. `flex-end` remonte chaque champ de la hauteur de ce
    // qui pend sous son contrôle ; `baseline` aligne les premières lignes de
    // texte, c'est-à-dire les étiquettes, et laisse les contrôles se décaler
    // dès que deux étiquettes n'ont pas la même hauteur.
    for (const rule of rulesFor(reporting, '.spa-admin-report-filters')) {
      for (const [, value] of rule.matchAll(/align-items\s*:\s*([^;]+)/g)) {
        assert.match(
          value.trim(),
          /^flex-start$/,
          `\`.spa-admin-report-filters\` s’aligne en « ${value.trim()} ». Seul ` +
            '`flex-start` fait tomber le bord haut de chaque contrôle au même ' +
            'endroit : les quatre étiquettes de la barre partagent la même ' +
            'typographie, alors que ce qui pend sous les contrôles — phrase ' +
            'd’aide, message de refus — ne fait jamais la même hauteur. ' +
            '`flex-end` rouvre l’escalier de 26 px en période simple et de 47 px ' +
            'en période personnalisée (#628), et `end` remonte en avertissement ' +
            'de compilation chez autoprefixer.',
        );
      }
    }
  });
});

describe('Le bouton « Afficher » se pose sur la rangée des champs', () => {
  const button = rulesFor(reporting, '.spa-admin-report-filters button');

  it('atteint le bouton où qu’il se trouve dans la barre', () => {
    // Un enfant direct — `.spa-admin-report-filters > button` — ne l'atteint
    // plus du tout : l'application pose le bouton dans le couple « Filtrer »
    // depuis #656, et la maquette depuis #678. Le sélecteur doit rester
    // descendant.
    assert.notDeepEqual(
      button,
      [],
      'aucune règle ne vise `.spa-admin-report-filters button`. Un sélecteur ' +
        'restreint à l’enfant direct n’atteint plus le bouton, que ' +
        '`report-filters.tsx` (#656) comme `mockups/admin/reporting.html` ' +
        '(#678) groupent avec le champ « Filtrer » : le bouton perdrait alors ' +
        'son décalage, et se laisserait écraser par le champ dans un couple ' +
        'qui se comprime sous sa base.',
    );
  });

  it('rattrape la ligne d’étiquette qu’il n’a pas', () => {
    // Sans étiquette au-dessus de lui, un bouton aligné par le haut se pose à la
    // hauteur des **mots** « Période » et « Filtrer », pas à celle des champs :
    // l'escalier change de sens au lieu de disparaître.
    assert.match(
      button.join(' '),
      /margin-block-start\s*:\s*calc\([^)]*\)/,
      '`.spa-admin-report-filters button` n’est plus décalé : aligné par le ' +
        'haut sans étiquette, il remonte à la hauteur des libellés et se ' +
        'désaligne des champs qu’il commande (#628).',
    );
  });

  it('écrit ce décalage avec les jetons qui composent une étiquette', () => {
    // Un `1.6rem` posé à la main tiendrait aujourd'hui et mentirait au premier
    // jeton typographique qui bouge — le bouton dériverait alors seul, sans
    // qu'aucun test ne s'en aperçoive.
    const offset = button.join(' ');

    for (const token of ['--spa-font-size-sm', '--spa-line-height-normal', '--spa-space-1']) {
      assert.match(
        offset,
        new RegExp(`var\\(\\s*${token}\\s*\\)`),
        `le décalage du bouton n’emploie plus ${token}. Il vaut une ligne ` +
          'd’étiquette — corps `--spa-font-size-sm`, hauteur de ligne ' +
          '`--spa-line-height-normal` — plus la gouttière `--spa-space-1` que ' +
          '`.spa-field` et `.spa-select` posent entre étiquette et contrôle. ' +
          'Exprimé autrement, il cesse de suivre les jetons qu’il rattrape.',
      );
    }
  });
});

describe('Le bouton « Afficher » n’ouvre jamais une ligne à lui seul', () => {
  it('voyage avec le champ « Filtrer » dans un même élément de la barre', () => {
    // La moitié « balisage » de l'invariant. Sorti de ce groupe, le bouton
    // redevient un élément de la barre : il s'enroule seul dès que les champs
    // de la dernière ligne tiennent sans lui — la bande ~800-900 px en période
    // personnalisée — et sa marge d'étiquette devient ~26 px de vide (#656).
    // L'étiquette vient du catalogue depuis #851 : le motif désigne donc la
    // **clé** du message (`filters.scope`) et non le mot français, qui n'est
    // plus dans le fichier. L'invariant, lui, est inchangé — c'est le groupe qui
    // compte, pas la langue du libellé.
    assert.match(
      filters,
      /<div>\s*<Select[\s\S]*?label=\{t\('filters\.scope'\)\}[\s\S]*?<\/Select>\s*<Button[\s\S]*?<\/Button>\s*<\/div>/,
      'report-filters.tsx ne groupe plus le sélecteur « Filtrer » et le bouton ' +
        '« Afficher » dans un même `<div>`. C’est ce groupe, et lui seul, qui ' +
        'empêche le bouton d’ouvrir une ligne sans étiquette au-dessus de lui ' +
        '(#656) — aucune écriture de son décalage ne s’en charge à sa place.',
    );
  });

  it('n’a qu’un bouton, celui du couple', () => {
    // Un second bouton posé ailleurs dans la barre rouvrirait le défaut sans
    // rien casser de l'assertion précédente, qui ne regarde que le couple.
    assert.equal(
      (filters.match(/<[Bb]utton\b/g) ?? []).length,
      1,
      'la barre de filtres porte plus d’un bouton. Tout bouton hors du couple ' +
        '« Filtrer » s’enroule seul en tête de ligne, avec la marge qui lui ' +
        'rend sa ligne d’étiquette — c’est le vide de #656.',
    );
  });

  it('déclare le couple comme une rangée qui ne se rompt pas', () => {
    // La moitié « style » de l'invariant. Sans `nowrap`, le couple se coupe
    // sous la pression et le bouton retombe sous le champ, avec sa marge :
    // exactement le défaut qu'on retire, à une largeur de moins.
    const pair = rulesFor(reporting, PAIR);

    assert.notDeepEqual(pair, [], `aucune règle ne vise \`${PAIR}\`.`);
    assert.match(
      pair.join(' '),
      /flex-wrap\s*:\s*nowrap/,
      `\`${PAIR}\` ne déclare plus \`flex-wrap: nowrap\`. Le couple se romprait ` +
        'sous la pression, et le bouton reprendrait sa ligne — avec les ~26 px ' +
        'de vide de #656 au-dessus de lui.',
    );
    assert.match(
      pair.join(' '),
      /align-items\s*:\s*flex-start/,
      `\`${PAIR}\` n’aligne plus son contenu par le haut. Un conteneur flex ` +
        'étire ses éléments par défaut : le bouton prendrait la hauteur du ' +
        'champ, phrase d’aide comprise.',
    );
  });

  it('rend au champ du couple la base qu’il avait dans la barre', () => {
    // `.spa-admin-report-filters > *` ne l'atteint plus : le champ n'est plus un
    // enfant direct de la barre. Sans base propre, il retombe sur `flex: 0 1
    // auto` et le couple cesse de s'enrouler comme un champ de la barre.
    const field = rulesFor(reporting, `${PAIR} > .spa-select`);

    assert.notDeepEqual(field, [], `aucune règle ne vise \`${PAIR} > .spa-select\`.`);
    assert.match(
      field.join(' '),
      /flex\s*:\s*1\s+1\s+12rem/,
      `\`${PAIR} > .spa-select\` ne reprend plus la base \`1 1 12rem\` des ` +
        'champs de la barre. Sorti de l’enfance directe, il ne l’hérite plus de ' +
        '`.spa-admin-report-filters > *`, et le couple s’enroulerait sur la ' +
        'largeur de ses options plutôt que sur celle d’un champ.',
    );
  });
});

describe('La maquette montre le couple, et non la barre plate', () => {
  /*
   * #678. Ce n'est pas une redite du groupement de `report-filters.tsx` : c'est
   * l'autre moitié du même contrat. La maquette est ce qu'un contributeur ouvre
   * pour voir l'écran, et c'est aussi la **seule** à exercer les trois règles du
   * couple — rien d'autre sous `mockups/` ne porte de bouton dans cette barre.
   *
   * Le garde-fou d'`admin-mockups.test.mjs` ne peut pas le tenir à sa place : il
   * vérifie que toute classe employée est déclarée et que tout style admin est
   * employé quelque part, et le couple n'a volontairement pas de classe. Les
   * règles peuvent donc pourrir sans que rien ne le signale — sauf ici.
   */
  it('groupe « Filtrer » et « Afficher » dans un même élément sans classe', () => {
    assert.match(
      mockupFilters,
      /<div>\s*<div class="spa-select">[\s\S]*?>Filtrer<\/label>[\s\S]*?<\/div>\s*<button\b[\s\S]*?<\/button>\s*<\/div>/,
      'mockups/admin/reporting.html ne groupe plus le sélecteur « Filtrer » et ' +
        'le bouton « Afficher » dans un même `<div>` sans classe. La maquette ' +
        'rejoue alors le vide de ~26 px au-dessus du bouton dans la bande où ' +
        'l’enroulement l’isole — vers 480 px de largeur de contenu pour ses deux ' +
        'champs, mesuré en recette de #678 — et les règles `' +
        PAIR +
        '` cessent d’être exercées par la moindre maquette. Le `<div>` est nu à ' +
        'dessein : c’est le bouton qu’il porte qui le désigne.',
    );
  });

  it('n’a qu’un bouton dans la barre, celui du couple', () => {
    // Même raison que côté `report-filters.tsx` : un second bouton posé
    // ailleurs dans la barre s'enroulerait seul en tête de ligne, avec la marge
    // qui lui rend sa ligne d'étiquette. L'assertion précédente ne regarde que
    // le couple et ne le verrait pas.
    assert.equal(
      (mockupFilters.match(/<button\b/g) ?? []).length,
      1,
      'la barre de filtres de mockups/admin/reporting.html porte plus d’un ' +
        'bouton. Tout bouton hors du couple « Filtrer » rouvre le vide de #656 ' +
        'au-dessus de lui.',
    );
  });
});
