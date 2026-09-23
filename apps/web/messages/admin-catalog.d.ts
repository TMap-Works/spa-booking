import type AdminCatalogMessages from './en/admin-catalog.json';

/**
 * Le namespace `admin-catalog` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre le catalogue du back-office et tout ce qui s'ouvre depuis lui : la
 * liste des prestations, la création et la fiche d'une prestation, les
 * rubriques, l'aperçu de la vitrine, ainsi que les cinq briques que ces écrans
 * rendent — `service-form`, `service-staff-panel`, `category-manager`,
 * `catalog-status-badge` et `service-activation-button`.
 *
 * Il est lu par `useTranslations('admin-catalog')` dans les composants et par
 * `getTranslations('admin-catalog')` dans les pages asynchrones. Aucun module de
 * calcul ne le lit : à la différence d'`admin-planning`, le catalogue n'a pas de
 * logique hors React — la mise en forme des durées et des montants vit dans
 * `lib/format.ts`, qui porte ses propres mots dans `messages/<langue>/format.json`.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-catalog': typeof AdminCatalogMessages;
    }
  }
}

export {};
