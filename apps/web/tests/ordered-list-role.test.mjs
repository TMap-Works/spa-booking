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
 * La suite porte sur les sources `.tsx` des deux produits, et sur elles seules :
 * ce sont les surfaces servies, les seules qu'un lecteur d'écran atteint. Les
 * maquettes HTML statiques de `mockups/` n'en sont pas.
 *
 * Une réserve, et elle est connue : ces maquettes sont le contrat de balisage
 * dont les écrans admin sont tirés (#30), et le `<ol>` de
 * `mockups/admin/fiche-client.html` ne porte pas le rôle — une reprise faite
 * depuis elle rouvrirait la régression sans que cette suite le voie. Le
 * corriger sortait de l'empreinte de #659, qui ne porte que sur les deux
 * sources rendues ; c'est l'objet d'une issue de suivi.
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

/** Les racines de code rendu — `mockups/` et `tests/` en sont exclus. */
const sourceRoots = ['app', 'components'];

/** Chemins de tous les `.tsx` sous `dir`, en profondeur. */
function collectSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(full));
    } else if (entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Les balises ouvrantes `<ol …>` d'un source, commentaires neutralisés.
 *
 * `stripComments` n'est pas une précaution : les deux corrections de #659 sont
 * documentées au-dessus de leur liste, et cette prose cite `<ol>` comme
 * `role="list"`. Sans neutralisation, un commentaire suffirait à rendre vraie
 * l'assertion qu'il explique — le test passerait sur la documentation du
 * correctif plutôt que sur le correctif.
 *
 * La balise peut tenir sur plusieurs lignes : la recherche court donc jusqu'au
 * `>` fermant, sauts de ligne compris.
 */
function openingTags(source) {
  return [...stripComments(source).matchAll(/<ol\b[^>]*>/g)].map(([tag]) =>
    tag.replace(/\s+/g, ' '),
  );
}

const ordered = [];
for (const root of sourceRoots) {
  for (const file of collectSources(join(webRoot, root))) {
    for (const tag of openingTags(readFileSync(file, 'utf8'))) {
      ordered.push({ file: relative(webRoot, file).replace(/\\/g, '/'), tag });
    }
  }
}

describe('Les listes ordonnées gardent leur sémantique sous VoiceOver', () => {
  it('trouve au moins une liste ordonnée à garder', () => {
    // Sans cette assertion, la suite deviendrait silencieusement vide le jour où
    // les deux `<ol>` seraient renommés ou déplacés hors des racines scrutées —
    // et continuerait de passer en ne gardant plus rien.
    assert.notEqual(
      ordered.length,
      0,
      `aucun <ol> trouvé sous ${sourceRoots.join(', ')} : la garde ne porte plus sur rien.`,
    );
  });

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
