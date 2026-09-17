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
 * -----------------------------------------------------------------------------
 *
 * Issue #760 — et la prémisse que cette suite écrivait sans la vérifier.
 *
 * Le paragraphe ci-dessus s'appuie sur une phrase : « l'écran de connexion est le
 * seul du back-office servi sans rail ». Elle justifiait le centrage — une
 * colonne seule dans toute la fenêtre — et la suite ne la tenait nulle part,
 * puisqu'elle ne lisait qu'une feuille de style. L'audit `d20260916-1` a montré
 * qu'elle était **fausse** : avec une session ouverte, cet écran recevait le rail
 * entier, sept sections et « Connecté·e : Adèle A. » comprises, à côté d'un
 * formulaire titré « Back-office — se connecter ». La zone de contenu ne faisait
 * alors plus toute la fenêtre, et le centrage que cette suite protège s'appliquait
 * à une carte qui n'était plus seule.
 *
 * Le second `describe` tient donc désormais la prémisse elle-même, et il la tient
 * là où elle se décide :
 *
 * - le layout **ne connaît aucune exception de route** — il peint le rail dès
 *   qu'il a un shell, et un layout de l'App Router ne sait pas quelle page il
 *   enveloppe. Lui faire épargner « la connexion » n'est pas seulement absent :
 *   c'est hors de sa portée, et cette suite le vérifie plutôt que de l'espérer ;
 * - l'écran de connexion **cesse d'être servi** quand ce même shell existe, en
 *   consultant la fonction du layout et non une seconde lecture de la session.
 *
 * Les deux moitiés se lisent dans la source des deux fichiers, comme le font déjà
 * `admin-form-width`, `admin-screen-rhythm` et `admin-catalog-rhythm` pour les
 * classes qu'aucune feuille de style ne peut prouver posées. Une preuve de
 * comportement — rendre la page et constater la redirection — relève de
 * `tests/unit/`, et ne remplacerait pas celle-ci : ce qu'on protège ici, c'est
 * qu'il n'existe **qu'une** décision, pas qu'elle ait le bon résultat sur un jeu
 * de doubles.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent, et les
 * lecteurs de règles et de déclarations viennent tous deux de
 * `support/tokens.mjs` (#683, #713) — cette suite n'en porte plus aucune copie.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const here = dirname(fileURLToPath(import.meta.url));
const adminDir = join(here, '..', 'app', '(admin)', '[tenantSlug]', 'admin');

/**
 * Neutralise les commentaires d'un fichier TSX.
 *
 * Même parade que dans `admin-screen-rhythm` et `admin-catalog-rhythm` : ces deux
 * fichiers **expliquent longuement** la décision du rail et la redirection, en
 * nommant les fonctions et la route en cause. Une recherche menée sur la source
 * brute y trouverait donc tout ce qu'on cherche, y compris après que le code l'a
 * perdu — la suite resterait verte sur une prose devenue fausse, ce qui est
 * exactement le défaut que #760 corrige.
 *
 * Les commentaires sont remplacés par des espaces de même longueur, et non
 * supprimés : les positions et les numéros de ligne restent ceux du fichier.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length));
}

const layout = withoutComments(readFileSync(join(adminDir, 'layout.tsx'), 'utf8'));
const connexion = withoutComments(readFileSync(join(adminDir, 'connexion', 'page.tsx'), 'utf8'));

describe('L’écran de connexion est le seul du back-office servi sans rail', () => {
  it('ne laisse au layout aucune exception de route — il peint dès qu’il a un shell', () => {
    // Le repli sans rail tient à une seule condition, et elle porte sur la
    // session : `shell === null`. C'est ce qui rend la prémisse vérifiable
    // ailleurs — il n'y a qu'un cas où le rail manque, et il ne dépend pas de la
    // page servie.
    assert.match(
      layout,
      /if \(shell === null\) \{\s*return main;\s*\}/,
      'le layout ne se rabat plus sur la seule zone de contenu quand la session ' +
        'manque. C’est la seule forme sans rail du back-office, et le centrage de ' +
        '#699 en dépend (#760).',
    );

    assert.equal(
      (layout.match(/<AdminRail\b/g) ?? []).length,
      1,
      'le layout peint le rail depuis plus d’un endroit : la condition qui le ' +
        'retient n’est plus unique, et « servi sans rail » cesse d’être ' +
        'vérifiable (#760).',
    );

    // Un layout de l'App Router ne sait pas quelle route il enveloppe : une
    // exemption nommée y serait au mieux inopérante, au pire une liste à tenir —
    // celle que `guard.tsx` refuse depuis le premier jour.
    assert.doesNotMatch(
      layout,
      /connexion/,
      'le layout nomme la route de connexion : il tente de l’exempter du rail. ' +
        'Un layout n’est pas rejoué à chaque navigation et ne connaît pas la page ' +
        'servie — c’est à l’écran de connexion de se retirer (#760).',
    );
  });

  it('retire l’écran de connexion dans les cas mêmes où le rail s’afficherait', () => {
    assert.match(
      connexion,
      /import \{ loadAdminShell \} from '\.\.\/layout'/,
      'connexion/page.tsx ne consulte plus `loadAdminShell` : sa décision et ' +
        'celle du rail peuvent de nouveau diverger, et l’écran redevient capable ' +
        'd’afficher « Connecté·e : Adèle A. » au-dessus de « se connecter » ' +
        '(#760).',
    );

    // La redirection est gardée par la condition **du rail**, et par elle seule.
    // Une seconde issue — « un shell existe, mais on rend quand même le
    // formulaire » — remettrait le formulaire sous le sommaire complet, c'est-à-
    // dire l'écart d20260916-1 ressuscité par une branche que personne n'emprunte.
    assert.match(
      connexion,
      /if \(shell !== null\) \{\s*redirect\(/,
      'connexion/page.tsx ne redirige plus sur la seule condition `shell !== ' +
        'null` : ou bien il ne redirige pas, ou bien il s’est donné un second ' +
        'chemin où le formulaire se sert alors que le layout peint le rail ' +
        '(#760).',
    );

    // Les deux issues existent : on redirige la session ouverte, on rend le
    // formulaire au reste. Une page qui aurait perdu son formulaire passerait la
    // première assertion sans rien servir à qui n'est pas connecté.
    assert.match(
      connexion,
      /<AdminLoginForm\b/,
      'connexion/page.tsx ne rend plus le formulaire de connexion : il n’y a ' +
        'plus d’écran pour ouvrir une session du back-office.',
    );
  });

  it('ne réécrit pas la lecture de session que le layout fait déjà', () => {
    // La divergence est le seul risque réel de cette construction : deux lectures
    // de la session, l'une décidant du rail et l'autre de la redirection,
    // finiraient par ne plus répondre la même chose — sur un refus 403, sur une
    // panne de l'API (#755), sur un compte `client`. C'est le raisonnement qui
    // met déjà `adminLandingPath` dans `navigation.ts` plutôt que dans le
    // formulaire de connexion (#618).
    for (const lecture of ['readAdminAccessToken', 'fetchOwnProfile', 'fetchPublicTenant']) {
      assert.doesNotMatch(
        connexion,
        new RegExp(`\\b${lecture}\\b`),
        `connexion/page.tsx appelle \`${lecture}\` pour son propre compte. La ` +
          'condition du rail est écrite une fois, dans `layout.tsx` : une seconde ' +
          'lecture divergera de la première au premier seuil déplacé (#760).',
      );
    }
  });
});
