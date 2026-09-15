/*
 * Back-office — la largeur des colonnes de saisie et du ticket
 * =============================================================================
 *
 * Issue #630. La campagne de QA a relevé, à 1920 px, quatre écrans de formulaire
 * et un récapitulatif d'encaissement étirés sur toute la zone de contenu : un
 * champ « Durée du soin (minutes) » mesuré à 1 637 px pour y taper « 60 », et
 * 1 215 px entre « À encaisser » et « 85,00 € ».
 *
 * Le back-office n'avait aucune borne parce qu'il n'en avait jamais eu besoin :
 * ses écrans sont des plannings, des tableaux et des listes, qui profitent de la
 * place. Les formulaires, non — et ils avaient hérité de la même enveloppe.
 *
 * Cette suite tient trois invariants dont le rendu découle, et aucun rendu.
 *
 *   1. LA MESURE EXISTE ET N'EST PAS DEUX. `.spa-admin-form` borne la colonne de
 *      saisie, et la colonne du ticket est bornée à la même valeur. Le produit
 *      emploie déjà 44 rem dans `components/booking.css` et
 *      `components/account.css` : une quatrième mesure inventée ici ferait quatre
 *      largeurs de formulaire pour un seul produit.
 *
 *   2. LA BORNE NE DESCEND PAS DANS LE TUNNEL. `components/field.css` est
 *      partagé par les trois produits de `apps/web`. Une largeur maximale posée
 *      sur `.spa-field` — le geste le plus court pour refermer ce ticket —
 *      s'ajouterait à celle que le tunnel de réservation et l'espace compte
 *      posent déjà sur leur propre colonne, et rétrécirait des écrans que #624
 *      vient de reprendre. C'est l'invariant que cette suite protège le plus
 *      étroitement : il n'a aucune trace visible sur les écrans du back-office,
 *      et une relecture qui n'ouvre pas le tunnel ne le verrait pas tomber.
 *
 *      Son corollaire tient au même endroit : la règle vit dans `admin/shell.css`,
 *      que seul `app/(admin)/[tenantSlug]/admin/layout.tsx` charge, et non dans
 *      une feuille de `components/` que le layout racine sert aussi au parcours
 *      client public.
 *      Une règle d'administration qui y redescendrait serait payée en octets par
 *      la surface qui vise un LCP < 2,5 s en 4G (web-frontend §7).
 *
 *   3. LES QUATRE ÉCRANS PORTENT LE CONTENEUR. Une classe déclarée mais posée
 *      nulle part passerait toutes les vérifications de style du dépôt.
 *
 * La preuve visuelle, elle, est au navigateur — phase de recette de #630,
 * captures à 1920 px des cinq écrans et du tunnel.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent, comme
 * pour les autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readStyleSheet, stripComments, styleSheetPath } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Racine du back-office, d'où partent les chemins d'écrans. */
const adminDir = join(here, '..', 'app', '(admin)', '[tenantSlug]', 'admin');

const field = stripComments(readStyleSheet(styleSheetPath('components/field.css')));
const shell = stripComments(readStyleSheet(styleSheetPath('admin/shell.css')));
const checkout = stripComments(readStyleSheet(styleSheetPath('admin/checkout.css')));

/**
 * Retire les blocs `@media` d'une feuille.
 *
 * Les paliers d'un écran redéclarent les mêmes sélecteurs que sa mise en page
 * nominale : sans ce filtre, la règle d'empilement de `.spa-admin-checkout` —
 * une seule colonne, sous 60 rem — passerait pour la déclaration de base et
 * ferait conclure que la colonne du ticket n'est plus bornée.
 *
 * L'accolade fermante du bloc est reconnue à sa position en début de ligne,
 * comme dans `support/tokens.mjs` : une analyse CSS complète serait une
 * dépendance de plus dans un dossier qui n'en a aucune.
 */
function withoutMediaQueries(css) {
  return css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
}

