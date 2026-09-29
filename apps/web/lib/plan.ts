import { SUBSCRIPTION_PLAN_PRICE, type Money } from '@spa/shared';

import { formatMoneyCompact, type DisplayLocale } from './format';

/**
 * Le prix de l'offre unique, tel qu'il s'écrit partout — ADR 0016.
 *
 * ## Un montant, pas une phrase
 *
 * Ce module portait jusqu'à #1105 deux **constantes de module** : `« 29 € »` et
 * `« 14 jours gratuits, puis 29 € par mois »`. Toutes deux étaient évaluées à
 * l'importation, donc hors de toute requête : elles ne pouvaient pas connaître
 * la langue de la visiteuse, et annonçaient « 29 € » à qui lit « €29 ». La
 * seconde était en outre une phrase française construite en dur, qu'aucun
 * catalogue ne pouvait traduire.
 *
 * Il ne reste donc ici que le **montant** — un entier dans la plus petite unité
 * de la devise, accompagné de son code devise (`CLAUDE.md`, « Argent ») — et sa
 * mise en forme. La **phrase** qui l'entoure vit dans les catalogues, sous la
 * clé `plan.promise` du namespace de chaque écran, avec le prix en paramètre.
 */

/**
 * L'offre, sous la forme que `lib/format.ts` attend — entier + code devise.
 *
 * Le montant **du contrat**, repris tel quel et non recomposé de ses deux champs
 * (#1330) : `SUBSCRIPTION_PLAN_PRICE` est déjà un `Money`, dont la devise est une
 * donnée et non le littéral `'EUR'` que `SUBSCRIPTION_PLAN` fige. La différence
 * n'est pas de style — elle interdit à cet écran de se spécialiser sur l'euro, et
 * fait suivre l'affichage le jour où le PO tranche la devise d'un salon US/CA.
 * Voir `packages/shared/src/schemas/billing.ts` sur ce qui reste à trancher.
 */
export const PLAN_MONEY: Money = SUBSCRIPTION_PLAN_PRICE;

/**
 * « 29 € », « €29 », « $29 » — le prix mensuel dans la langue et la région
 * d'affichage, **libellé dans la devise que porte le montant**.
 *
 * Une fonction et non une constante : c'est ce qui permet à l'accueil, à
 * l'inscription et à l'écran d'abonnement d'annoncer le **même** prix sans
 * pouvoir en annoncer trois écritures différentes.
 *
 * Aucun symbole n'est écrit ici, ni dans les catalogues : `formatMoneyCompact`
 * lit la devise du montant et les décimales qu'ICU lui associe. C'est ce qui fait
 * qu'un changement de devise de l'offre ne demande de toucher aucun écran.
 */
export function planPriceLabel(display: DisplayLocale): string {
  return formatMoneyCompact(PLAN_MONEY, display);
}
