import type AppointmentStatusMessages from './en/appointment-status.json';

/**
 * Le namespace `appointment-status` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il est lu de deux façons, et c'est le seul du ticket dans ce cas : par
 * `useTranslations('appointment-status')` dans les composants, et par un
 * **import direct des deux fichiers JSON** dans `lib/appointment-status.ts`, qui
 * est un module de fonctions pures — sans React, donc sans crochet. Les deux
 * lectures visent les mêmes fichiers : il n'y a qu'une écriture de ce
 * vocabulaire.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'appointment-status': typeof AppointmentStatusMessages;
    }
  }
}

export {};
