import type FormatMessages from './en/format.json';

/**
 * Le namespace `format` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Les quelques mots que `Intl` ne sait pas dire : la mention d'un fuseau et les
 * unités d'une durée. Comme `appointment-status`, il est lu par import direct
 * des deux fichiers JSON depuis `lib/format.ts`, qui est un module de fonctions
 * pures.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      format: typeof FormatMessages;
    }
  }
}

export {};
