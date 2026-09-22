import type AdminSettingsMessages from './en/admin-settings.json';

/** Le namespace `admin-settings` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-settings': typeof AdminSettingsMessages;
    }
  }
}

export {};
