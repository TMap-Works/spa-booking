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
import { submittedLocaleSchema } from '../locale/index';

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

/**
 * Ce que l'écran d'abonnement demande en ouvrant une page hébergée par Stripe —
 * la page de paiement ou le portail de gestion (#1261).
 *
 * ## Un corps qui ne porte qu'une langue, et pourquoi il en porte une
 *
 * `locale` est la langue **de la session en cours de lecture** : celle que le
 * sélecteur du back-office affiche à l'instant du clic. Sans elle, la langue des
 * pages Stripe se déduisait du seul `users.locale` (#1231), si bien qu'un gérant
 * dont le compte est en français et qui basculait l'interface en anglais partait
 * sur une page de paiement française. Les signaux étaient inversés par rapport au
 * reste du produit, où le choix explicite gagne sur la préférence enregistrée
 * (`apps/web/i18n/resolve.ts`, #845) — et où l'export CSV du reporting avait déjà
 * tranché dans ce sens (#851).
 *
 * Elle est **facultative** : un appelant qui n'en envoie pas retrouve exactement
 * le comportement d'avant ce ticket — `users.locale`, puis
 * `tenants.default_locale`, puis `en`. C'est ce qui permet de livrer le contrat
 * sans casser l'appelant qui ne l'a pas encore adopté.
 *
 * `submittedLocaleSchema` et non `localeSchema` : la valeur vient d'un navigateur,
 * donc d'une saisie au sens large — `FR` et ` fr ` désignent la même langue, et
 * refuser sur la casse ferait échouer une ouverture de page de paiement pour une
 * raison qui n'en est pas une. Ce qui ne désigne **aucune** des deux langues du
 * contrat, en revanche, est refusé en 400 : une page de paiement s'ouvre dans une
 * langue connue ou ne s'ouvre pas, un repli silencieux masquerait l'appelant
 * fautif.
 *
 * ## Ce que ce corps ne porte pas, et ne portera pas
 *
 * **Rien qui touche une carte.** Ni numéro, ni CVC, ni date d'expiration, ni
 * jeton de moyen de paiement : les deux routes rendent une **adresse**, et la
 * carte se saisit sur la page hébergée par Stripe (payments-stripe §1, SAQ A). Le
 * `.strict()` n'est donc pas qu'une précaution d'isolation — il est aussi ce qui
 * refuse un champ de carte glissé dans ce corps par un appelant zélé.
 *
 * Ni `tenantId` : la portée vient du jeton, jamais du corps (tenant-isolation §2).
 */
export const billingRedirectRequestSchema = z
  .object({
    locale: submittedLocaleSchema.optional(),
  })
  .strict();

export type BillingRedirectRequest = z.infer<typeof billingRedirectRequestSchema>;

/** Une redirection vers une page hébergée par Stripe — Checkout ou portail. */
export const billingRedirectSchema = z.object({
  url: z.string().url(),
});

export type BillingRedirect = z.infer<typeof billingRedirectSchema>;
