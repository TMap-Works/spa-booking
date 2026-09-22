import type AdminAuthMessages from './en/admin-auth.json';

/** Le namespace `admin-auth` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-auth': typeof AdminAuthMessages;
    }
  }
}

export {};
