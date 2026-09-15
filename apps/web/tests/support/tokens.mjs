/*
 * Outillage de lecture du design system
 * =============================================================================
 *
 * Les suites de style lisent les mêmes fichiers CSS et ont besoin du même
 * travail préparatoire : localiser une feuille, neutraliser ses commentaires,
 * extraire les déclarations de `:root`, suivre les chaînes de `var()`,
 * convertir une couleur en composantes, relire les règles d'un sélecteur
 * donné, y lire la valeur d'une propriété. Ce module le fait une fois.
 *
 * `contrast.test.mjs` et `tokens.test.mjs` en furent les premiers clients ; les
 * suites de mise en page l'ont rejoint à mesure qu'elles répétaient le même
 * petit lecteur de règles, que #657 a commencé d'y rassembler et que #683 a fini
 * d'y ramener — avec le filtre qui pare son piège, `withoutMediaQueries`. Le
 * lecteur de déclarations les a suivies (#713) : il accompagne `rulesFor` partout
 * où elle est appelée, et se déplaçait donc avec elle ou pas du tout.
 *
 * Aucune dépendance : `node:test`, `node:assert` et `node:fs` sont fournis par
 * la plateforme. Le design system ne peut pas ajouter de paquet — `package.json`
 * et `package-lock.json` sont à la racine du dépôt, hors de son périmètre.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Racine des feuilles de style du design system. */
export const stylesDir = join(here, '..', '..', 'styles');

/** Chemin du fichier de jetons — seul endroit où une couleur littérale est permise. */
export const tokensFile = join(stylesDir, 'tokens.css');

/**
 * Les points d'entrée du front, un par produit de `apps/web`.
 *
 * `index.css` porte les jetons, le socle et les six composants de base : les deux
 * produits en ont besoin, il est importé par le layout racine. `admin/index.css`
 * porte le chrome du tableau de bord — calendrier, grille d'horaires, écran
 * d'encaissement — que le parcours client public n'affiche jamais et qui n'a donc
 * pas à peser sur son LCP (skill web-frontend §7).
 *
 * Toute feuille ajoutée sous `styles/` doit être atteignable depuis exactement
 * l'un des deux, directement ou par transitivité.
 */
export const entryPoints = ['index.css', 'admin/index.css'];

/** Chemin absolu d'une feuille désignée par son nom relatif POSIX. */
export function styleSheetPath(name) {
  return join(stylesDir, ...name.split(posix.sep));
}

/**
 * Feuilles importées par `file`, en noms relatifs à `styles/`.
 *
 * Les chemins sont résolus depuis le dossier du fichier importateur, et non
 * depuis `styles/` : `admin/index.css` écrit `./calendar.css` et désigne bien
 * `admin/calendar.css`.
 */
export function readImportedSheets(file) {
  const css = stripComments(readStyleSheet(file));
  const from = dirname(file);
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((match) =>
    relativeName(join(from, match[1])),
  );
}

/**
 * Parcourt le graphe d'imports depuis les points d'entrée.
 *
 * Renvoie `owner` — feuille → point d'entrée qui l'atteint — et `duplicates`, les
 * feuilles atteintes deux fois. Une feuille importée par les deux entrées y
 * figure : elle serait chargée en double sur le tableau de bord, et l'ordre de
 * cascade cesserait d'être lisible.
 *
 * Une feuille importée mais absente du disque est enregistrée sans être suivie :
 * elle ressort alors comme import orphelin dans la comparaison avec le contenu
 * réel de `styles/`, plutôt qu'en `ENOENT` sans explication.
 */
export function walkEntryPoints(entries = entryPoints) {
  const owner = new Map();
  const duplicates = [];

  for (const entry of entries) {
    const queue = [entry];
    while (queue.length > 0) {
      const sheet = queue.shift();
      if (owner.has(sheet)) {
        duplicates.push(sheet);
        continue;
      }
      owner.set(sheet, entry);

      const full = styleSheetPath(sheet);
      if (existsSync(full)) queue.push(...readImportedSheets(full));
    }
  }

  return { owner, duplicates };
}

/**
 * Tous les fichiers `.css` du design system, chemins relatifs à `styles/` et
 * normalisés en séparateurs POSIX pour que les messages d'échec soient
 * identiques sur Windows et sur le runner Linux de la CI.
 */
export function listStyleSheets(dir = stylesDir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listStyleSheets(full));
    } else if (entry.name.endsWith('.css')) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Chemin lisible dans un message d'échec : `components/button.css`. */
export function relativeName(file) {
  return relative(stylesDir, file).split(sep).join(posix.sep);
}

export function readStyleSheet(file) {
  return readFileSync(file, 'utf8');
}

