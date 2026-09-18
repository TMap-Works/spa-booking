/**
 * Abonnement du salon à la plateforme — ADR 0016.
 *
 * Ce n'est pas l'« abonnement » que le CDC §1.4 range hors périmètre : celui-là
 * est la formule qu'un salon vendrait à **ses** clientes. Celui-ci est ce que le
 * salon paie à l'éditeur pour utiliser le produit.
 *
 * Une seule offre : un prix mensuel, un essai gratuit, la carte enregistrée dès
 * l'inscription par Stripe Checkout — aucune donnée de carte ne traverse notre
 * code (SAQ A, payments-stripe §1).
 */

import { z } from 'zod';

import { utcInstantSchema } from '../common/time';

/**
 * L'offre unique. Le montant est en **plus petite unité** de la devise
 * (centimes), jamais un flottant — CLAUDE.md, « Argent ».
 */
export const SUBSCRIPTION_PLAN = Object.freeze({
  name: 'Spa & Salon Booking',
  amountMinor: 2900,
  currency: 'EUR',
  interval: 'month',
  trialDays: 14,
} as const);

/**
 * Où en est la facturation d'un salon.
 *
 * - `managed` : ouvert par la console de l'éditeur (ou antérieur à l'ADR 0016),
 *   hors facturation — il reste ouvert.
 * - `pending` : inscrit, mais le paiement de l'essai n'a pas abouti.
 * - `trialing`, `active` : essai en cours, abonnement payé.
 * - `past_due` : un prélèvement a échoué, Stripe retente — le salon reste
 *   ouvert pendant ces relances.
 * - `canceled` : résilié ou impayé définitif — le salon est fermé.
 */
export const TENANT_BILLING_STATUSES = [
  'managed',
  'pending',
  'trialing',
  'active',
  'past_due',
  'canceled',
] as const;

export const tenantBillingStatusSchema = z.enum(TENANT_BILLING_STATUSES);

export type TenantBillingStatus = z.infer<typeof tenantBillingStatusSchema>;

/** Les statuts qui laissent le salon ouvert — réservation et back-office. */
const OPEN_STATUSES: ReadonlySet<TenantBillingStatus> = new Set([
  'managed',
  'trialing',
  'active',
  'past_due',
]);

export function isBillingOpen(status: TenantBillingStatus): boolean {
  return OPEN_STATUSES.has(status);
}

/** L'état de facturation tel que le back-office l'affiche. */
export const tenantBillingSchema = z.object({
  status: tenantBillingStatusSchema,
  /** Fin de l'essai gratuit, en UTC — `null` hors essai. */
  trialEndsAt: utcInstantSchema.nullable(),
  /** Prochaine échéance de l'abonnement, en UTC. */
  currentPeriodEndsAt: utcInstantSchema.nullable(),
  /** `true` si le salon a un compte de facturation : le portail peut s'ouvrir. */
  hasBillingAccount: z.boolean(),
});

export type TenantBilling = z.infer<typeof tenantBillingSchema>;

/** Une redirection vers une page hébergée par Stripe — Checkout ou portail. */
export const billingRedirectSchema = z.object({
  url: z.string().url(),
});

export type BillingRedirect = z.infer<typeof billingRedirectSchema>;
