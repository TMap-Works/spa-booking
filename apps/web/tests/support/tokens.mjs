/*
 * Outillage de lecture du design system
 * =============================================================================
 *
 * Les deux suites (`contrast.test.mjs`, `tokens.test.mjs`) lisent les mêmes
 * fichiers CSS et ont besoin du même travail préparatoire : extraire les
 * déclarations de `:root`, suivre les chaînes de `var()`, convertir une couleur
 * en composantes. Ce module le fait une fois.
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
