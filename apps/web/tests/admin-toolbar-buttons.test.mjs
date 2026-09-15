/*
 * Back-office — la largeur des boutons de barre d'outils
 * =============================================================================
 *
 * Issue #674, suite de #630 et #634. La campagne `20260911-1` a relevé trois
 * largeurs pour ce qu'elle lisait comme un même rôle : 966 px, 164 px, 202 px.
 * #634 en a ramené deux à la pleine largeur de leur carte. La troisième —
 * « Enregistrer la semaine », 202 px — n'est pas un oubli, et c'est ce que
 * cette suite fige.
 *
 * ## La règle, et pourquoi elle n'était pas écrite
 *
 * `spa-button--block` ne dit pas « ce bouton est important », il dit « ce bouton
 * mesure la boîte qui le contient ». Il faut donc que cette boîte ait une
 * mesure :
 *
 *   - une **colonne de saisie bornée** en a une — `.spa-admin-form` la borne à
 *     44 rem, la carte d'un tiroir et la colonne d'un ticket à la même. Le
 *     bouton qui la conclut la prend, et un bouton court sous une pile de champs
 *     pleine largeur se lit comme un oubli. C'est la famille de #630 et #634 ;
 *   - une **barre d'outils** n'en a pas. `.spa-admin-toolbar` traverse toute la
 *     zone de contenu : un `block` y poserait un bouton de **940 px** d'un bord
 *     à l'autre de l'écran — contre-épreuve faite au navigateur sur la fiche
 *     praticien à 1280 px, la classe ajoutée à la volée faisant passer
 *     « Enregistrer la semaine » de 202 px à 940 px dans une barre de 966. C'est
 *     exactement le défaut que #634 a corrigé sur `/catalogue/rubriques`
 *     (926 px avant que sa carte soit bornée), dans l'autre sens.
 *
 * L'entretoise n'y survivrait pas non plus : le `margin-inline-start: auto` de
 * `.spa-admin-toolbar__spacer` présuppose que ce qui la suit prend sa largeur
 * naturelle. Une barre dont le dernier bouton est en pleine largeur est une
 * barre à un seul élément.
 *
 * Rien de tout cela ne se voit dans le code : les deux familles se distinguent
 * par ce qu'il y a **autour** du bouton, et une largeur automatique ressemble à
 * un oubli — c'est la lecture qu'en a faite la campagne. D'où cette suite : la
 * règle est énoncée dans `styles/README.md` §2 et rappelée au-dessus de
 * `.spa-admin-toolbar` dans `admin/shell.css`, et elle rougit ici.
 *
 * ## Ce qu'elle tient, et ce qu'elle laisse aux autres
 *
 * Elle tient **la disjonction** : aucun descendant d'une barre d'outils ne porte
 * la pleine largeur. L'autre moitié de la règle — les colonnes de saisie sont
 * bornées, et leur bouton primaire les prend — est déjà tenue par
 * `admin-form-width.test.mjs` et par `unit/category-manager.test.tsx`.
 *
 * Elle ne mesure aucun rendu : la preuve visuelle est au navigateur, phase de
 * recette de #674.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` suffisent, comme
 * pour les autres suites de style de ce dossier.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from './support/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..');

/** La classe du conteneur, et celle qui ne doit jamais vivre dessous. */
const TOOLBAR = 'spa-admin-toolbar';
const BLOCK = 'spa-button--block';

/**
 * Les sources où une barre d'outils peut exister : le back-office rendu et les
 * maquettes statiques dont `admin-mockups.test.mjs` exige qu'elles ne dérivent
 * pas de la feuille. Le parcours client public est hors de portée — il n'a pas
 * de barre d'outils, et `tokens.test.mjs` tient déjà cette frontière-là.
 */
const RACINES = [
  join(webDir, 'app', '(admin)'),
  join(webDir, 'mockups', 'admin'),
];

/** Fichiers `.tsx` et `.html` d'un dossier, en profondeur, chemins triés. */
function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(full));
    } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.html')) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Chemin lisible dans un message d'échec, séparateurs POSIX pour la CI Linux. */
function nom(file) {
  return relative(webDir, file).split(sep).join(posix.sep);
}

