import { readdirSync } from 'node:fs';
import path from 'node:path';

import { LOCALES, type Locale } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { loadMessages, messagesRoot, namespacesOf, type MessageTree } from '@/i18n/messages';

/**
 * La parité des catalogues — #845, quatrième critère d'acceptation : *« un test
 * échoue si les catalogues `fr` et `en` n'ont pas exactement les mêmes clés »*.
 *
 * ## Pourquoi ce test et non le typage
 *
 * `tsc` connaît la forme du catalogue par ses `messages/<namespace>.d.ts`, qui
 * lisent tous la version **anglaise** — la langue par défaut du système, donc la
 * seule dont l'existence soit garantie. Une clé présente en anglais et oubliée
 * en français compile donc parfaitement, et ne se découvre qu'à l'écran, en
 * production, sous la forme d'une clé brute.
 *
 * C'est ce trou-là que ce test ferme, et il le fait **par convention** : il
 * parcourt `messages/` au lieu d'énumérer les namespaces. Un ticket d'écran qui
 * en ajoute un est couvert sans toucher ce fichier.
 */

/** Toutes les clés d'un arbre de messages, aplaties et triées. */
function flatKeys(tree: MessageTree, prefix = ''): string[] {
  return Object.entries(tree)
    .flatMap(([key, value]) => {
      const full = prefix === '' ? key : `${prefix}.${key}`;

      return typeof value === 'string' ? [full] : flatKeys(value, full);
    })
    .sort();
}

/**
 * Les paramètres `{nom}` attendus par un message.
 *
 * ## Pourquoi ce n'est pas une expression régulière — #852
 *
 * Parce qu'une accolade ICU veut dire deux choses selon l'endroit où elle est :
 * dans un **message**, `{` ouvre un paramètre — `{term}`, `{count, plural, …}` ;
 * dans les **options** d'un `plural` ou d'un `select`, elle ouvre un
 * sous-message, dont le texte est du français ou de l'anglais et non un nom de
 * paramètre.
 *
 * L'expression régulière d'origine ne faisait pas la différence. Elle tenait
 * tant qu'une seule branche par pluriel commençait par une lettre — c'est le cas
 * de `{count, plural, =0 {Aucun salon} one {# salon} …}`, dont le `=0` est
 * avalé par le premier motif et dont les suivantes commencent par `#`. Le
 * premier libellé **entièrement** composé de mots l'a mise en défaut :
 * `{count, plural, one {Visite honorée} other {Visites honorées}}` déclarait
 * « Visites » comme paramètre en français et « Completed » en anglais, et deux
 * catalogues corrects se voyaient refusés.
 *
 * Le parcours ci-dessous tient une pile de ce qu'il traverse, et il est du même
 * coup **plus juste** que ce qu'il remplace : un paramètre imbriqué dans une
 * branche — `other {# rendez-vous de {name}}` — était invisible avant, il est
 * compté maintenant.
 */
function placeholders(message: string): string[] {
  const found = new Set<string>();
  /** Ce qu'on traverse : le corps d'un message, ou les options d'un paramètre. */
  const stack: ('message' | 'options')[] = ['message'];

  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];

    if (char === '}') {
      // Une accolade fermante orpheline est du texte : la pile garde son fond.
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    if (char !== '{') {
      continue;
    }

    if (stack[stack.length - 1] === 'options') {
      // Un sous-message de `plural` ou de `select` : son texte n'est pas un nom,
      // mais il peut porter des paramètres à lui.
      stack.push('message');
      continue;
    }

    const named = /^\s*(\w+)/.exec(message.slice(index + 1));

    if (named !== null) {
      found.add(named[1] ?? '');
    }

    stack.push('options');
  }

  return [...found].sort();
}

/** Les feuilles d'un arbre, par clé aplatie. */
function leaves(tree: MessageTree, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>();

  for (const [key, value] of Object.entries(tree)) {
    const full = prefix === '' ? key : `${prefix}.${key}`;

    if (typeof value === 'string') {
      entries.set(full, value);
    } else {
      for (const [nested, message] of leaves(value, full)) {
        entries.set(nested, message);
      }
    }
  }

  return entries;
}

const REFERENCE: Locale = 'en';

describe('les catalogues de messages', () => {
  it('existent pour chaque langue du contrat', () => {
    for (const locale of LOCALES) {
      expect(namespacesOf(locale).length).toBeGreaterThan(0);
    }
  });

  it('portent exactement les mêmes namespaces dans les deux langues', () => {
    const reference = namespacesOf(REFERENCE);

    for (const locale of LOCALES) {
      expect(namespacesOf(locale)).toEqual(reference);
    }
  });

  it('déclarent chacun leur type — un `messages/<namespace>.d.ts` par namespace', () => {
    // C'est ce qui tient le troisième critère du ticket : une clé absente fait
    // échouer `tsc`. Un namespace sans déclaration compilerait, mais ses clés ne
    // seraient vérifiées par personne.
    const declarations = new Set(
      readdirSync(messagesRoot(), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
        .map((entry) => entry.name.slice(0, -'.d.ts'.length)),
    );

    for (const namespace of namespacesOf(REFERENCE)) {
      expect(declarations, `messages/${namespace}.d.ts manque`).toContain(namespace);
    }
  });

  it('portent exactement les mêmes clés dans les deux langues', () => {
    const reference = flatKeys(loadMessages(REFERENCE));

    for (const locale of LOCALES) {
      expect(flatKeys(loadMessages(locale)), `écart de clés sur « ${locale} »`).toEqual(reference);
    }
  });

  it('attendent les mêmes paramètres pour une même clé', () => {
    // Une traduction qui perd son `{salonName}` ne fait pas échouer `tsc` : elle
    // affiche « Bienvenue chez » et s'arrête là.
    const reference = leaves(loadMessages(REFERENCE));

    for (const locale of LOCALES) {
      for (const [key, message] of leaves(loadMessages(locale))) {
        expect(placeholders(message), `paramètres de « ${key} » en « ${locale} »`).toEqual(
          placeholders(reference.get(key) ?? ''),
        );
      }
    }
  });

  it('n’ont aucun message vide', () => {
    for (const locale of LOCALES) {
      for (const [key, message] of leaves(loadMessages(locale))) {
        expect(message.trim(), `« ${key} » est vide en « ${locale} »`).not.toBe('');
      }
    }
  });

  it('nomment chaque langue dans sa propre langue, à l’identique partout', () => {
    // « Français » et « English », jamais « French » ni « Anglais » : le
    // sélecteur doit être lisible par qui ne lit pas la langue affichée. Les
    // deux catalogues portent donc les mêmes valeurs.
    const names = LOCALES.map((locale) => {
      const catalog = loadMessages(locale).locale as MessageTree;

      return catalog.names;
    });

    expect(names[0]).toEqual({ fr: 'Français', en: 'English' });

    for (const entry of names) {
      expect(entry).toEqual(names[0]);
    }
  });

  it('sont rangés un fichier par namespace et par langue', () => {
    // La convention qui permet d'ajouter un namespace sans toucher aucun fichier
    // central : le nom du fichier *est* le namespace.
    for (const locale of LOCALES) {
      const files = readdirSync(path.join(messagesRoot(), locale), { withFileTypes: true });

      for (const file of files) {
        expect(file.isFile(), `${locale}/${file.name} n’est pas un fichier`).toBe(true);
        expect(file.name).toMatch(/^[a-z0-9-]+\.json$/);
      }
    }
  });
});
