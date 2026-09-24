import type AdminClientsMessages from './en/admin-clients.json';

/**
 * Le namespace `admin-clients` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre le fichier client du back-office : la recherche, la liste et sa
 * pagination, la fiche ouverte — coordonnées, langue préférée, compteurs, avis
 * de délivrabilité, historique de visites — ainsi que les trois briques que cet
 * écran rend depuis son propre répertoire : `client-search-form`,
 * `client-contact-form` et `client-note-form`.
 *
 * Il est lu par `useTranslations('admin-clients')` dans les composants et par
 * `getTranslations('admin-clients')` dans la page asynchrone. `client-view.ts`,
 * le module de calcul de l'écran, ne le lit pas : il rend des **clés** que la
 * page résout, pour rester une suite de fonctions pures testables sans DOM —
 * même partage que `emptyCatalogDescriptionKey` du catalogue (#849).
 *
 * Les dates, les heures et les montants n'y sont pas : ils viennent de
 * `lib/format.ts`, qui porte ses propres mots dans `messages/<langue>/format.json`.
 * Les libellés de statut de rendez-vous non plus : ils viennent de
 * `lib/appointment-status.ts` et du namespace `appointment-status`, parce que
 * six surfaces les écrivent et qu'une seule table les tient (#917).
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-clients': typeof AdminClientsMessages;
    }
  }
}

export {};
