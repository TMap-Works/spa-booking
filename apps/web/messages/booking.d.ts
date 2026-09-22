import type BookingMessages from './en/booking.json';

/**
 * Le namespace `booking` du catalogue — voir `i18n/catalog.d.ts`.
 *
 * Il couvre tout le parcours public de réservation (#846) : l'accueil de la
 * plateforme, la vitrine d'un salon, le tunnel de la prestation à la
 * confirmation, et la politique de données. Un seul namespace pour ces quatre
 * écrans plutôt qu'un par écran : c'est un parcours continu, dont les libellés
 * se répondent d'un écran à l'autre — « Prendre rendez-vous » est le bouton de
 * la vitrine *et* l'intitulé du tunnel —, et les scinder aurait multiplié les
 * doublons sans rien isoler.
 *
 * Comme les autres, il lit son catalogue **anglais** : `en` est la langue par
 * défaut du système (#844), donc la seule dont l'existence est garantie. La
 * parité avec le français est un fait de contenu, que
 * `tests/unit/messages-parity.test.ts` éprouve.
 */
declare global {
  namespace SpaMessages {
    interface Catalog {
      booking: typeof BookingMessages;
    }
  }
}

export {};
