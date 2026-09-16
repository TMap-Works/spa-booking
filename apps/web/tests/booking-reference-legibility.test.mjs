/*
 * La référence du rendez-vous se lit à 360 px
 * =============================================================================
 *
 * Issue #736. L'audit de conception a relevé, sur l'écran de confirmation du
 * tunnel, « Référence : 8425dc59-e63d-4ff5-b679-5714157cb046 » : trente-six
 * caractères au ton des informations de second plan, repliés sur deux lignes à
 * 360 px — la largeur où le constat a été pris. La référence courte qui la
 * remplace tient en onze caractères ; encore faut-il que la mise en page ne la
 * coupe pas en deux à son tour.
 *
 * Le piège est celui de `booking-recap-columns.test.mjs` : **rien ne signale une
 * mise en page absente**. `RDV-8F3K-27` sans règle s'affiche, compile et passe
 * la recette — jusqu'au jour où un panneau plus étroit, ou un libellé plus long
 * à côté, casse le code entre son groupe et son suffixe. Un code de réservation
 * coupé sur deux lignes ne se dicte plus, et c'est précisément le défaut qu'on
 * vient de corriger.
 *
 * Ce que la suite tient, et rien d'autre :
 *
 * 1. le code ne se coupe pas — `white-space: nowrap` sur lui seul ;
 * 2. la rangée passe à la ligne plutôt que déborder du panneau ;
 * 3. le code est en chasse fixe, pour se compter en le dictant ;
 * 4. il porte la couleur de texte pleine, et le libellé seul reste atténué ;
 * 5. le repli — l'identifiant brut, quand aucune référence ne s'en dérive —
 *    porte l'inverse : il doit pouvoir se couper n'importe où ;
 * 6. l'écran rend bien ces classes, faute de quoi la feuille n'a plus de prise.
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

/*
 * Le source de l'écran, ses commentaires de bloc neutralisés — sa documentation
 * cite `.spa-card__meta` pour dire ce qui a été retiré, et la prose ferait
 * échouer l'assertion qu'elle justifie.
 *
 * `stripComments` vient des suites de style : elle neutralise `/* … *\/` et rien
 * d'autre. Un commentaire de ligne `//` de ce fichier TSX lui échappe donc, et
 * c'est pourquoi l'assertion d'absence ci-dessous ne lit que les attributs
 * `className` — la prose ne doit pas pouvoir la faire échouer, quelle que soit
 * la façon dont elle est écrite.
 */
const confirmationSource = stripComments(
  readFileSync(
    join(
      here,
      '..',
      'app',
      '(booking)',
      '[tenantSlug]',
      'reservation',
      'steps',
      'confirmation-step.tsx',
    ),
    'utf8',
  ),
);

const booking = stripComments(readStyleSheet(styleSheetPath('components/booking.css')));

describe('Le code de réservation ne se coupe pas', () => {
  const code = rulesFor(booking, '.spa-booking__reference-code');

  it('déclare une règle pour le code', () => {
    assert.notDeepEqual(
      code,
      [],
      'aucune règle ne vise `.spa-booking__reference-code` : le code reprend le ' +
        'corps et le ton du texte courant, et rien ne l’empêche de se couper ' +
        'entre son groupe et son suffixe (#736).',
    );
  });

  it('interdit la coupure au milieu du code', () => {
    assert.match(
      code.join(' '),
      /white-space\s*:\s*nowrap/,
      '`.spa-booking__reference-code` ne pose plus `white-space: nowrap` : à ' +
        '360 px un panneau de tunnel offre ~280 px utiles, et un code coupé en ' +
        '« RDV-8F3K- » puis « 27 » ne se dicte plus au téléphone (#736).',
    );
  });

  it('le rend en chasse fixe', () => {
    assert.match(
      code.join(' '),
      /font-family\s*:\s*var\(--spa-font-mono\)/,
      '`.spa-booking__reference-code` repasse en chasse proportionnelle : les ' +
        'groupes se resserrent au point qu’on perd le compte des caractères en ' +
        'les épelant (#736).',
    );
  });

  it('lui donne la couleur de texte pleine', () => {
    assert.match(
      code.join(' '),
      /color\s*:\s*var\(--spa-color-text\)/,
      '`.spa-booking__reference-code` retombe sur la couleur atténuée héritée : ' +
        'c’était le constat de l’audit — la référence rendue au ton des ' +
        'informations de second plan (#736).',
    );

    assert.match(
      rulesFor(booking, '.spa-booking__reference-term').join(' '),
      /color\s*:\s*var\(--spa-color-text-muted\)/,
      'le libellé « Réf. » ne porte plus la couleur atténuée : sans ce partage, ' +
        'l’étiquette et la valeur ont le même ton et ne se distinguent plus — ' +
        'même partage qu’entre `.spa-booking__recap-term` et sa valeur (#736).',
    );
  });
});

