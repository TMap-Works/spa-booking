import type PublicExitsMessages from './en/public-exits.json';

/**
 * Le namespace `public-exits` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Comme `appointment-status`, il est lu de deux façons : par
 * `useTranslations('public-exits')` dans le composant `PublicExits`, et par un
 * **import direct des deux fichiers JSON** dans `components/salon/public-exits.tsx`,
 * dont `publicExitLabels(locale)` est une fonction pure — appelée depuis des
 * Server Components asynchrones (`app/page.tsx`, les écrans de connexion et
 * d'invitation du back-office), où aucun crochet n'est appelable, et depuis les
 * Client Components du parcours public qui veulent ces libellés comme données.
 * `app/salon-doors.ts` ne la lit plus depuis #1233 (#1277).
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'public-exits': typeof PublicExitsMessages;
    }
  }
}

export {};
