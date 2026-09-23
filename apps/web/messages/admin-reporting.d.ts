import type AdminReportingMessages from './en/admin-reporting.json';

/**
 * Le namespace `admin-reporting` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre l'écran des indicateurs d'activité (#851) : les trois tuiles de
 * tête, les deux graphiques, les deux tableaux, la barre de filtres et le bouton
 * d'export. Il est lu par `useTranslations('admin-reporting')` et
 * `getTranslations('admin-reporting')` dans les composants — et par **import
 * direct des deux JSON** dans `lib/admin/reporting-window.ts`,
 * `reporting-view.ts` et `reporting-csv.ts`, qui sont des modules de calcul
 * appelés hors de React, comme `lib/format.ts` et `lib/appointment-status.ts` le
 * font déjà.
 *
 * Le type se lit sur le catalogue **anglais**, la langue par défaut du système :
 * c'est la seule dont l'existence soit garantie.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-reporting': typeof AdminReportingMessages;
    }
  }
}

export {};