describe('La rangée passe à la ligne plutôt que déborder', () => {
  const row = rulesFor(booking, '.spa-booking__reference');

  it('déclare une règle de rangée', () => {
    assert.notDeepEqual(
      row,
      [],
      'aucune règle ne vise `.spa-booking__reference` : le libellé et le code ' +
        'retombent dans le flux du paragraphe, et le code insécable déborde du ' +
        'panneau au lieu de descendre d’une ligne (#736).',
    );
  });

  it('aligne son libellé et son code sur une ligne, et les fait passer à la ligne', () => {
    assert.match(
      row.join(' '),
      /display\s*:\s*flex/,
      '`.spa-booking__reference` n’est plus un conteneur flex (#736).',
    );

    assert.match(
      row.join(' '),
      /flex-wrap\s*:\s*wrap/,
      '`.spa-booking__reference` ne passe plus à la ligne : comme le code est ' +
        'insécable, c’est cette déclaration — et elle seule — qui décide que ' +
        'c’est la rangée qui cède à 360 px, et non le panneau qui déborde (#736).',
    );
  });
});

describe('Le repli se coupe, lui', () => {
  it('laisse l’identifiant brut casser n’importe où', () => {
    assert.match(
      rulesFor(booking, '.spa-booking__reference-fallback').join(' '),
      /overflow-wrap\s*:\s*anywhere/,
      '`.spa-booking__reference-fallback` ne pose plus `overflow-wrap` : le ' +
        'repli rend une chaîne de longueur inconnue, sans espace où la couper — ' +
        'elle déborderait du panneau, exactement comme l’UUID de l’audit (#736).',
    );
  });
});

describe('L’écran rend ces classes', () => {
  it('pose la rangée, son libellé et son code', () => {
    for (const part of [
      'spa-booking__reference"',
      'spa-booking__reference-term',
      'spa-booking__reference-code',
      'spa-booking__reference-fallback',
    ]) {
      assert.match(
        confirmationSource,
        new RegExp(part),
        `l’écran de confirmation ne rend plus \`${part.replace('"', '')}\` : la ` +
          'règle correspondante de `booking.css` n’a plus de prise (#736).',
      );
    }
  });

  it('ne rend plus la référence en ligne de méta atténuée', () => {
    // Les attributs `className` seuls, et jamais le fichier entier : ce qui est
    // interdit, c'est de *poser* la classe, pas d'en parler. Une mention de
    // `.spa-card__meta` dans un commentaire de ligne `//` — que `stripComments`
    // ne neutralise pas — ferait autrement échouer la suite sur une phrase.
    const classNames = [...confirmationSource.matchAll(/className="([^"]*)"/g)].map(
      ([, value]) => value,
    );

    assert.doesNotMatch(
      classNames.join(' '),
      /spa-card__meta/,
      'l’écran de confirmation repasse par `.spa-card__meta` : c’est la classe ' +
        'des informations de second plan, et c’est elle qui rendait la ' +
        'référence en gris atténué (#736).',
    );
  });
});
