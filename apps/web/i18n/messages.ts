import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { LOCALES, type Locale } from '@spa/shared';

/**
 * Les catalogues de messages, **découverts par convention** — #845.
 *
 * ## La règle qui a dicté ce fichier
 *
 * *« Ajouter un namespace ne demande de toucher aucun fichier central : ni une
 * liste d'imports, ni la déclaration de types des messages, ni
 * `eslint.config.mjs`. »* C'est le second critère d'acceptation de #845, et ce
 * n'est pas une coquetterie : onze tickets d'écrans de l'épique #843 ajoutent
 * chacun leur namespace, et une liste centrale les aurait mis en conflit de
 * fusion les uns avec les autres — le run les aurait alors sérialisés au lieu de
 * les mener de front.
 *
 * D'où la convention, et rien qu'elle : **un fichier par namespace et par
 * langue**, `messages/<langue>/<namespace>.json`. Le nom du fichier *est* le
 * namespace. Déposer `messages/fr/booking.json` et `messages/en/booking.json`
 * suffit à rendre `useTranslations('booking')` utilisable, sans qu'aucune ligne
 * ne soit ajoutée nulle part.
 *
 * ## Pourquoi le système de fichiers et non un `import` dynamique
 *
 * Trois lecteurs doivent voir les mêmes catalogues : le serveur Next, `tsc`, et
 * les suites de tests (Vitest et `node --test`). Un `require.context` de webpack
 * n'existe que dans le premier ; un `import.meta.glob` de Vite, que dans le
 * troisième. `readdirSync` fonctionne à l'identique dans les trois, sans magie
 * de bundler à réexpliquer à chaque outil ajouté.
 *
 * Le prix est un réglage, une fois pour toutes : `outputFileTracingIncludes`
 * dans `next.config.mjs` embarque `messages/**` dans la sortie autonome, que
 * l'analyse statique de Next ne verrait pas passer. Le motif est un glob — il ne
 * change pas quand un namespace s'ajoute.
 *
 * ## Le chemin de base
 *
 * `process.cwd()` et non `import.meta.url` : ce module est **empaqueté** par
 * webpack dans `.next/server/`, où son URL ne désigne plus le dépôt. Le
 * répertoire courant, lui, est `apps/web` sous `next dev`, `next build`, Vitest
 * et `node --test`, et `.next/standalone/apps/web` sous le serveur autonome, qui
 * y fait son `chdir` — dans les cinq cas, `messages/` est bien là.
 */

/** Le répertoire des catalogues, tel que le processus courant le voit. */
export function messagesRoot(): string {
  return path.join(process.cwd(), 'messages');
}

/**
 * Les namespaces disponibles pour cette langue, triés.
 *
 * Triés, et c'est ce qui rend le test de parité des clés lisible : deux
 * catalogues comparés dans un ordre stable nomment le fichier qui manque, là où
 * un ordre de système de fichiers aurait rendu l'écart différent d'une machine à
 * l'autre.
 */
export function namespacesOf(locale: Locale): readonly string[] {
  return readdirSync(path.join(messagesRoot(), locale), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}

/** Ce qu'un catalogue contient : un arbre de chaînes, tel que next-intl le lit. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/**
 * En production, le disque n'est lu qu'une fois par langue et par processus : un
 * catalogue ne change pas sous un serveur qui tourne.
 *
 * En développement, jamais de cache — un message corrigé doit s'afficher au
 * rechargement, pas au redémarrage.
 */
const CACHE = new Map<Locale, MessageTree>();

/** Tous les messages d'une langue, namespace par namespace. */
export function loadMessages(locale: Locale): MessageTree {
  const cached = CACHE.get(locale);

  if (cached !== undefined) {
    return cached;
  }

  const root = messagesRoot();
  const messages: Record<string, MessageTree> = {};

  for (const namespace of namespacesOf(locale)) {
    messages[namespace] = JSON.parse(
      readFileSync(path.join(root, locale, `${namespace}.json`), 'utf8'),
    ) as MessageTree;
  }

  if (process.env.NODE_ENV === 'production') {
    CACHE.set(locale, messages);
  }

  return messages;
}

/** Les langues dont un catalogue existe sur le disque — pour les tests de parité. */
export function catalogLocales(): readonly Locale[] {
  return LOCALES;
}
