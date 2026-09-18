import type { TenantBillingStatus } from '@spa/shared';

/**
 * Le statut Stripe d'un abonnement, traduit dans celui du salon — ADR 0016.
 *
 * | Stripe | Salon | Pourquoi |
 * |---|---|---|
 * | `trialing` | `trialing` | l'essai court, la carte est enregistrée |
 * | `active` | `active` | payé |
 * | `past_due` | `past_due` | un prélèvement a échoué, Stripe relance — ouvert |
 * | `incomplete` | `pending` | le premier paiement attend une action |
 * | `incomplete_expired`, `canceled`, `unpaid`, `paused` | `canceled` | fermé |
 *
 * `null` pour un statut que Stripe ajouterait demain : l'état en base n'est
 * alors pas touché, plutôt que d'ouvrir ou de fermer un salon sur une valeur
 * qu'on ne comprend pas.
 */
export function billingStatusFromStripe(status: string): TenantBillingStatus | null {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'incomplete':
      return 'pending';
    case 'incomplete_expired':
    case 'canceled':
    case 'unpaid':
    case 'paused':
      return 'canceled';
    default:
      return null;
  }
}
