import type CopilotMessages from './en/copilot.json';

/**
 * Le namespace `copilot` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Les libellés du chat (ADR 0018, P1-06) : en-tête, saisie, accueil et
 * suggestions d'ouverture. Les clés de `suggestions` sont celles que calcule
 * le serveur (`lib/copilot/suggestions.ts`) : une suggestion sans libellé ici
 * ne s'afficherait pas.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      copilot: typeof CopilotMessages;
    }
  }
}

export {};
