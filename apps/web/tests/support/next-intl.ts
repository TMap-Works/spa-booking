import type { Locale } from '@spa/shared';
import { vi } from 'vitest';

/**
 * La langue des suites unitaires — #845, avant-dernier critère d'acceptation :
 * *« les tests existants qui vérifient des libellés français continuent de
 * passer, en fixant explicitement la langue `fr` »*.
 *
 * ## Pourquoi un fichier d'amorce, et non une réécriture des suites
 *
 * Cinquante-huit suites appellent `render()` de `@testing-library/react` sans
 * fournisseur. Depuis que les briques partagées lisent leurs libellés dans le
 * catalogue, chacune se heurterait à *« Failed to call useTranslations because
 * the context from NextIntlClientProvider was not found »* — sept cent
 * trente-trois échecs pour une traduction qui n'a rien cassé. Les réécrire une
 * à une aurait touché cinquante-huit fichiers hors du périmètre du ticket, et
 * mis en conflit de fusion les onze tickets d'écrans qui y reviendront.
 *
 * L'amorce pose donc la langue **une fois**, pour toutes les suites : `fr`,
 * c'est-à-dire exactement ce que ces tests vérifiaient avant. Les tickets
 * d'écrans ajoutent ensuite la variante `en` de leurs propres tests, en rendant
 * explicitement sous `NextIntlClientProvider` — le vrai, que cette amorce
 * laisse intact.
 *
 * ## Ce que l'amorce remplace, et ce qu'elle garde
 *
 * Quatre points d'entrée — `useTranslations` et `useLocale` de `next-intl`,
 * `getTranslations` et `getLocale` de `next-intl/server` — dont la seule
 * dépendance est le contexte de la requête. Le **formatage** reste celui de la
 * bibliothèque : `createTranslator` est le formateur ICU de `next-intl`, appelé
 * sur les catalogues du dépôt. Un test qui vérifie « Bienvenue chez Maison
 * Lotus » éprouve donc le vrai message et la vraie substitution de paramètres,
 * pas une table de doublure qui pourrait en diverger.
 *
 * Les catalogues sont lus par `loadMessages`, comme le serveur les lit : une clé
 * manquante dans `messages/fr/` échoue ici comme elle échouerait en production.
 *
 * ## Pourquoi `next-intl/server` aussi
 *
 * Les trois coquilles ont des layouts **asynchrones** — `generateMetadata` et le
 * layout de l'espace client —, et un composant asynchrone ne peut pas appeler un
 * crochet : il lit ses messages par `getTranslations`. Sous jsdom, l'export
 * `next-intl/server` résout vers la variante client de la bibliothèque, qui lève
 * *« `getTranslations` is not supported in Client Components »* — non parce que
 * le code est fautif, mais parce qu'aucune requête n'existe pour porter la
 * langue. L'amorce la fournit, comme elle la fournit aux crochets.
 */

/** La langue des suites — celle dans laquelle elles ont été écrites. */
export const TEST_LOCALE: Locale = 'fr';

/**
 * Le traducteur de la langue des suites, pour un namespace donné.
 *
 * Fabriqué à la demande plutôt qu'une fois pour toutes : `vi.mock` est hissé, et
 * les catalogues ne doivent être lus qu'au premier appel — c'est-à-dire quand la
 * fabrique du module est évaluée, pas quand ce fichier est chargé.
 *
 * À la demande, mais **une seule fois par namespace** : sans ce cache, chaque
 * appel à `getTranslations` relisait les sept catalogues sur le disque et
 * remontait un formateur ICU, pour un résultat identique.
 */
const SERVER_TRANSLATORS = new Map<string, unknown>();

async function frenchTranslator(namespace?: string): Promise<unknown> {
  const key = namespace ?? '';
  const cached = SERVER_TRANSLATORS.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');

  /**
   * `createTranslator` est typé sur le catalogue complet ; l'appeler avec un
   * namespace dont le nom n'est connu qu'à l'exécution demande de relâcher la
   * contrainte, une fois, ici. Le comportement, lui, est celui de la
   * bibliothèque.
   */
  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;
  const messages = loadMessages(TEST_LOCALE);

  const made = translator(
    namespace === undefined
      ? { locale: TEST_LOCALE, messages }
      : { locale: TEST_LOCALE, messages, namespace },
  );

  SERVER_TRANSLATORS.set(key, made);

  return made;
}

vi.mock('next-intl', async () => {
  const actual = await vi.importActual<typeof import('next-intl')>('next-intl');
  const { loadMessages } = await import('../../i18n/messages');

  const messages = loadMessages(TEST_LOCALE);

  const translator = actual.createTranslator as unknown as (options: {
    locale: string;
    messages: unknown;
    namespace?: string;
  }) => unknown;

  /**
   * Un traducteur par namespace, fabriqué une fois.
   *
   * Sans ce cache, `createTranslator` — qui monte un formateur ICU — serait
   * rappelé à **chaque rendu de chaque composant** : `Button` lit
   * `ui.button` sur tous ses rendus, et un écran qui en affiche trente en
   * paie trente par passe de rendu. Le vrai `useTranslations` ne fait rien de
   * tel : il mémoïse sur le contexte de la requête. La doublure doit donc
   * mémoïser aussi, sans quoi elle mesure le coût de la doublure et non celui
   * du composant — et fait déborder le délai de 5 s des suites les plus
   * lourdes (tunnel de réservation, sélecteur de pays).
   *
   * La clé `''` est celle du traducteur sans namespace : `undefined` ne se
   * distingue pas d'une absence dans une `Map`.
   */
  const cache = new Map<string, unknown>();

  return {
    ...actual,
    useLocale: () => TEST_LOCALE,
    useTranslations: (namespace?: string) => {
      const key = namespace ?? '';
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const made = translator(
        namespace === undefined
          ? { locale: TEST_LOCALE, messages }
          : { locale: TEST_LOCALE, messages, namespace },
      );

      cache.set(key, made);

      return made;
    },
  };
});

vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve(TEST_LOCALE),
  /**
   * `getTranslations('ns')` et `getTranslations({ namespace })` — les deux
   * formes de la bibliothèque. La langue passée, elle, est ignorée : les suites
   * n'ont qu'une langue, et c'est tout l'objet de cette amorce.
   */
  getTranslations: (options?: string | { readonly namespace?: string }) =>
    frenchTranslator(typeof options === 'string' ? options : options?.namespace),
}));
