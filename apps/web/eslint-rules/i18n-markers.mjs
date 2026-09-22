import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * La découverte des **marqueurs de lint i18n** (#845, second critère
 * d'acceptation).
 *
 * ## Le problème
 *
 * *« Ajouter un namespace ne demande de toucher aucun fichier central : ni une
 * liste d'imports, ni la déclaration de types des messages, ni
 * `eslint.config.mjs`. »* Les deux premiers sont réglés par convention
 * (`i18n/messages.ts`, `messages/<namespace>.d.ts`). Restait le troisième : la
 * règle qui interdit les textes en dur doit s'allumer écran par écran — un
 * ticket d'écran ne peut pas l'activer partout, les dix autres n'étant pas
 * encore traduits — et un `files: [...]` dans la configuration aurait mis les
 * onze tickets de l'épique #843 en conflit de fusion sur la même ligne.
 *
 * ## La convention
 *
 * Un ticket dépose un fichier `.i18n-lint` à la racine du répertoire qu'il vient
 * de traduire.
 *
 * - **Vide**, il couvre tout le sous-arbre :
 *   `apps/web/components/ui/.i18n-lint` allume la règle sur
 *   `components/ui/**`.
 * - **Rempli**, chaque ligne est un motif relatif à ce répertoire — c'est ce
 *   qu'il faut quand un répertoire contient des écrans traduits et d'autres qui
 *   ne le sont pas encore :
 *
 *   ```
 *   # app/.i18n-lint
 *   layout.tsx
 *   not-found.tsx
 *   ```
 *
 * Les lignes vides et celles qui commencent par `#` sont ignorées.
 *
 * Le marqueur vit dans le périmètre du ticket : deux tickets qui en déposent
 * chacun un ne se touchent pas.
 *
 * ## Pourquoi un marqueur et non une configuration imbriquée
 *
 * ESLint 9 n'a qu'un seul fichier de configuration par projet : un
 * `eslint.config.mjs` posé dans un sous-répertoire n'est jamais lu. Le marqueur
 * est la forme la plus proche — un fichier déposé sur place, découvert au
 * chargement de la configuration.
 */

/** Le nom du fichier marqueur. */
export const I18N_LINT_MARKER = '.i18n-lint';

/** Ce qu'on ne parcourt jamais — ni sources, ni marqueurs possibles. */
const SKIPPED = new Set(['node_modules', '.next', 'coverage', 'mockups', '.git']);

/** Le motif d'un sous-arbre entier, quand le marqueur est vide. */
const WHOLE_SUBTREE = '**/*.{ts,tsx}';

/**
 * Le nom d'un répertoire, rendu inoffensif pour minimatch.
 *
 * Les routes de l'App Router en ont besoin, et c'est la seule raison de cette
 * fonction : `(admin)` est un groupe de routes, `[tenantSlug]` un segment
 * dynamique — sans échappement, minimatch y lirait un groupe d'alternatives et
 * une classe de caractères, et le motif ne désignerait plus aucun fichier.
 */
function escapeSegment(segment) {
  return segment.replace(/[$^*+?()[\]{}|!]/g, (character) => `\\${character}`);
}

/**
 * Les motifs des fichiers où la règle s'applique, relatifs à `root`.
 *
 * Triés : l'ordre des blocs de configuration devient stable d'une machine à
 * l'autre, et un écart de lint ne dépend pas de l'ordre du système de fichiers.
 */
export function i18nLintedGlobs(root) {
  const globs = [];

  walk(root, []);

  function walk(absolute, segments) {
    let entries;

    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      // Un répertoire illisible n'est pas une raison de faire tomber le lint du
      // dépôt entier : il n'a simplement pas de marqueur.
      return;
    }

    const prefix = segments.map(escapeSegment).join('/');
    const marked = entries.some((entry) => entry.isFile() && entry.name === I18N_LINT_MARKER);
    const patterns = marked ? readMarker(path.join(absolute, I18N_LINT_MARKER)) : [];

    for (const pattern of patterns) {
      globs.push(prefix === '' ? pattern : `${prefix}/${pattern}`);
    }

    // Un marqueur vide couvre déjà tout le sous-arbre : descendre n'ajouterait
    // que des doublons. Un marqueur qui énumère, lui, laisse la place à un
    // marqueur plus fin dans un sous-répertoire.
    if (patterns.length === 1 && patterns[0] === WHOLE_SUBTREE) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }

      walk(path.join(absolute, entry.name), [...segments, entry.name]);
    }
  }

  return [...new Set(globs)].sort();
}

/** Les motifs déclarés par un marqueur — tout le sous-arbre s'il est vide. */
function readMarker(file) {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  return lines.length === 0 ? [WHOLE_SUBTREE] : lines;
}
