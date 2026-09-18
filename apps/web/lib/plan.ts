import { SUBSCRIPTION_PLAN } from '@spa/shared';

import { formatMoneyCompact } from './format';

/**
 * Le prix de l'offre unique, tel qu'il s'écrit partout — « 29 € » (ADR 0016).
 *
 * Écrit une fois depuis `SUBSCRIPTION_PLAN` : l'accueil, l'inscription et
 * l'écran d'abonnement ne peuvent pas annoncer trois prix différents.
 */
export const PLAN_PRICE_LABEL = formatMoneyCompact({
  amountMinor: SUBSCRIPTION_PLAN.amountMinor,
  currency: SUBSCRIPTION_PLAN.currency,
});

/** « 14 jours gratuits, puis 29 € par mois » — la promesse en une ligne. */
export const PLAN_PROMISE = `${String(SUBSCRIPTION_PLAN.trialDays)} jours gratuits, puis ${PLAN_PRICE_LABEL} par mois`;