/**
 * Neutralise les commentaires `/* … *\/` avant toute analyse.
 *
 * Ils sont remplacés par des blancs de même longueur plutôt que supprimés : les
 * en-têtes de ces feuilles font trente lignes, et une suppression décalerait
 * tous les numéros de ligne des messages d'échec — « button.css:12 » pointerait
 * alors une ligne sans rapport avec la couleur fautive.
 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  );
}

/**
 * Les blocs de déclarations des règles dont la liste de sélecteurs contient
 * **exactement** `selector`.
 *
 * L'égalité, et jamais la sous-chaîne : `.spa-booking__recap` est un préfixe de
 * `.spa-booking__recap-row` comme de `.spa-booking__recap-term`, et une
 * recherche par sous-chaîne rendrait vraie n'importe quelle assertion dès que
 * l'une des trois règles existe. Plus insidieux encore, une déclaration
 * déplacée de la règle de base vers une règle plus spécifique laisserait
 * l'assertion verte alors que le sélecteur vérifié aurait perdu le
 * comportement — c'est le raisonnement écrit et réécrit en #615, #628, #630 et
 * #636, une fois par suite qui recopiait ce lecteur. C'est ce qui a valu à la
 * fonction de monter ici (#657).
 *
 * Les suites de mise en page l'importent toutes — `admin-report-filters-layout`,
 * `admin-checkout-layout`, `admin-catalog-rhythm`, `admin-form-width`,
 * `admin-login-layout`, `admin-screen-rhythm`, `booking-recap-columns`,
 * `booking-step-rhythm` — et aucune n'en porte plus de copie locale (#683).
 * **Toute suite nouvelle importe celle-ci**, il n'y a plus de raison d'en écrire
 * une neuvième. Le lecteur de déclarations qui l'accompagne est juste en dessous
 * de `withoutMediaQueries` : il a fait le même chemin (#713), à une copie près
 * que sa documentation nomme.
 *
 * ## Ce que cette lecture fait des at-rules — #657
 *
 * Elle les **aplatit**. C'est le contraire d'un angle mort, et c'est le piège à
 * connaître avant de s'en servir. Le corps borné à `[^{}]*` interdit à une
 * règle imbriquée d'être lue avec son enveloppe : l'expression échoue sur
 * `@media (…) {`, l'analyse repart après l'accolade, et retrouve la règle
 * intérieure comme si elle était posée à la racine. Une règle sous `@media`,
 * `@supports` ou `@container` est donc bien vue — mais dépouillée de la
 * condition qui la gouverne.
 *
 * La conséquence est un faux positif, jamais un faux négatif : un palier qui
 * redéclare `.spa-admin__content` **avec** une gouttière fournit à lui seul
 * l'assertion, et la gouttière peut alors disparaître de la mise en page
 * nominale — celle que la QA mesure — sans que rien ne le signale (#633).
 * Quand la condition compte, filtrer la feuille avant de la lire avec
 * `withoutMediaQueries`, juste en dessous : la parade se lit avec le piège, et
 * c'est pour cela que les deux voisinent.
 *
 * Seul le prélude d'une at-rule sans règle imbriquée — `@font-face`, `@page` —
 * se présente comme une liste de sélecteurs. Il ne peut égaler aucun sélecteur
 * CSS, et ne remonte donc jamais.
 */
