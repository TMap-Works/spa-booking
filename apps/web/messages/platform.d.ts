import type PlatformMessages from './en/platform.json';

/**
 * Le namespace `platform` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre la console de l'éditeur (`app/plateforme/`, ADR 0012) : sa coquille,
 * sa connexion à deux facteurs, son tableau de bord, la liste et la fiche des
 * salons, le formulaire d'ouverture et l'export CSV.
 *
 * Il est lu de deux façons, comme `admin-planning` : par
 * `useTranslations('platform')` et `getTranslations('platform')` dans les écrans,
 * et par un **import direct des deux fichiers JSON** dans
 * `lib/platform-console.ts`, dont les fonctions sont pures — appelées depuis un
 * Server Component, un Client Component, une route d'export et des tests sans
 * DOM, où aucun crochet n'est disponible. Les deux lectures visent les mêmes
 * fichiers : il n'y a qu'une écriture de ce vocabulaire.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      platform: typeof PlatformMessages;
    }
  }
}

export {};
