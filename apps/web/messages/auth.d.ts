import type AuthMessages from './en/auth.json';

/** Le namespace `auth` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      auth: typeof AuthMessages;
    }
  }
}

export {};
