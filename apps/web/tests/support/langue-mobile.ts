import type { Locale } from '@spa/shared';
import { vi } from 'vitest';

/**
 * Une langue **mobile** pour les suites qui rendent la même brique dans les deux
 * langues — #1192.
 *
 * ## Pourquoi ce fichier existe
 *
 * L'amorce des suites fixe la langue à `fr` pour toutes
 * (`tests/support/next-intl.ts`), et `admin-catalog-i18n.test.tsx` la fixe à `en`
 * pour la sienne. Une suite qui veut comparer le **même** composant dans les deux
 * langues ne peut faire ni l'un ni l'autre : il lui faut une langue qui bouge entre
 * deux `render()`. Poser un `NextIntlClientProvider` autour du rendu n'y suffirait
 * pas — l'amorce remplace `useTranslations` lui-même, contexte compris.
 *
 * D'où cette doublure, écrite **une fois** : plusieurs suites la partagent, là où
 * deux copies du même `vi.mock` se seraient mises à diverger — et l'une aurait
 * alors mesuré autre chose que l'autre.
 *
 * ## Deux points d'entrée, une seule langue (#1277)
 *
 * `next-intl` sert les **crochets** — `useTranslations`, `useLocale` —, que seul
 * un Client Component peut appeler. Un Server Component asynchrone ou une action
 * serveur lit ses messages par `getTranslations` de `next-intl/server`, que
 * l'amorce fige elle aussi à `fr`. Les deux doublures mobiles sont donc ici,
 * `nextIntlMobile()` et `nextIntlServerMobile()`, sur la **même** variable
 * `langue` et le **même** formateur ICU mémoïsé.
 *
 * C'est ce que deux suites de #1233 s'écrivaient chacune à l'identique
 * (`home-open-salon-action`, `home-photos-i18n`) — la seconde devant en outre
 * tenir deux variables de langue en phase à la main, faute de quoi les crochets
 * seraient passés en anglais pendant que le Server Component serait resté en
 * français. Un seul `fixerLangue()` déplace désormais les deux.
 *
 * ## L'emploi
 *
 * ```ts
 * vi.mock('next-intl', () => nextIntlMobile());
 * vi.mock('next-intl/server', () => nextIntlServerMobile());
 *
 * it('…', () => {
 *   fixerLangue('en');
 *   render(<Badge … />);
 * });
 * afterEach(() => fixerLangue('fr'));
 * ```
 *
 * Une suite ne pose que la doublure dont elle a besoin : celle des crochets pour
 * un composant client, celle du serveur pour une action, les deux pour un Server
 * Component qui monte un Client Component.
 *
 * Le `vi.mock` est hissé au sommet du module, mais sa fabrique n'est évaluée qu'au
 * premier import du module doublé : la langue posée par un test est donc bien
 * celle que le rendu lit.
 */

/** La langue du rendu, partagée par les deux doublures et par la suite qui les pilote. */
let langue: Locale = 'fr';

/** Pose la langue des rendus suivants. À remettre à `fr` en `afterEach`. */
export function fixerLangue(prochaine: Locale): void {
  langue = prochaine;
}

/** Le traducteur d'un namespace, dans la langue posée à l'appel. */
type Traduire = (namespace?: string) => unknown;

/**
 * Le formateur, monté **une seule fois** et partagé par les deux doublures.
 *
 * Il reprend celui de l'amorce — le **vrai** formateur ICU de la bibliothèque
 * (`createTranslator`) sur les **vrais** catalogues du dépôt —, au détail près
 * qu'il lit sa langue dans `langue` et mémoïse par langue **et** par namespace.
 * Sans ce cache, `createTranslator` serait rappelé à chaque rendu de chaque
 * composant, et la suite mesurerait le coût de la doublure.
 *
 * Partagé et non dupliqué par point d'entrée : une suite qui monte un Server
 * Component rendant des Client Components lit le même namespace des deux côtés,
 * et rien ne justifierait de le formater deux fois.
 */
let formateur: Promise<Traduire> | undefined;

function traducteur(): Promise<Traduire> {
  formateur ??= (async (): Promise<Traduire> => {
    const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
    const { loadMessages } = await import('../../i18n/messages');
    /**
     * `createTranslator` est typé sur le catalogue complet ; l'appeler avec un
     * namespace dont le nom n'est connu qu'à l'exécution demande de relâcher la
     * contrainte, une fois, ici — comme dans l'amorce.
     */
    const translator = actual.createTranslator as unknown as (options: {
      locale: string;
      messages: unknown;
      namespace?: string;
    }) => unknown;
    const cache = new Map<string, unknown>();

    return (namespace?: string) => {
      const key = `${langue}:${namespace ?? ''}`;
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const messages = loadMessages(langue);
      const made = translator(
        namespace === undefined
          ? { locale: langue, messages }
          : { locale: langue, messages, namespace },
      );

      cache.set(key, made);

      return made;
    };
  })();

  return formateur;
}

/**
 * La doublure de `next-intl` — les **crochets** —, à rendre depuis la fabrique
 * de `vi.mock`.
 *
 * Le reste du module est celui de la bibliothèque : seuls `useLocale` et
 * `useTranslations` dépendent du contexte de la requête, que jsdom n'a pas.
 */
export async function nextIntlMobile(): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const traduire = await traducteur();

  return {
    ...actual,
    useLocale: () => langue,
    useTranslations: (namespace?: string) => traduire(namespace),
  };
}

/**
 * La doublure de `next-intl/server` — ce que lisent les Server Components
 * asynchrones et les actions serveur (#1277).
 *
 * Rien n'est repris du module réel : sous jsdom, `next-intl/server` résout vers
 * la variante client de la bibliothèque, qui lève *« `getTranslations` is not
 * supported in Client Components »* faute de requête pour porter la langue —
 * même raison que dans l'amorce (`tests/support/next-intl.ts`).
 */
export async function nextIntlServerMobile(): Promise<Record<string, unknown>> {
  const traduire = await traducteur();

  return {
    getLocale: () => Promise.resolve(langue),
    /**
     * `getTranslations('ns')` et `getTranslations({ namespace })` — les deux
     * formes de la bibliothèque. La langue passée en option est ignorée : c'est
     * `fixerLangue()` qui la pose, et elle doit rester la même que celle des
     * crochets.
     */
    getTranslations: (options?: string | { readonly namespace?: string }) =>
      Promise.resolve(traduire(typeof options === 'string' ? options : options?.namespace)),
  };
}