/**
 * Les blocs de déclarations des règles dont la liste de sélecteurs contient
 * **exactement** `selector`.
 *
 * L'égalité et non la sous-chaîne, pour la raison déjà écrite en #615 et #628 :
 * une déclaration déplacée vers une règle plus spécifique laisserait
 * l'assertion verte alors que le sélecteur vérifié aurait perdu le
 * comportement.
 */
function rulesFor(css, selector) {
  const wanted = selector.trim().replace(/\s+/g, ' ');
  const found = [];
  for (const [, prelude, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
    if (selectors.includes(wanted)) found.push(body);
  }
  return found;
}

/** La valeur d'une propriété dans un bloc de déclarations, ou `null`. */
function declaration(body, property) {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  return found === null ? null : found[1].trim().replace(/\s+/g, ' ');
}

/**
 * Les deux façons d'écrire une largeur maximale en CSS.
 *
 * Le dépôt emploie les deux : `components/booking.css` borne sa colonne en
 * `max-inline-size`, `components/account.css` en `max-width`. Une garde qui n'en
 * guetterait qu'une se contournerait donc par simple choix de graphie, sans que
 * personne l'ait voulu.
 */
const BORNES = ['max-inline-size', 'max-width'];

/** Une longueur en `rem`, ou `null` si la valeur est écrite autrement. */
function rem(value) {
  const found = /^([\d.]+)rem$/.exec(value ?? '');
  return found === null ? null : Number(found[1]);
}

describe('La colonne de saisie du back-office est bornée', () => {
  it('déclare `.spa-admin-form` avec une largeur maximale en rem', () => {
    const rules = rulesFor(withoutMediaQueries(shell), '.spa-admin-form');

    assert.notDeepEqual(
      rules,
      [],
      'admin/shell.css ne déclare plus `.spa-admin-form` : les formulaires ' +
        'du back-office reprennent toute la zone de contenu, soit 1 637 px à ' +
        '1920 px de fenêtre (#630).',
    );

    const measure = rem(declaration(rules.join(' '), 'max-inline-size'));

    assert.ok(
      measure !== null,
      '`.spa-admin-form` ne porte plus de `max-inline-size` exprimée en rem. ' +
        'La borne doit suivre la taille de police de l’utilisateur : en pixels, ' +
        'elle resserre le formulaire de qui grossit son texte.',
    );
  });

  it('borne la colonne du ticket d’encaissement à la même mesure', () => {
    const form = rem(
      declaration(rulesFor(withoutMediaQueries(shell), '.spa-admin-form').join(' '), 'max-inline-size'),
    );
    const grid = declaration(
      rulesFor(withoutMediaQueries(checkout), '.spa-admin-checkout').join(' '),
      'grid-template-columns',
    );

    assert.ok(
      grid !== null,
      'admin/checkout.css ne déclare plus les colonnes de `.spa-admin-checkout`.',
    );

    assert.ok(
      !/\bfr\b/.test(grid),
      `la première piste de \`.spa-admin-checkout\` vaut « ${grid} » : une piste ` +
        'flexible rend au ticket tout ce que le panneau de paiement ne prend ' +
        'pas, soit 1 269 px à 1920 px de fenêtre. « À encaisser » était peint à ' +
        'x=266 et « 85,00 € » à x=1481 (#630).',
    );

    const ticket = rem((/minmax\(\s*[^,]+,\s*([^)]+)\)/.exec(grid) ?? [])[1]?.trim());

    assert.equal(
      ticket,
      form,
      `le ticket est borné à ${String(ticket)} rem et la colonne de saisie à ` +
        `${String(form)} rem. Les deux se lisent de la même façon — un libellé à ` +
        'gauche, sa valeur à droite — et le produit n’a pas deux mesures de ' +
        'lecture. `components/booking.css` et `components/account.css` emploient ' +
        'déjà la même.',
    );
  });
});

