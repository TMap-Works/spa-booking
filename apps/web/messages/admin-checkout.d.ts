import type AdminCheckoutMessages from './en/admin-checkout.json';

/**
 * Le namespace `admin-checkout` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre l'encaissement au comptoir (#850) : la journée de caisse et sa
 * liste, le récapitulatif du rendez-vous, le choix du moyen de paiement, les
 * refus que l'API rend, le formulaire de carte servi par Stripe, et le ticket
 * remis à la cliente.
 *
 * Il est lu de deux façons, comme `admin-planning` : par
 * `useTranslations('admin-checkout')` dans les composants, et par un **import
 * direct des deux fichiers JSON** dans `lib/admin/checkout-summary.ts`, dont les
 * fonctions pures — appelées depuis un Server Component, depuis un Client
 * Component et depuis des tests sans DOM — n'ont aucun crochet à leur
 * disposition. Les deux lectures visent les mêmes fichiers : il n'y a qu'une
 * écriture de ce vocabulaire.
 *
 * Ce qu'il ne porte pas : les messages de Stripe. « Carte refusée », « code de
 * sécurité invalide » et le reste viennent du prestataire, dans la langue que
 * `locale` lui passe (`lib/admin/payment-stripe.ts`) — les recopier ici les
 * ferait diverger de ce que la cliente voit dans l'iframe.
 *
 * Le type se lit sur le catalogue **anglais**, la langue par défaut du système.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      'admin-checkout': typeof AdminCheckoutMessages;
    }
  }
}

export {};
