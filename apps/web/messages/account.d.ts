import type AccountMessages from './en/account.json';

/** Le namespace `account` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      account: typeof AccountMessages;
    }
  }
}

export {};