export function rulesFor(css, selector) {
  const wanted = selector.trim().replace(/\s+/g, ' ');
  const found = [];
  for (const [, prelude, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = prelude.split(',').map((one) => one.trim().replace(/\s+/g, ' '));
    if (selectors.includes(wanted)) found.push(body);
  }
  return found;
}

/**
 * Retire les blocs `@media` d'une feuille, pour la lire ensuite avec `rulesFor`.
 *
 * La parade de l'aplatissement décrit juste au-dessus. Une suite qui affirme
 * quelque chose de la mise en page **nominale** — celle que la QA mesure sur un
 * écran large — doit filtrer avant de lire, sinon un palier lui fournit
 * l'assertion à la place de la règle de base. Le défaut a deux occurrences
 * connues, une par suite qui a eu besoin du filtre :
 *
 * - `admin-form-width` (#630) : sous 60 rem, `admin/checkout.css` rend
 *   `.spa-admin-checkout` à une seule colonne. Non filtrée, cette règle de palier
 *   passe pour la déclaration de base et fait conclure que la colonne du ticket
 *   n'est plus bornée.
 * - `admin-catalog-rhythm` (#633) : sous 360 px, `admin/shell.css` redéclare
 *   `.spa-admin__content` **avec** un `gap` et `.spa-admin__section` **sans**.
 *   Non filtrés, les deux blocs sont lus comme un seul : la gouttière de base
 *   peut disparaître de `.spa-admin__content` — le palier la fournit — et le
 *   défaut rouvre en vert sur l'écran large.
 *
 * L'accolade fermante du bloc de média est reconnue à sa position en début de
 * ligne, celle des règles imbriquées étant indentée. Même ruse que la lecture
 * des deux blocs de `tokens.css`, et pour la même raison : une analyse CSS
 * complète serait une dépendance de plus dans un dossier qui n'en a aucune.
 *
 * Le filtre est donc **volontairement absent de `rulesFor`** : une suite qui veut
 * au contraire voir les paliers — parce que c'est d'eux qu'elle parle — lit la
 * feuille telle quelle.
 */
export function withoutMediaQueries(css) {
  return css.replace(/@media[^{]*\{[\s\S]*?\n\}/g, '');
}

/**
 * La valeur d'une propriété dans un bloc de déclarations, ou `null`.
 *
 * Le pendant de `rulesFor`, et c'est pour cela qu'il la suit : on ne lit pas une
 * règle pour la règle, on la lit pour interroger une de ses propriétés. Les deux
 * appels s'écrivent toujours ensemble — `declaration(rulesFor(css, sel).join(' '),
 * 'gap')` — et n'ont donc aucune raison de vivre à deux endroits. Trois suites en
 * portaient chacune une copie octet pour octet et l'importent désormais (#713) :
 * `admin-catalog-rhythm`, `admin-form-width`, `admin-login-layout`.
 *
 * **Une quatrième copie subsiste**, dans `admin-screen-rhythm.test.mjs` (#717).
 * Elle est arrivée après l'ouverture de #713, dont elle sort de l'empreinte, et
 * c'est #722 qui la reprend — même enchaînement que #712 → #713. Tant qu'elle est
 * là, une correction apportée ici ne l'atteint pas : c'est la dernière suite qui
 * puisse encore lire les feuilles selon l'ancienne règle en restant verte.
 *
 * ## Ce que la lecture garantit, et ce qu'elle ne garantit pas
 *
 * Ce n'est pas un analyseur CSS, c'est une expression régulière — même parti pris
 * que `rulesFor`, et pour la même raison : ce dossier n'a aucune dépendance.
 * Quatre traits en découlent, à connaître avant de s'en servir.
 *
 * 1. **Le nom est borné des deux côtés**, et chaque borne pare un défaut distinct.
 *    À gauche, `(?:^|;|\s)` interdit d'apparier un **suffixe** : sans elle,
 *    demander `direction` trouverait `flex-direction: column`. À droite, `\s*:`
 *    interdit d'apparier un **préfixe** : `margin` ne peut pas être lu dans
 *    `margin-inline: auto`. C'est de cette seconde borne que vit
 *    `admin-login-layout`, qui exige `margin-inline: auto` sur la carte de
 *    connexion **et** l'absence de `margin` sur `.spa-admin-form` (#699) — deux
 *    assertions que la même chaîne doit satisfaire en sens contraire.
 * 2. **La première occurrence gagne.** Un bloc qui redéclare la même propriété
 *    deux fois — ce que la cascade autorise — est lu selon la première, alors que
 *    le navigateur applique la dernière. Aucune feuille du design system ne le
 *    fait ; si l'une s'y met, c'est ici qu'il faudra le corriger.
 * 3. **Les raccourcis ne sont pas développés**, et `!important` reste dans la
 *    valeur rendue. Demander `gap` ne trouve pas un `gap` posé par un raccourci,
 *    et une valeur écrite `auto !important` ne s'apparie pas à `'auto'`.
 * 4. **La valeur s'arrête au premier `;`**, y compris s'il est entre parenthèses.
 *    Une `background-image: url("data:image/svg+xml;utf8,…")` serait donc lue
 *    tronquée. Le design system ne peint aucune image en ligne — ses illustrations
 *    passent par `next/image` (web-frontend §7) —, mais c'est l'un des trois
 *    correctifs que #713 rend possibles en un seul endroit.
 *
 * Le nom de propriété est injecté tel quel dans l'expression : les appelants
 * passent des littéraux — `'gap'`, `'max-inline-size'` —, pas des chaînes
 * construites, et aucun nom de propriété CSS ne porte de métacaractère.
 *
 * Que ces quatre traits soient écrits **une fois** est tout l'objet de #713. Une
 * correction apportée à l'une des copies laissait les autres suites lire les
 * feuilles selon l'ancienne règle, sans qu'aucune ne devienne rouge : un faux
 * vert, et non un échec.
 */
export function declaration(body, property) {
  const found = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  return found === null ? null : found[1].trim().replace(/\s+/g, ' ');
}

/**
 * Déclarations de propriétés personnalisées du bloc `:root` de `tokens.css`.
 * Renvoie une Map `--spa-…` → valeur brute (littéral ou `var(--autre)`).
 */
export function readTokenDeclarations() {
  const css = stripComments(readStyleSheet(tokensFile));
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) {
    throw new Error('tokens.css : aucun bloc :root trouvé.');
  }

  const declarations = new Map();
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = pattern.exec(root[1])) !== null) {
    declarations.set(match[1], match[2].trim().replace(/\s+/g, ' '));
  }
  return declarations;
}

