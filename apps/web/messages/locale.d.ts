import type LocaleMessages from './en/locale.json';

/** Le namespace `locale` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      locale: typeof LocaleMessages;
    }
  }
}

export {};
