import type AdminDashboardMessages from './en/admin-dashboard.json';

/**
 * Le namespace `admin-dashboard` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre le tableau de bord du back-office (#1104) : la salutation, les
 * quatre indicateurs du jour, les prochains rendez-vous, l'activité de la
 * semaine et les raccourcis. Il est lu par `useTranslations('admin-dashboard')`
 * et `getTranslations('admin-dashboard')` — jamais par import direct : cet écran
 * n'a aucune fonction de calcul hors de React.
 *
 * Le type se lit sur le catalogue **anglais**, la langue par défaut du système :
 * c'est la seule dont l'existence soit garantie.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-dashboard': typeof AdminDashboardMessages;
    }
  }
}

export {};