/**
 * Déclarations du bloc `@media (prefers-color-scheme: dark)` de `tokens.css`.
 *
 * Le thème sombre (#75) ne redéfinit que des **primitives** : les rôles
 * sémantiques du bloc `:root` clair délèguent tous à une primitive, si bien que
 * les redéfinir toutes fait basculer les quarante-cinq rôles d'un coup. C'est
 * `tokens.test.mjs` qui garde cette propriété ; ici on se contente de lire.
 *
 * L'accolade fermante du bloc de média est reconnue à sa position en début de
 * ligne — celle du `:root` imbriqué est indentée. Même ruse que la lecture du
 * `:root` clair, et pour la même raison : une analyse CSS complète pour deux
 * blocs serait une dépendance de plus dans un dossier qui n'en a aucune.
 */
export function readDarkTokenDeclarations() {
  const css = stripComments(readStyleSheet(tokensFile));
  const media = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/);
  if (!media) {
    throw new Error('tokens.css : aucun bloc @media (prefers-color-scheme: dark) trouvé.');
  }

  const root = media[1].match(/:root\s*\{([\s\S]*?)\n\s+\}/);
  if (!root) {
    throw new Error('tokens.css : le bloc sombre ne déclare aucun :root.');
  }

  const declarations = new Map();
  const pattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = pattern.exec(root[1])) !== null) {
    declarations.set(match[1], match[2].trim().replace(/\s+/g, ' '));
  }
  return declarations;
}

/**
 * Les jetons tels qu'ils se résolvent dans un thème donné.
 *
 * `clair` rend le bloc `:root` seul ; `sombre` rend ce même bloc **recouvert**
 * par les primitives du bloc de média. C'est exactement ce que fait la cascade
 * du navigateur, et c'est ce qui permet à `contrast.test.mjs` de rejouer les
 * mêmes paires sur les deux thèmes sans les écrire deux fois.
 */
export function readSchemeDeclarations(scheme) {
  const base = readTokenDeclarations();

  if (scheme === 'clair') {
    return base;
  }

  const merged = new Map(base);
  for (const [name, value] of readDarkTokenDeclarations()) {
    merged.set(name, value);
  }
  return merged;
}

/**
 * Suit une chaîne `var()` jusqu'à sa valeur littérale.
 *
 * C'est ce qui donne sa portée au test de contraste : il énonce des paires en
 * noms sémantiques (« texte sur surface »), mais vérifie les couleurs réellement
 * peintes. Changer une primitive sous un rôle fait donc échouer la suite, ce qui
 * est précisément le contrat annoncé aux salons qui substituent leur rampe.
 */
export function resolveToken(declarations, name, seen = new Set()) {
  if (seen.has(name)) {
    throw new Error(`tokens.css : référence circulaire sur ${name}.`);
  }
  seen.add(name);

  const raw = declarations.get(name);
  if (raw === undefined) {
    throw new Error(`tokens.css : jeton ${name} non déclaré.`);
  }

  const reference = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return reference ? resolveToken(declarations, reference[1], seen) : raw;
}

/**
 * Convertit une couleur opaque en composantes 0–255.
 * Formes acceptées : `#rgb`, `#rrggbb`, `rgb(r g b)`, `rgb(r, g, b)`.
 * Renvoie `null` pour tout le reste — une couleur translucide n'a pas de
 * rapport de contraste défini tant qu'on ne la compose pas.
 */
export function parseOpaqueColor(value) {
  const text = value.trim().toLowerCase();

  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits =
      hex[1].length === 3
        ? hex[1]
            .split('')
            .map((d) => d + d)
            .join('')
        : hex[1];
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    };
  }

  const rgb = text.match(/^rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*\)$/);
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }

  return null;
}

/** Luminance relative — WCAG 2.2, définition normative. */
export function relativeLuminance({ r, g, b }) {
  const linear = (component) => {
    const ratio = component / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Rapport de contraste entre deux couleurs opaques — WCAG 2.2 (1.4.3, 1.4.11). */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a >= b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rapport de contraste entre deux jetons sémantiques, par leur nom. */
export function tokenContrast(declarations, foregroundToken, backgroundToken) {
  const readColor = (token) => {
    const literal = resolveToken(declarations, token);
    const color = parseOpaqueColor(literal);
    if (!color) {
      throw new Error(
        `${token} vaut « ${literal} », qui n'est pas une couleur opaque analysable.`,
      );
    }
    return color;
  };
  return contrastRatio(readColor(foregroundToken), readColor(backgroundToken));
}
