import type PublicExitsMessages from './en/public-exits.json';

/**
 * Le namespace `public-exits` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Comme `appointment-status`, il est lu de deux façons : par
 * `useTranslations('public-exits')` dans le composant `PublicExits`, et par un
 * **import direct des deux fichiers JSON** dans `components/salon/public-exits.tsx`,
 * dont `publicExitLabels(locale)` est une fonction pure — appelée depuis des
 * modules sans React (`app/salon-doors.ts`), donc sans crochet possible.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'public-exits': typeof PublicExitsMessages;
    }
  }
}

export {};
