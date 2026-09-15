/*
 * Back-office — le rythme vertical des écrans du catalogue
 * =============================================================================
 *
 * Issue #633. La campagne de QA a relevé **0 px** de gouttière entre les groupes
 * de champs de « Nouvelle rubrique » — « Description » collé au bas de « Nom de
 * la rubrique », « Adresse publique » collé à la mention « Facultative. » — quand
 * l'écran voisin `/catalogue/nouveau` en pose 12 px. Même mécanique sur
 * `/catalogue/apercu`, où la carte de la barre d'outils et l'encart « Ce que voit
 * la cliente » avaient leurs liserés confondus en un trait.
 *
 * La cause est la même des deux côtés, et elle n'est pas une valeur d'espacement
 * manquante : c'est un élément **sans mise en page** intercalé entre la gouttière
 * et les blocs qu'elle devait écarter. Un `<form>` nu dans la carte
 * `.spa-admin__section` d'un côté, une `<section>` nue dans la zone de contenu
 * `.spa-admin__content` de l'autre. Les deux conteneurs déclaraient bien leur
 * `gap` ; il ne descendait simplement pas jusqu'aux blocs, un `gap` ne portant
 * que sur les enfants **directs**.
 *
 * D'où la forme de cette suite : elle tient les deux moitiés de chaque preuve.
 *
 *   1. LA GOUTTIÈRE EXISTE. `.spa-admin__section` et `.spa-admin__content` sont
 *      des colonnes flex qui déclarent un `gap`. Sans cette moitié, les
 *      assertions de balisage ci-dessous resteraient vertes en ne prouvant rien :
 *      poser une classe qui ne met plus rien en page ne sépare aucun champ.
 *
 *   2. LE BALISAGE LA LAISSE PASSER. Le `<form>` d'une rubrique **est** la carte,
 *      comme `ServiceForm` sur `/catalogue/nouveau` ; les blocs de l'aperçu sont
 *      les enfants directs de la zone de contenu. C'est la moitié que la revue
 *      humaine rate : un élément neutre réintroduit demain autour de l'un ou de
 *      l'autre rouvrirait le défaut sans qu'aucune feuille de style ne change.
 *
 * Ce qui n'est **pas** vérifié ici, et c'est délibéré : aucune règle CSS n'a été
 * ajoutée pour ce ticket. La correction est entièrement dans le balisage du
 * catalogue, avec le vocabulaire de classes que les maquettes exercent déjà —
 * `admin/shell.css` n'est pas touché, et `/catalogue/nouveau` non plus.
 *
 * La preuve visuelle est au navigateur — phase de recette de #633.
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

const categoryManager = readFileSync(
  join(adminDir, 'components', 'category-manager.tsx'),
  'utf8',
);
const preview = readFileSync(join(adminDir, 'catalogue', 'apercu', 'page.tsx'), 'utf8');

/*
 * `rulesFor` et `withoutMediaQueries` viennent de `support/tokens.mjs` (#683).
 * Le second n'est pas une commodité : sous 360 px, `admin/shell.css` redéclare
 * `.spa-admin__content` **avec** un `gap` et `.spa-admin__section` **sans**. Lue
 * sans filtre, la feuille joint les deux blocs en un seul, la gouttière de base
 * peut disparaître de `.spa-admin__content` — le palier la fournit à
 * l'assertion — et le défaut de #633 rouvre en vert sur l'écran large, celui que
 * la QA a mesuré. Le raisonnement complet est dans la documentation des deux
 * fonctions, qui se lisent ensemble.
 */

/** La valeur d'une propriété dans un bloc de déclarations, ou `null`. */
function declaration(body, property) {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  return found === null ? null : found[1].trim().replace(/\s+/g, ' ');
}

