import type ShellMessages from './en/shell.json';

/**
 * Le namespace `shell` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Quatre lignes déposées à côté des deux fichiers JSON : c'est tout ce qu'un
 * namespace demande, et cela ne touche aucun fichier central.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      shell: typeof ShellMessages;
    }
  }
}

export {};
