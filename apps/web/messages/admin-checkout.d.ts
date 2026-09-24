import type AdminCheckoutMessages from './en/admin-checkout.json';

/**
 * Le namespace `admin-checkout` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre l'encaissement au comptoir (#850) : la journée de caisse et sa
 * liste, le récapitulatif du rendez-vous, le choix du moyen de paiement, le
 * règlement mixte et sa monnaie rendue, le geste du TPE, les refus que l'API
 * rend, et le ticket remis à la cliente.
 *
 * Il est lu de deux façons, comme `admin-planning` : par
 * `useTranslations('admin-checkout')` dans les composants, et par un **import
 * direct des deux fichiers JSON** dans `lib/admin/checkout-summary.ts`, dont les
 * fonctions pures — appelées depuis un Server Component, depuis un Client
 * Component et depuis des tests sans DOM — n'ont aucun crochet à leur
 * disposition. Les deux lectures visent les mêmes fichiers : il n'y a qu'une
 * écriture de ce vocabulaire.
 *
 * Ce qu'il ne porte pas, depuis #835 : les messages d'un prestataire de
 * paiement. Il n'y en a plus au comptoir — la carte passe par le TPE autonome
 * de la banque du salon, et ce que le terminal affiche n'appartient ni à ce
 * catalogue ni à cette application (ADR 0015). Ce qu'il porte à la place est le
 * vocabulaire du geste : le montant à saisir sur le terminal, le numéro du
 * ticket qu'il imprime, et les deux issues que le caissier déclare.
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
