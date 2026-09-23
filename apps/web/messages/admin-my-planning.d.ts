import type AdminMyPlanningMessages from './en/admin-my-planning.json';

/**
 * Le namespace `admin-my-planning` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre « Mon planning », l'emploi du temps du praticien connecté (#1104) :
 * les trois vues, les en-têtes de période, la journée de travail, le détail d'un
 * rendez-vous et les gestes que le praticien y pose.
 *
 * Il est lu de deux façons, comme `admin-planning` : par
 * `useTranslations('admin-my-planning')` dans les composants, et par un **import
 * direct des deux fichiers JSON** dans `lib/admin/my-planning.ts`, dont les
 * fonctions pures — appelées depuis un Server Component, depuis un Client
 * Component et depuis des tests sans DOM — n'ont aucun crochet à leur
 * disposition. Les deux lectures visent les mêmes fichiers : il n'y a qu'une
 * écriture de ce vocabulaire.
 *
 * Le type se lit sur le catalogue **anglais**, la langue par défaut du système.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-my-planning': typeof AdminMyPlanningMessages;
    }
  }
}

export {};
