import type UiMessages from './en/ui.json';

/** Le namespace `ui` du catalogue — voir `i18n/catalog.d.ts`. */
declare global {
  namespace SpaMessages {
    interface Catalog {
      ui: typeof UiMessages;
    }
  }
}

export {};
