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
 * ## Ce que #718 y a ajouté
 *
 * Le combinateur enfant laissait `/reglages` de côté — sa page range sa région
 * nommée dans la borne de colonne de #630 —, et la couture titre / premier champ
 * y mesurait **20 px** contre 16 partout ailleurs. Ces 20 px n'étaient pas une
 * gouttière manquante mais un *remplissage* de trop : le `<form>` emprunte
 * `.spa-admin__content` pour sa gouttière et hérite du remplissage de la
 * coquille. Deux moitiés à prouver, comme au-dessus — l'enveloppe rangée sous la
 * borne rend le même rythme que les autres, et le conteneur imbriqué n'apporte
 * que sa gouttière. `/catalogue/rubriques`, qui emprunte la même classe autour de
 * `CategoryManager`, s'en trouve corrigé du même geste : ses cartes cessent d'être
 * insérées de 20 px sur le titre et la barre d'outils de l'écran.
 *
 * La preuve visuelle est au navigateur — phase de recette de #700 et de #718.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent, comme
 * pour les autres suites de style de ce dossier. Les lecteurs de règles et de
 * déclarations viennent tous deux de `support/tokens.mjs` (#683, #713, #722) —
 * cette suite n'en porte plus aucune copie. `mediaBlock()` lui reste propre sans
 * dette : elle est la seule à parler des paliers, et il n'en existe pas de second
 * exemplaire à rassembler. Le seul doublon qui subsiste ici est `withoutComments()`,
 * repris à l'identique dans `admin-catalog-rhythm` — il neutralise des commentaires
 * TSX, pas des règles CSS, et sortirait donc de `support/tokens.mjs` ; sa
 * consolidation reste à ouvrir.
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

/** Racine du back-office, d'où partent les chemins d'écrans. */
const adminDir = join(here, '..', 'app', '(admin)', '[tenantSlug]', 'admin');

const shell = stripComments(readStyleSheet(styleSheetPath('admin/shell.css')));

/** L'enveloppe d'écran : une `<section>` qui ne met rien en page elle-même. */
const wrapper = '.spa-admin__content > section:not([class])';

/**
 * La même enveloppe, rangée sous la borne de colonne de #630 (#718).
 *
 * `/reglages` est le seul écran dans ce cas : sa page pose d'abord le
 * `<div class="spa-admin-form">` qui borne sa colonne — titre compris, sans quoi
 * le `<h1>` et les champs ne s'aligneraient plus sur le même bord — et rend sa
 * région nommée dedans. Le combinateur enfant de `wrapper` ne l'atteint donc pas,
 * et son titre restait collé à son premier champ.
 *
 * Le sélecteur descend d'un cran **nommément**, par la borne : un combinateur
 * descendant rattraperait la moindre `<section>` nue posée au fond d'une carte.
 */
const borne = '.spa-admin__content > .spa-admin-form > section:not([class])';

/**
 * Les deux formes de l'enveloppe nue. Elles rendent le même rythme, ou l'écran
 * rangé sous une borne de colonne a le sien.
 */
const enveloppes = [
  [wrapper, 'à même la zone de contenu'],
  [borne, 'sous la borne de colonne — /reglages'],
];

/** La zone de contenu, dont l'enveloppe doit rendre le rythme à l'identique. */
const content = '.spa-admin__content';

/**
 * La zone de contenu **empruntée une couche plus bas** (#718).
 *
 * Deux écrans rangent leurs blocs sous un conteneur intermédiaire qui reprend la
 * classe de la coquille pour sa gouttière : le `<form>` de `TenantSettingsForm`
 * et le `<div>` de `CategoryManager`. La classe portant aussi le remplissage de
 * la coquille, ces blocs se retrouvaient insérés de 20 px sur ce qui les
 * surplombe.
 */
const nested = '.spa-admin__content .spa-admin__content';

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
 * `.spa-admin__content`. Ce n'était pas une hypothèse — c'était l'état de
 * `/reglages`, dont la page pose d'abord la borne de colonne de #630 et rend sa
 * région nommée dedans : la règle ne l'atteignait pas, et une garde qui ne
 * regarderait que `className` l'aurait pourtant déclarée conforme. #718 lui a
 * donné son propre sélecteur, `borne`, qui nomme cette imbrication-là — la
 * fonction sert donc les deux, chacune relativement à ce qui la contient.
 *
 * On vérifie que la balise suit immédiatement le `return (` du fichier, ce qui la
 * place à même le conteneur que son appelant pose autour d'elle : la zone de
 * contenu pour un écran, la borne de colonne pour `TenantSettingsForm`.
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
  ['/personnel', join(adminDir, 'personnel', '(liste)', 'page.tsx'), 'personnel-titre'],
  ['/catalogue', join(adminDir, 'catalogue', '(liste)', 'page.tsx'), 'catalogue-titre'],
  ['/catalogue/nouveau', join(adminDir, 'catalogue', 'nouveau', 'page.tsx'), 'prestation-nouvelle'],
  [
    '/catalogue/[serviceId]',
    join(adminDir, 'catalogue', '[serviceId]', 'page.tsx'),
    'prestation-titre',
  ],
  ['/reporting', join(adminDir, 'reporting', 'page.tsx'), 'reporting-titre'],
];

