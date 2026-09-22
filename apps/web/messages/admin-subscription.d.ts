import type AdminSubscriptionMessages from './en/admin-subscription.json';

/**
 * Le namespace `admin-subscription` du catalogue — l'abonnement du salon à la
 * plateforme (#1105, ADR 0016). Voir `i18n/catalog.d.ts`.
 *
 * Le nom porte un trait d'union parce que le nom du fichier **est** le
 * namespace (`i18n/messages.ts`) : la clé est donc citée entre guillemets ici,
 * et lue `useTranslations('admin-subscription')` dans les écrans.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-subscription': typeof AdminSubscriptionMessages;
    }
  }
}

export {};
