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
 * D'où cette doublure, écrite **une fois** : deux suites la partagent, là où deux
 * copies du même `vi.mock` se seraient mises à diverger — et l'une aurait alors
 * mesuré autre chose que l'autre.
 *
 * ## L'emploi
 *
 * ```ts
 * vi.mock('next-intl', () => nextIntlMobile());
 *
 * it('…', () => {
 *   fixerLangue('en');
 *   render(<Badge … />);
 * });
 * afterEach(() => fixerLangue('fr'));
 * ```
 *
 * Le `vi.mock` est hissé au sommet du module, mais sa fabrique n'est évaluée qu'au
 * premier import de `next-intl` : la langue posée par un test est donc bien celle
 * que le rendu lit.
 */

/** La langue du rendu, partagée par la doublure et par la suite qui la pilote. */
let langue: Locale = 'fr';

/** Pose la langue des rendus suivants. À remettre à `fr` en `afterEach`. */
export function fixerLangue(prochaine: Locale): void {
  langue = prochaine;
}

/**
 * La doublure de `next-intl`, à rendre depuis la fabrique de `vi.mock`.
 *
 * Elle reprend celle de l'amorce — le **vrai** formateur ICU de la bibliothèque
 * (`createTranslator`) sur les **vrais** catalogues du dépôt —, au détail près
 * qu'elle lit sa langue dans `langue` et mémoïse par langue **et** par namespace.
 * Sans ce cache, `createTranslator` serait rappelé à chaque rendu de chaque
 * composant, et la suite mesurerait le coût de la doublure.
 */
export async function nextIntlMobile(): Promise<Record<string, unknown>> {
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

  return {
    ...actual,
    useLocale: () => langue,
    useTranslations: (namespace?: string) => {
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
    },
  };
}
