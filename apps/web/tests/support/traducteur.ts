import type { Locale } from '@spa/shared';
import { vi } from 'vitest';

import type { MessageTree } from '../../i18n/messages';

/**
 * Les doublures de langue de `next-intl`, écrites **une fois** — #1283.
 *
 * ## Ce que ce fichier retire du dispositif
 *
 * Trois doublures de `next-intl` cohabitent dans les suites : l'amorce qui fixe
 * la langue à `fr` pour toutes (`next-intl.ts`), la langue mobile des suites qui
 * rendent la même brique dans les deux langues (`langue-mobile.ts`), et la
 * langue figée des suites écrites en anglais (`langue-figee.ts`). Elles montaient
 * chacune leur formateur, avec leur cache — trois écritures du même mécanisme,
 * qui pouvaient diverger sans que rien ne le dise.
 *
 * Il n'y en a plus qu'une, ici : le formateur, et **le corps des deux doublures**
 * qui s'en servent. Les trois points d'emploi n'ont plus à décider *quoi*
 * formater ni *comment* remplacer le module ; ils ne décident que d'une chose,
 * `lireLangue` — une constante pour l'amorce et la langue figée, une variable
 * pour la langue mobile —, et c'est tout ce qui les distingue.
 *
 * ## Le vrai formateur, sur les vrais catalogues
 *
 * `createTranslator` est le formateur ICU de `next-intl`, appelé sur les
 * catalogues du dépôt tels que `loadMessages` les lit — comme le serveur les
 * lit. Un test qui vérifie « Bienvenue chez Maison Lotus » éprouve donc le vrai
 * message et la vraie substitution de paramètres, et une clé manquante dans
 * `messages/<langue>/` échoue ici comme elle échouerait en production.
 *
 * ## Pourquoi deux caches
 *
 * `createTranslator` **monte un formateur ICU** : sans mémoïsation il serait
 * rappelé à chaque rendu de chaque composant — `Button` lit `ui.button` sur tous
 * ses rendus, et un écran qui en affiche trente en paierait trente par passe. Le
 * vrai `useTranslations` ne fait rien de tel : il mémoïse sur le contexte de la
 * requête. La doublure doit donc mémoïser aussi, sans quoi elle mesure son
 * propre coût et non celui du composant.
 *
 * Le second cache est celui des **catalogues** : `loadMessages` ne garde les
 * siens qu'en production (`i18n/messages.ts`), et relit donc les sept fichiers
 * d'une langue à chaque appel sous Vitest. Une fois par langue suffit — rien
 * n'écrit dans `messages/` pendant une suite.
 *
 * La clé du premier porte la langue **et** le namespace : deux doublures de la
 * même suite — les crochets et le serveur — lisent le même namespace, et rien ne
 * justifierait de le formater deux fois.
 */

/** Le traducteur d'un namespace, dans la langue demandée. */
export type Traduire = (locale: Locale, namespace?: string) => unknown;

/**
 * Le formateur, monté à la demande et une seule fois par fichier de test.
 *
 * À la demande, parce que `vi.mock` est hissé : les catalogues ne doivent être
 * lus qu'à la première évaluation d'une fabrique de doublure, pas au chargement
 * de ce module.
 */
let formateur: Promise<Traduire> | undefined;

/** Le formateur partagé par les doublures de langue. */
export function traducteur(): Promise<Traduire> {
  formateur ??= (async (): Promise<Traduire> => {
    const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
    const { loadMessages } = await import('../../i18n/messages');

    /**
     * `createTranslator` est typé sur le catalogue complet ; l'appeler avec un
     * namespace dont le nom n'est connu qu'à l'exécution demande de relâcher la
     * contrainte, une fois, ici. Le comportement, lui, est celui de la
     * bibliothèque.
     */
    const creer = actual.createTranslator as unknown as (options: {
      locale: string;
      messages: unknown;
      namespace?: string;
    }) => unknown;

    const catalogues = new Map<Locale, MessageTree>();
    const traducteurs = new Map<string, unknown>();

    return (locale: Locale, namespace?: string) => {
      const cle = `${locale}:${namespace ?? ''}`;
      const connu = traducteurs.get(cle);

      if (connu !== undefined) {
        return connu;
      }

      let messages = catalogues.get(locale);

      if (messages === undefined) {
        messages = loadMessages(locale);
        catalogues.set(locale, messages);
      }

      const fait = creer(
        namespace === undefined ? { locale, messages } : { locale, messages, namespace },
      );

      traducteurs.set(cle, fait);

      return fait;
    };
  })();

  return formateur;
}

/**
 * D'où une doublure lit la langue du rendu.
 *
 * Lue à **chaque appel** et non capturée : c'est ce qui permet à la même
 * doublure de servir une langue figée — `() => 'en'` — et une langue mobile,
 * dont `fixerLangue()` change la valeur entre deux `render()`.
 */
export type LireLangue = () => Locale;

/**
 * La doublure de `next-intl` — les **crochets** —, à rendre depuis la fabrique
 * de `vi.mock`.
 *
 * Le reste du module est celui de la bibliothèque : seuls `useLocale` et
 * `useTranslations` dépendent du contexte de la requête, que jsdom n'a pas.
 */
export async function doublureCrochets(
  lireLangue: LireLangue,
): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const traduire = await traducteur();

  return {
    ...actual,
    useLocale: () => lireLangue(),
    useTranslations: (namespace?: string) => traduire(lireLangue(), namespace),
  };
}

/**
 * La doublure de `next-intl/server` — ce que lisent les Server Components
 * asynchrones et les actions serveur.
 *
 * Rien n'est repris du module réel : sous jsdom, `next-intl/server` résout vers
 * la variante client de la bibliothèque, qui lève *« `getTranslations` is not
 * supported in Client Components »* faute de requête pour porter la langue.
 */
export async function doublureServeur(
  lireLangue: LireLangue,
): Promise<Record<string, unknown>> {
  const traduire = await traducteur();

  return {
    getLocale: () => Promise.resolve(lireLangue()),
    /**
     * `getTranslations('ns')` et `getTranslations({ namespace })` — les deux
     * formes de la bibliothèque. La langue passée en option est ignorée : c'est
     * `lireLangue` qui fait foi, et elle doit rester la même que celle des
     * crochets.
     */
    getTranslations: (options?: string | { readonly namespace?: string }) =>
      Promise.resolve(
        traduire(lireLangue(), typeof options === 'string' ? options : options?.namespace),
      ),
  };
}
