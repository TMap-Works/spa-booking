import type AdminPlanningMessages from './en/admin-planning.json';

/**
 * Le namespace `admin-planning` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre le planning du back-office et tout ce qui s'ouvre depuis lui : la
 * grille, le tiroir de rendez-vous, le sélecteur de client, la confirmation de
 * report et le journal d'envois.
 *
 * Il est lu de deux façons, comme `appointment-status` : par
 * `useTranslations('admin-planning')` dans les composants, et par un **import
 * direct des deux fichiers JSON** dans `lib/admin/calendar-messages.ts`, que les
 * modules de calcul — sans React, donc sans crochet — appellent. Les deux
 * lectures visent les mêmes fichiers : il n'y a qu'une écriture de ce
 * vocabulaire.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-planning': typeof AdminPlanningMessages;
    }
  }
}

export {};