/**
 * Neutralise les commentaires avant toute analyse.
 *
 * Les blocs `/* … *\/` passent par l'outillage partagé, qui les remplace par des
 * blancs de même longueur pour préserver les numéros de ligne. Les lignes `//`
 * s'y ajoutent ici, parce que la prose de ces composants cite les classes
 * qu'elle décrit : le commentaire de `staff-schedule-editor.tsx` nomme la barre
 * d'outils, et une analyse qui le lirait croirait y avoir trouvé un conteneur.
 *
 * Le `//` précédé de `:` est épargné — c'est un `https://`, pas un commentaire.
 * Et le retrait des lignes `//` ne vaut **que pour le TSX** : en HTML, `//` n'est
 * jamais un commentaire, si bien qu'un `src="//…"` verrait la fin de sa ligne
 * effacée — avec son `>` ou son `class`, et la barre d'outils deviendrait soit
 * indélimitable, soit invisible.
 */
function sansCommentaires(source, { lignes }) {
  const sansBlocs = stripComments(source);
  if (!lignes) return sansBlocs;

  return sansBlocs.replace(/(^|[^:])\/\/[^\n]*/g, (found, avant) =>
    avant + ' '.repeat(found.length - avant.length),
  );
}

/**
 * L'index du `>` qui referme la balise ouvrante commencée en `debut`.
 *
 * Les accolades et les chaînes sont suivies, sans quoi le `>` d'un
 * `onClick={() => …}` passerait pour la fin de la balise et le sous-arbre
 * s'arrêterait au milieu d'un attribut. C'est le seul endroit de cette suite qui
 * demande davantage qu'une expression rationnelle.
 */
function finDeBalise(source, debut) {
  let accolades = 0;
  let guillemet = null;

  for (let i = debut + 1; i < source.length; i += 1) {
    const caractere = source[i];

    if (guillemet !== null) {
      if (caractere === guillemet) guillemet = null;
      continue;
    }
    if (caractere === '"' || caractere === "'" || caractere === '`') {
      guillemet = caractere;
    } else if (caractere === '{') {
      accolades += 1;
    } else if (caractere === '}') {
      accolades -= 1;
    } else if (caractere === '>' && accolades === 0) {
      return i;
    }
  }

  return -1;
}

/**
 * Le sous-arbre de l'élément `<balise>` ouvert en `debut`, fermeture comprise.
 *
 * Seules les balises de **même nom** sont comptées : un `<input>` imbriqué ne
 * déséquilibre donc pas le décompte d'un `<div>`. `null` si la fermeture manque
 * — le cas se signale plutôt qu'il ne s'ignore, une barre d'outils qu'on ne sait
 * pas délimiter est une barre d'outils qu'on ne vérifie pas.
 */
function sousArbre(source, debut, balise) {
  const jalons = new RegExp(`<${balise}\\b|</${balise}\\s*>`, 'g');
  jalons.lastIndex = debut;
  let profondeur = 0;
  let jalon = jalons.exec(source);

  while (jalon !== null) {
    if (jalon[0].startsWith('</')) {
      profondeur -= 1;
      if (profondeur === 0) return source.slice(debut, jalons.lastIndex);
    } else {
      const fin = finDeBalise(source, jalon.index);
      if (fin === -1) return null;
      if (source[fin - 1] !== '/') profondeur += 1;
      jalons.lastIndex = fin + 1;
    }
    jalon = jalons.exec(source);
  }

  return null;
}

/**
 * Les barres d'outils d'une source, chacune avec son sous-arbre.
 *
 * Le jeton est comparé à la liste de classes, et non cherché comme sous-chaîne :
 * `spa-admin-toolbar__hint` et `spa-admin-toolbar__group` sont employés partout
 * dans le back-office — jusque dans des paragraphes d'aide qui ne portent aucun
 * bouton — et une recherche de sous-chaîne les prendrait tous pour des barres.
 */
function barresDOutils(source) {
  const trouvees = [];

  for (const attribut of source.matchAll(/(?:class|className)="([^"]*)"/g)) {
    if (!attribut[1].split(/\s+/).includes(TOOLBAR)) continue;

    const ouverture = source.lastIndexOf('<', attribut.index);
    const balise = /^<([A-Za-z][\w.]*)/.exec(source.slice(ouverture));
    if (balise === null) continue;

    trouvees.push({ balise: balise[1], corps: sousArbre(source, ouverture, balise[1]) });
  }

  return trouvees;
}