describe('L’enveloppe nue d’un écran rend la gouttière de la zone de contenu', () => {
  for (const [selector, ou] of enveloppes) {
    it(`l’empile en colonne — ${ou}`, () => {
      const body = rulesFor(withoutMediaQueries(shell), selector).join(' ');

      assert.notEqual(
        body,
        '',
        `admin/shell.css ne déclare plus \`${selector}\` : les blocs d’un écran ` +
          'enveloppé redeviennent des blocs du flux normal, empilés à 0 px (#700).',
      );

      assert.equal(
        declaration(body, 'display'),
        'flex',
        `\`${selector}\` n'est plus une boîte flex — un \`gap\` n'y met rien en page.`,
      );

      assert.equal(
        declaration(body, 'flex-direction'),
        'column',
        `\`${selector}\` n'empile plus ses enfants en colonne : la barre d'outils, ` +
          'les cartes et le formulaire d’un écran se rangeraient en rangée.',
      );
    });
  }

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

      for (const [selector, ou] of enveloppes) {
        assert.equal(
          gapOf(css, selector),
          attendu,
          `\`${selector}\` et \`${content}\` n’écartent plus leurs blocs de la ` +
            `même valeur sur ${palier} (enveloppe ${ou}). L’enveloppe est ` +
            'transparente : un écran qui s’enveloppe et un écran qui rend un ' +
            'fragment — /catalogue/apercu — auraient deux rythmes différents ' +
            '(#700, #718).',
        );
      }
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

describe('La zone de contenu empruntée une couche plus bas n’apporte que sa gouttière', () => {
  /*
   * #718. `/reglages` mesurait **20 px** entre son `<h1>` et le champ « Nom de
   * l'établissement », là où les coutures suivantes du même écran valent 16. Ce
   * qui les sépare n'est pas une gouttière : c'est le *remplissage*
   * (`--spa-space-5`) que la classe de la coquille apporte au `<form>` qui
   * l'emprunte. Le même remplissage insère les cartes de `CategoryManager` de
   * 20 px sur le titre et la barre d'outils de `/catalogue/rubriques`.
   *
   * La correction ne peut pas consister à retirer la classe de ce conteneur :
   * elle lui retirerait la gouttière **avec** le remplissage, et les sept blocs
   * du formulaire se rejoindraient à 0 px — le défaut de #700 rouvert sur cet
   * écran. C'est donc la feuille qui distingue les deux emplois de la classe.
   */
  it('neutralise le remplissage de la coquille', () => {
    const body = rulesFor(withoutMediaQueries(shell), nested).join(' ');

    assert.notEqual(
      body,
      '',
      `admin/shell.css ne déclare plus \`${nested}\` : un conteneur qui emprunte ` +
        'la classe de la coquille pour sa gouttière reprend du même geste son ' +
        'remplissage, et insère ses blocs de 20 px sur ce qui les surplombe (#718).',
    );

    assert.equal(
      declaration(body, 'padding'),
      '0',
      `\`${nested}\` ne remet plus le remplissage à zéro. La coquille en a besoin ` +
        '— c\'est elle qui décolle le contenu du rail et du bandeau —, un ' +
        'conteneur imbriqué n’en a que faire : il n’emprunte la classe que pour ' +
        'sa gouttière (#718).',
    );
  });

  it('n’en redéclare pas au palier téléphone', () => {
    const body = rulesFor(mediaBlock(shell, 'max-width: 30rem'), nested).join(' ');

    for (const property of ['padding', 'padding-block', 'padding-inline']) {
      assert.equal(
        declaration(body, property),
        null,
        `\`${nested}\` reprend une \`${property}\` au palier téléphone : le ` +
          'défaut de #718 rouvre à cette largeur-là, où la règle nominale ne le ' +
          'laisse pas voir.',
      );
    }
  });

  it('laisse la gouttière du palier courant lui parvenir', () => {
    // La feuille est lue **entière** : une gouttière redéclarée ici, fût-ce sous
    // un palier, figerait le conteneur imbriqué sur une valeur à lui. Il doit
    // rendre celle que `.spa-admin__content` porte au palier courant — 16 px au
    // comptoir, 12 au téléphone —, faute de quoi `/reglages` aurait deux rythmes
    // dans le même écran : celui du titre et celui des champs.
    assert.equal(
      gapOf(shell, nested),
      null,
      `\`${nested}\` redéclare une gouttière au lieu d’hériter de celle du ` +
        'palier courant : les blocs du formulaire et ceux de l’écran qui le porte ' +
        'cessent de suivre le même rythme (#718).',
    );
  });
});

describe('Les deux écrans qui empruntent la zone de contenu une couche plus bas', () => {
  /** Les composants du back-office, où vivent les deux conteneurs en cause. */
  const composants = join(adminDir, 'components');

  const reglages = withoutComments(
    readFileSync(join(composants, 'tenant-settings-form.tsx'), 'utf8'),
  );

  it('/reglages rend sa région nommée sous la borne de colonne de #630', () => {
    const page = withoutComments(readFileSync(join(adminDir, 'reglages', 'page.tsx'), 'utf8'));

    assert.match(
      page,
      /<div className="spa-admin-form">\s*<TenantSettingsForm/,
      '/reglages ne rend plus `<TenantSettingsForm>` à même sa borne de colonne. ' +
        `Le sélecteur \`${borne}\` désigne cette imbrication précise : un ` +
        'conteneur de plus, ou un de moins, et le titre de l’écran retombe à ' +
        '0 px de son premier champ (#630, #718).',
    );
  });

  it('/reglages enveloppe son contenu dans une `<section>` sans classe', () => {
    const attributs = regionAttributes(reglages, 'reglages-titre');

    assert.notEqual(
      attributs,
      null,
      '`TenantSettingsForm` ne rend plus de `<section ' +
        'aria-labelledby="reglages-titre">` : le `<h1>` de l’écran ne nomme plus ' +
        'rien (web-frontend §7).',
    );

    assert.doesNotMatch(
      attributs,
      /\bclassName=/,
      `L’enveloppe de /reglages porte désormais une classe : \`${borne}\` ne ` +
        'l’atteint plus, et son titre se recolle à son premier champ (#718).',
    );

    assert.ok(
      isScreenRoot(reglages, 'reglages-titre'),
      '`TenantSettingsForm` ne rend plus son enveloppe en premier : un conteneur ' +
        's’est glissé entre elle et la borne de colonne que la page pose autour, ' +
        `et le combinateur enfant de \`${borne}\` ne l’atteint plus (#718).`,
    );
  });

  for (const [ecran, fichier, conteneur] of [
    ['/reglages', join(composants, 'tenant-settings-form.tsx'), '<form className="spa-admin__content"'],
    ['/catalogue/rubriques', join(composants, 'category-manager.tsx'), '<div className="spa-admin__content"'],
  ]) {
    it(`${ecran} emprunte la zone de contenu pour la gouttière de ses blocs`, () => {
      // Les deux moitiés de la preuve, comme ailleurs dans cette suite : la règle
      // dit le bon rythme, et le balisage la laisse passer. Sans cette classe, les
      // blocs de ces deux écrans se rejoindraient à 0 px — c'est bien la gouttière
      // qu'ils viennent chercher, et rien d'autre depuis #718.
      assert.ok(
        withoutComments(readFileSync(fichier, 'utf8')).includes(conteneur),
        `${ecran} ne rend plus \`${conteneur}>\` : ses blocs perdent la gouttière ` +
          'qu’ils empruntaient à la coquille et se rejoignent à 0 px (#700, #718).',
      );
    });
  }
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