/**
 * Neutralise les commentaires d'un fichier TSX.
 *
 * Les deux écrans corrigés expliquent le défaut dans leur en-tête, en nommant les
 * classes et les balises en cause. Une recherche menée sur le fichier brut y
 * trouverait donc tout ce qu'elle cherche — y compris ce que le ticket vient de
 * retirer du rendu.
 *
 * Les commentaires de ligne comptent autant que les blocs : `CategoryManager`
 * explique en `//`, au point de montage même, pourquoi aucune `<section>` n'y
 * enveloppe plus le formulaire. Ne neutraliser que les blocs laisserait ces
 * lignes-là répondre aux assertions à la place du rendu.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

describe('Les conteneurs du back-office portent bien une gouttière', () => {
  for (const [selector, ecran] of [
    ['.spa-admin__section', 'la carte d’un formulaire ou d’une liste'],
    ['.spa-admin__content', 'la zone de contenu d’un écran'],
  ]) {
    it(`\`${selector}\` empile ses enfants en les écartant`, () => {
      const body = rulesFor(withoutMediaQueries(shell), selector).join(' ');

      assert.notEqual(body, '', `admin/shell.css ne déclare plus \`${selector}\`.`);

      assert.equal(
        declaration(body, 'flex-direction'),
        'column',
        `\`${selector}\` (${ecran}) n'empile plus ses enfants en colonne.`,
      );

      const gap = declaration(body, 'gap');

      assert.ok(
        gap !== null && /var\(\s*--spa-space-\d+\s*\)/.test(gap),
        `\`${selector}\` (${ecran}) ne déclare plus de gouttière tirée de ` +
          'l’échelle d’espacement. Les blocs des écrans qu’il porte se ' +
          'rejoindraient à 0 px — le défaut relevé par la QA sur ' +
          '/catalogue/rubriques et /catalogue/apercu (#633).',
      );
    });
  }
});

describe('Le formulaire d’une rubrique est lui-même la carte', () => {
  it('pose `spa-admin__section` sur le `<form>`', () => {
    // Le geste de `ServiceForm` sur /catalogue/nouveau, d'où viennent les 12 px
    // que la QA a pris pour référence. Un `<form>` nu rangé dans la carte
    // intercalait un bloc sans mise en page entre la gouttière et les champs.
    // La classe est cherchée **dans** la liste de classes, et non comme valeur
    // entière de l'attribut : `staff-invite-form.tsx` montre qu'une carte
    // d'administration porte volontiers `spa-admin__section spa-admin-form`.
    // Exiger l'égalité ferait échouer cette garde le jour où la colonne de
    // saisie de #630 viendrait borner ce formulaire — un ajout qui ne retire
    // pourtant rien à la gouttière que le ticket protège.
    assert.match(
      withoutComments(categoryManager),
      /<form\b[^>]*className=["'][^"']*\bspa-admin__section\b/,
      'le `<form>` de `CategoryForm` ne porte plus `spa-admin__section` : ses ' +
        'groupes de champs redeviennent des blocs du flux normal, empilés à ' +
        '0 px (#633).',
    );
  });

  it('ne remet pas une carte autour de ce formulaire', () => {
    // Deux cartes emboîtées seraient visibles — double liseré, double fond — mais
    // surtout la gouttière de l'enveloppe ne porterait plus que sur le `<form>`
    // unique qu'elle contiendrait, et les champs se rejoindraient de nouveau.
    assert.doesNotMatch(
      withoutComments(categoryManager),
      /<section\b[^>]*aria-labelledby="rubrique-nouvelle"/,
      '« Nouvelle rubrique » est de nouveau enveloppée dans une `<section>` : ' +
        'le titre et le formulaire sont deux enfants de cette enveloppe, et la ' +
        'gouttière de la carte s’arrête au `<form>` au lieu d’atteindre les ' +
        'champs (#633).',
    );
  });
});

describe('Les blocs de l’aperçu public sont les enfants de la zone de contenu', () => {
  it('rend un fragment, et non une enveloppe sans mise en page', () => {
    // `.spa-admin__content` écarte ses enfants DIRECTS. Une `<section>` qui les
    // réunit tous en reçoit la gouttière pour elle seule, et la carte de la barre
    // d'outils retrouve le liseré de l'encart « Ce que voit la cliente ».
    assert.match(
      withoutComments(preview),
      /return \(\s*<>/,
      '/catalogue/apercu réunit de nouveau ses blocs sous une enveloppe : la ' +
        'gouttière de `.spa-admin__content` ne les atteint plus, et les ' +
        'bordures de la barre d’outils et de l’encart redeviennent jointives ' +
        '(#633).',
    );
  });

  it('laisse `/catalogue/nouveau` sur son propre balisage', () => {
    // La correction est locale à deux écrans, et ne se paie pas d'une règle
    // globale : l'écran voisin est la référence de la mesure, il doit donc rester
    // exactement ce qu'il était.
    const nouveau = readFileSync(join(adminDir, 'catalogue', 'nouveau', 'page.tsx'), 'utf8');

    assert.match(
      withoutComments(nouveau),
      /<section aria-labelledby="prestation-nouvelle">/,
      '/catalogue/nouveau a changé de balisage. C’est l’écran dont #633 reprend ' +
        'la gouttière de 12 px : le corriger avec lui ferait perdre la référence ' +
        'de la mesure.',
    );
  });
});
