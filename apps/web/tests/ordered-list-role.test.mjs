/*
 * Toute liste ordonnée déclare son rôle de liste
 * =============================================================================
 *
 * Issue #659, contrepartie du reset posé par #625. `styles/base.css` remet à
 * zéro le marqueur et le retrait de tout `<ul>`/`<ol>` : dans ce produit une
 * liste est presque toujours structurelle. La contrepartie est consignée dans
 * `styles/README.md` §3 — sans marqueur, Safari retire la sémantique de liste à
 * VoiceOver, qui n'annonce plus « liste de N éléments ».
 *
 * Un `<ol>` est le cas où cela coûte le plus cher : on n'en écrit un plutôt
 * qu'un `<ul>` que lorsque la **séquence** porte l'information. Perdre le rôle,
 * c'est perdre exactement ce qu'on avait choisi de dire. Deux `<ol>` étaient
 * dans ce cas au moment de #659 — le fil des étapes du tunnel de réservation et
 * l'historique des visites d'une fiche client.
 *
 * Le piège, et la raison d'être de cette suite : **rien ne signale un rôle
 * absent**. Un `<ol>` sans `role="list"` compile, s'affiche, se lit à l'écran et
 * passe la recette — il ne se tait que sous un lecteur d'écran, sur un
 * navigateur que la CI n'exécute pas. C'est ainsi que les deux occurrences
 * ci-dessus ont survécu à #625 puis à #658.
 *
 * Pourquoi la source et non le rendu : jsdom calcule le rôle **implicite** d'un
 * élément à partir de sa balise, et rend donc `role=list` pour un `<ol>` qu'il y
 * ait attribut ou non. Une assertion posée sur un arbre rendu — par
 * `getByRole('list')` — passerait à l'identique avant et après le correctif.
 * Elle ne peut pas échouer, et un test qui ne peut pas échouer ne garde rien.
 * Ce qui se vérifie ici est donc la présence de la déclaration explicite, seule
 * chose qui distingue le code corrigé du code fautif.
 *
 * ## Les surfaces scrutées, et pourquoi les maquettes en sont (#684)
 *
 * Deux familles, pas une. Les sources `.tsx` de `app/` et `components/` d'abord :
 * ce sont les surfaces servies, les seules qu'un lecteur d'écran atteigne. Puis
 * les maquettes HTML de `mockups/`, qui n'en sont pas — et qui sont pourtant
 * scrutées au même titre, parce qu'elles sont le **contrat de balisage** dont les
 * écrans admin ont été tirés (#30). Un rôle perdu là ne reste pas dans la
 * maquette : il rentre dans le produit à la prochaine reprise, et le paragraphe
 * ci-dessus dit ce qu'il advient ensuite — rien ne rougit.
 *
 * #684 en est la démonstration. Le `<ol>` de `mockups/admin/fiche-client.html` a
 * traversé #625, #658 puis #659 sans son rôle, sous les yeux d'une suite qui
 * s'interdisait de le regarder ; il a fallu une revue humaine pour le voir et une
 * issue de plus pour le corriger. Une maquette coûte donc ici le même attribut
 * qu'une source rendue, ce qui est le prix exact de ce qu'elle promet : qu'on
 * puisse la porter telle quelle.
 *
 * Pourquoi ici et non dans `admin-mockups.test.mjs`, qui lit déjà ces mêmes
 * fichiers : cette suite-là est organisée par **surface** — une famille de
 * fichiers, beaucoup d'invariants —, celle-ci par **invariant** — une règle, et
 * les surfaces où elle doit tenir. Y déplacer le cas des maquettes couperait une
 * règle unique en deux fichiers, dupliquerait la recherche de balises, le message
 * d'échec et le renvoi à `styles/README.md` §3, et ferait payer une troisième
 * copie à la troisième surface. Ajouter une racine à la table ci-dessous en coûte
 * une ligne.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, comme pour les
 * autres suites de ce dossier.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

/**
 * Neutralise les commentaires HTML, comme `stripComments` le fait des `/* … *\/`.
 *
 * Deux lignes recopiées de `admin-mockups.test.mjs` plutôt qu'importées :
 * `support/tokens.mjs` est l'outillage de lecture du **design system**, et un
 * lecteur de commentaires HTML n'y aurait aucun client CSS. Une troisième suite
 * qui en aurait besoin justifierait de l'y monter ; deux ne le justifient pas.
 */