/** Les balises `<Button …>` d'un fragment, attributs compris. */
function boutons(corps) {
  const trouves = [];

  for (const ouverture of corps.matchAll(/<Button\b/g)) {
    const fin = finDeBalise(corps, ouverture.index);
    trouves.push(fin === -1 ? corps.slice(ouverture.index) : corps.slice(ouverture.index, fin + 1));
  }

  return trouves;
}

/** Les barres d'outils du back-office et des maquettes, source par source. */
const barres = RACINES.flatMap((racine) =>
  sources(racine).flatMap((fichier) =>
    barresDOutils(
      sansCommentaires(readFileSync(fichier, 'utf8'), { lignes: fichier.endsWith('.tsx') }),
    ).map((barre) => ({
      ...barre,
      fichier: nom(fichier),
    })),
  ),
);

describe('Les barres d’outils du back-office sont délimitables', () => {
  it('en trouve dans le back-office et dans les maquettes', () => {
    /*
     * Le plancher n'est pas un décompte : c'est ce qui empêche la suite de
     * devenir verte en devenant vide. Une classe renommée, un dossier déplacé,
     * un `className` passé en expression, et toutes les assertions ci-dessous
     * porteraient sur zéro élément sans que rien ne rougisse.
     */
    assert.ok(
      barres.length >= 10,
      `${String(barres.length)} barre(s) d’outils trouvée(s) sous \`app/(admin)\` et ` +
        '`mockups/admin`. Le back-office en porte une par écran : un décompte ' +
        'qui s’effondre veut dire que l’analyse ne trouve plus ce qu’elle ' +
        'vérifie, pas que la règle est tenue.',
    );
  });

  it('referme chacune d’elles', () => {
    const orphelines = barres.filter((barre) => barre.corps === null);

    assert.deepEqual(
      orphelines.map((barre) => `${barre.fichier} (<${barre.balise}>)`),
      [],
      'une barre d’outils n’a pas de balise fermante repérable : son contenu ' +
        'échappe alors à la vérification ci-dessous, et le défaut de #674 ' +
        'pourrait y rentrer sans bruit.',
    );
  });
});

describe('Aucun bouton de barre d’outils ne prend la pleine largeur', () => {
  it('ne passe `block` à aucun `<Button>` d’une barre d’outils', () => {
    const fautifs = [];

    for (const barre of barres) {
      if (barre.corps === null) continue;

      for (const bouton of boutons(barre.corps)) {
        // Le mot entier, et non la sous-chaîne : `blocked` et `blocker` sont
        // deux noms courants de ce dépôt — l'encaissement en emploie un pour
        // dire pourquoi la vente est impossible.
        if (/[\s{]block(?=[\s=/>}])/.test(bouton)) {
          fautifs.push(`${barre.fichier} : ${bouton.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }

    assert.deepEqual(
      fautifs,
      [],
      `${String(fautifs.length)} bouton(s) de barre d’outils en pleine largeur : ` +
        `${fautifs.join(' | ')}. \`block\` fait mesurer au bouton la boîte qui le ` +
        'contient, et une barre d’outils n’en est pas une — elle traverse toute ' +
        'la zone de contenu, sans la borne de 44 rem d’une colonne de saisie. Le ' +
        'bouton y ferait 940 px d’un bord à l’autre de l’écran, et l’entretoise ' +
        '`__spacer` n’aurait plus rien à pousser (#674, §2 de `styles/README.md`).',
    );
  });

  it('ne pose `spa-button--block` sur aucun élément d’une barre d’outils', () => {
    /*
     * La seconde porte, et elle est ouverte : une barre d'outils contient aussi
     * des `<Link className="spa-button …">` — le retour « ← Personnel » de la
     * fiche praticien en est un — et les maquettes n'ont que du `<button>` nu.
     * Ni l'un ni l'autre ne passe par la prop `block` de `components/ui/button`.
     */
    const fautives = barres.filter(
      (barre) => barre.corps !== null && barre.corps.includes(BLOCK),
    );

    assert.deepEqual(
      fautives.map((barre) => barre.fichier),
      [],
      `\`${BLOCK}\` est posé dans une barre d’outils. La classe donne au bouton ` +
        'la largeur de son conteneur : sous une colonne bornée à 44 rem elle ' +
        'vaut 670 px et finit proprement le formulaire (#630, #634) ; sous une ' +
        'barre d’outils elle vaut toute la zone de contenu.',
    );
  });
});
