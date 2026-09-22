import type SignupMessages from './en/signup.json';

/**
 * Le namespace `signup` du catalogue — l'inscription d'un salon en libre-service
 * (#1105, ADR 0016). Voir `i18n/catalog.d.ts`.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      signup: typeof SignupMessages;
    }
  }
}

export {};
