/*
 * Back-office — la mise en forme de l'écran de connexion
 * =============================================================================
 *
 * Issue #699. La campagne de QA `20260915-1` a relevé deux écarts entre
 * `/{salon}/admin/connexion` et `/{salon}/compte/connexion`, aux quatre largeurs
 * mesurées : le bord haut de « Se connecter » touchait le bord bas du champ
 * « Mot de passe » — 0 px contre 12 à 16 px côté client — et, à 1920 px, les
 * champs s'étiraient sur environ 1 400 px contre environ 470 px.
 *
 * Les deux viennent du même balisage, et le remède est celui de #633 : le
 * `<form>` **est** la carte. C'est `tests/unit/admin-login-form.test.tsx` qui le
 * tient, parce qu'il faut rendre le composant pour le voir.
 *
 * Reste ici l'autre moitié, que seul le CSS porte : le centrage. Une colonne de
 * saisie bornée à 44 rem, seule dans une zone de contenu large de toute la
 * fenêtre — l'écran de connexion est le seul du back-office servi sans rail —,
 * se colle au bord gauche de 1 900 px de vide si rien ne la centre.
 *
 * L'invariant tenu n'est pas « la règle existe » mais **« elle reste
 * conditionnelle »** : centrer `.spa-admin-form` tout court déplacerait les cinq
 * écrans que #630 a bornés, où la colonne s'aligne sur une barre d'outils, une
 * liste ou un tableau qui commencent tous au bord gauche. C'est le geste le plus
 * court pour refermer ce ticket, et c'est celui qui casse ailleurs — sans rien
 * afficher de faux sur l'écran qu'on regardait.
 *
 * Aucune dépendance : `node:test` et `node:assert` suffisent, et les lecteurs de
 * règles et de déclarations viennent tous deux de `support/tokens.mjs` (#683,
 * #713) — cette suite n'en porte plus aucune copie.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  declaration,
  readStyleSheet,
  rulesFor,
  stripComments,
  styleSheetPath,
  withoutMediaQueries,
} from './support/tokens.mjs';

const shell = withoutMediaQueries(stripComments(readStyleSheet(styleSheetPath('admin/shell.css'))));

/** Le sélecteur qui centre, tel qu'`admin/shell.css` doit l'écrire. */
const CENTRAGE = '.spa-admin__content > .spa-admin__section.spa-admin-form:only-child';

describe('La carte de connexion se centre dans sa zone de contenu', () => {
  it('pose une marge automatique sur la carte qui est tout l’écran', () => {
    const body = rulesFor(shell, CENTRAGE).join(' ');

    assert.notEqual(
      body,
      '',
      `admin/shell.css ne déclare plus « ${CENTRAGE} » : la carte de connexion, ` +
        'bornée à 44 rem, se colle au bord gauche d’une zone de contenu large de ' +
        'toute la fenêtre — l’écran de connexion est le seul du back-office servi ' +
        'sans rail (#699).',
    );

    assert.equal(
      declaration(body, 'margin-inline'),
      'auto',
      'la règle de centrage a perdu son `margin-inline: auto`. C’est la seule ' +
        'déclaration qu’elle porte : sans elle, elle ne fait plus rien.',
    );
  });

  it('ne centre pas les colonnes de saisie qui ont des voisins', () => {
    // La condition est ce qui distingue cet écran des cinq que #630 a bornés.
    // `/reglages`, `/catalogue/nouveau`, une fiche de prestation, `/personnel` et
    // `/catalogue/rubriques` partagent leur zone avec une barre d'outils, une
    // liste ou un tableau qui commencent tous au bord gauche : une colonne
    // centrée s'y désalignerait de ce qui l'encadre.
    const nu = rulesFor(shell, '.spa-admin-form').join(' ');

    assert.equal(
      declaration(nu, 'margin-inline'),
      null,
      '`.spa-admin-form` centre désormais toute colonne de saisie du ' +
        'back-office. Le centrage de #699 vaut pour la seule carte qui est ' +
        'l’unique enfant de sa zone de contenu.',
    );

    assert.equal(
      declaration(nu, 'margin'),
      null,
      '`.spa-admin-form` porte une marge raccourcie, qui recouvre `margin-inline` ' +
        'et centre les cinq écrans bornés par #630 (#699).',
    );
  });
});