const stripHtmlComments = (html) =>
  html.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));

/**
 * Les racines scrutées : les surfaces servies, puis le contrat de balisage.
 *
 * `tests/` n'y figure pas, et ne peut pas y figurer : les messages d'échec de
 * cette suite-même citent un `<ol>` sans rôle, et elle se ferait rougir par sa
 * propre prose.
 */
const scannedRoots = [
  { kind: 'sources rendues', dir: 'app', extension: '.tsx', strip: stripComments },
  { kind: 'sources rendues', dir: 'components', extension: '.tsx', strip: stripComments },
  { kind: 'maquettes', dir: 'mockups', extension: '.html', strip: stripHtmlComments },
];

/** Chemins de tous les fichiers en `extension` sous `dir`, en profondeur. */
function collectSources(dir, extension) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(full, extension));
    } else if (entry.name.endsWith(extension)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Les balises ouvrantes `<ol …>` d'un fichier, commentaires neutralisés par
 * `strip` — celui de son langage.
 *
 * La neutralisation n'est pas une précaution : les trois corrections gardées ici
 * sont documentées au-dessus de leur liste, et cette prose cite `<ol>` comme
 * `role="list"`. Sans elle, un commentaire suffirait à rendre vraie l'assertion
 * qu'il explique — le test passerait sur la documentation du correctif plutôt que
 * sur le correctif. Le cas est à peine théorique : le commentaire que #684 a posé
 * dans `mockups/admin/fiche-client.html` écrit les deux dans la même phrase.
 *
 * La balise peut tenir sur plusieurs lignes : la recherche court donc jusqu'au
 * `>` fermant, sauts de ligne compris.
 */
function openingTags(source, strip) {
  return [...strip(source).matchAll(/<ol\b[^>]*>/g)].map(([tag]) =>
    tag.replace(/\s+/g, ' '),
  );
}

const ordered = [];
for (const { kind, dir, extension, strip } of scannedRoots) {
  for (const file of collectSources(join(webRoot, dir), extension)) {
    for (const tag of openingTags(readFileSync(file, 'utf8'), strip)) {
      ordered.push({ kind, file: relative(webRoot, file).replace(/\\/g, '/'), tag });
    }
  }
}

const kinds = [...new Set(scannedRoots.map(({ kind }) => kind))];

describe('Les listes ordonnées gardent leur sémantique sous VoiceOver', () => {
  for (const kind of kinds) {
    it(`trouve au moins une liste ordonnée à garder parmi les ${kind}`, () => {
      // Sans cette assertion, la suite deviendrait silencieusement vide le jour
      // où les `<ol>` scrutés seraient renommés ou déplacés hors des racines —
      // et continuerait de passer en ne gardant plus rien.
      //
      // Elle porte sur chaque famille et non sur le total depuis #684 : trois
      // `<ol>` répartis sur deux familles rendent un total non nul même quand
      // l'une des deux est retombée à zéro, et c'est justement la famille des
      // maquettes — une seule liste, celle qu'on vient d'ajouter — qu'un total
      // masquerait.
      const roots = scannedRoots
        .filter((root) => root.kind === kind)
        .map(({ dir }) => dir)
        .join(', ');

      assert.notEqual(
        ordered.filter((one) => one.kind === kind).length,
        0,
        `aucun <ol> trouvé sous ${roots} : la garde ne porte plus sur les ${kind}.`,
      );
    });
  }

  it('déclare role="list" sur chacune', () => {
    const silencieuses = ordered.filter(({ tag }) => !/\brole="list"/.test(tag));

    assert.deepEqual(
      silencieuses.map(({ file, tag }) => `${file} — ${tag}`),
      [],
      'le socle retire le marqueur de tout <ol> (#625) : sans role="list" explicite, ' +
        'Safari retire la sémantique de liste à VoiceOver et la séquence n’est plus ' +
        'annoncée. Voir styles/README.md §3.',
    );
  });
});