describe('La borne ne descend pas dans le tunnel de réservation', () => {
  it('ne pose aucune largeur maximale sur les sélecteurs `.spa-field`', () => {
    const fautives = [];

    for (const [, prelude, body] of field.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));

      // Les deux orthographes, et non la seule logique : `components/account.css`
      // borne déjà sa colonne en `max-width`, si bien que la graphie physique est
      // celle qu'un contributeur a le plus de chances d'écrire ici. Ne guetter que
      // `max-inline-size` laisserait passer `.spa-field { max-width: 44rem }` —
      // c'est-à-dire exactement la régression que cette suite dit tenir.
      if (
        selectors.some((one) => /(^|\s)\.spa-field(__[\w-]+|--[\w-]+)?(\s|:|\[|$)/.test(one)) &&
        BORNES.some((property) => declaration(body, property) !== null)
      ) {
        fautives.push(selectors.join(', '));
      }
    }

    assert.deepEqual(
      fautives,
      [],
      `components/field.css borne « ${fautives.join(' | ')} ». Cette feuille est ` +
        'partagée par les trois produits de `apps/web` : le tunnel de ' +
        'réservation et l’espace compte bornent déjà leur propre colonne à ' +
        '44 rem, et une seconde borne posée sur le champ lui-même s’ajouterait à ' +
        'la leur. La largeur maximale du back-office se pose sur un conteneur ' +
        'admin — `.spa-admin-form` — et sur lui seul (#630, #624).',
    );
  });

  it('ne déclare pas le conteneur admin dans une feuille du parcours client', () => {
    assert.deepEqual(
      rulesFor(field, '.spa-admin-form'),
      [],
      'components/field.css déclare `.spa-admin-form`. Cette feuille est tirée ' +
        'par `styles/index.css`, que le layout racine charge pour les deux ' +
        'produits : la règle serait servie au parcours client public, qui vise un ' +
        'LCP < 2,5 s en 4G et n’affiche aucun écran d’administration ' +
        '(web-frontend §7). Sa place est `admin/shell.css`, chargé par le seul ' +
        '`app/(admin)/[tenantSlug]/admin/layout.tsx`.',
    );
  });
});

describe('Les écrans de formulaire portent le conteneur borné', () => {
  /** Les écrans que la campagne a relevés, et le fichier qui pose la classe. */
  const ecrans = [
    ['/catalogue/nouveau', join(adminDir, 'catalogue', 'nouveau', 'page.tsx')],
    ['une fiche de prestation', join(adminDir, 'catalogue', '[serviceId]', 'page.tsx')],
    [
      '/personnel',
      join(adminDir, 'personnel', 'components', 'staff-invite-form.tsx'),
    ],
    ['/reglages', join(adminDir, 'reglages', 'page.tsx')],
    // Ajouté par #634. La campagne de #630 n'avait relevé ici aucun champ étiré,
    // et l'écran était resté hors de la liste ; c'est son bouton de création qui
    // a trahi la carte non bornée. Seul le `<form>` porte la classe — la liste
    // des rubriques garde toute la largeur, comme tout tableau du back-office.
    ['/catalogue/rubriques', join(adminDir, 'components', 'category-manager.tsx')],
  ];

  for (const [ecran, fichier] of ecrans) {
    it(`pose \`spa-admin-form\` sur ${ecran}`, () => {
      const source = readFileSync(fichier, 'utf8');

      // La classe est cherchée dans un `className`, et non n'importe où dans le
      // fichier : ces écrans la nomment aussi dans leurs commentaires, et une
      // recherche de sous-chaîne resterait verte une fois l'attribut retiré.
      assert.match(
        source,
        /className=["'][^"']*\bspa-admin-form\b/,
        `${ecran} ne pose plus \`spa-admin-form\` : ses champs reprennent la ` +
          'largeur de la zone de contenu (#630).',
      );
    });
  }
});
