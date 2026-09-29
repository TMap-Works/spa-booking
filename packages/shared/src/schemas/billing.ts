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

import { money, type Money } from '../common/money';
import { utcInstantSchema } from '../common/time';
import { submittedLocaleSchema } from '../locale/index';

/**
 * L'offre unique. Le montant est en **plus petite unité** de la devise
 * (centimes), jamais un flottant — CLAUDE.md, « Argent ».
 *
 * ## `currency` est la devise **facturée**, pas une devise d'affichage (#1308)
 *
 * `amountMinor` et `currency` sont les deux champs que
 * `payments/billing/billing.service.ts` passe à Stripe Checkout : c'est, au
 * centime près, ce dont la carte du salon est débitée chaque mois. Le PO a fixé
 * l'offre à **29 € par mois** (ADR 0016) ; en changer la devise ici ne changerait
 * pas un libellé, cela changerait la somme prélevée.
 *
 * C'est ce qui permet à l'accueil public de montrer **deux devises sur le même
 * écran** sans se contredire — l'écart relevé par #1308, et la raison qu'il
 * demandait d'écrire ici :
 *
 * - le **bloc tarifaire** (`apps/web/app/page.tsx`, section `#tarifs`) annonce
 *   *ce* prix : « 29 € » en français comme en anglais. Il est mis en forme selon
 *   la langue lue, mais pas converti — une facture ne change pas de montant
 *   selon la langue dans laquelle on la lit ;
 * - la **vignette du héros** (`apps/web/components/home/booking-preview.tsx`)
 *   annonce le prix d'une prestation d'illustration, que personne ne paie et qui
 *   n'est la contrepartie d'aucune facture. Sa devise peut donc suivre la langue
 *   lue — `$75.00` en anglais, `75,00 €` en français (#1300).
 *
 * Autrement dit : un seul de ces deux montants est un prix. Les deux autres
 * suites possibles qu'examinait #1308 demandent un arbitrage humain et ne sont
 * pas tranchées ici — convertir le tarif à un taux suppose une source de taux et
 * une règle de fraîcheur, que #1308 range hors périmètre MVP en l'état ; le
 * libeller *et* le facturer en dollars serait un changement de prix, donc une
 * décision du PO, pas une reprise d'affichage. Tant qu'aucune n'est tranchée, le
 * montant et la devise ci-dessous ne bougent pas.
 */
export const SUBSCRIPTION_PLAN = Object.freeze({
  name: 'Spa & Salon Booking',
  amountMinor: 2900,
  currency: 'EUR',
  interval: 'month',
  trialDays: 14,
} as const);

/**
 * Le prix de l'offre, **sous la forme d'un montant du contrat** — #1330.
 *
 * ## Ce que cette constante change, et ce qu'elle ne change pas
 *
 * Elle ne change **aucun montant** : c'est le même entier et la même devise que
 * `SUBSCRIPTION_PLAN` ci-dessus, et elle en dérive plutôt que de les recopier.
 * Ce qu'elle change est le **type** que voient les écrans : `Money`, dont la
 * `currency` est une chaîne, là où `SUBSCRIPTION_PLAN.currency` est le littéral
 * `'EUR'` que `as const` fige. Un affichage qui lit celle-ci ne peut donc plus se
 * spécialiser sur l'euro — ni au type, ni par un symbole écrit à la main : il met
 * en forme la devise **que la donnée porte**, quelle qu'elle soit.
 *
 * C'est tout l'objet du troisième critère de #1330, et c'en est aussi la limite.
 * La recette de traduction a relevé « 14 days free, then €29 a month » sur
 * l'inscription d'un salon américain, et deux lectures s'en suivent :
 *
 * - **un écran qui code l'euro en dur** est un défaut d'affichage, et il se corrige
 *   ici, par cette constante ;
 * - **facturer un salon de Chicago en euros** est une question de prix, donc une
 *   **décision commerciale du PO** — déjà signalée le 2026-09-19, toujours
 *   ouverte, et explicitement laissée ouverte par #1330 lui-même (« Le ticket se
 *   borne à afficher le prix dans la devise décidée »).
 *
 * Ce fichier ne la tranche donc pas, et n'établit **aucune correspondance
 * pays → devise** : il n'y a pas de table `US → USD` ici, parce qu'un tarif en
 * dollars n'est pas la traduction d'un tarif en euros mais un autre tarif. Le
 * comportement d'avant #1330 reste le défaut — un prix unique, facturé et affiché
 * en euros, `SUBSCRIPTION_PLAN` en étant la source. Le jour où le PO décide, il y
 * a un seul endroit à changer, et l'affichage suit sans qu'on y retouche.
 *
 * Passée par `money()` et non écrite à la main : c'est `moneySchema` qui vérifie
 * que le montant est un entier dans les bornes et que le code devise a la forme
 * ISO 4217. Une offre mal libellée échouerait au chargement du module plutôt que
 * sur la page de paiement d'un salon.
 *
 * Gelée comme `SUBSCRIPTION_PLAN` au-dessus : c'est désormais l'objet même que
 * les écrans partagent — `apps/web/lib/plan.ts` l'exporte tel quel sous
 * `PLAN_MONEY` — et non plus une copie par consommateur. Une écriture sur ce
 * montant changerait le prix annoncé partout à la fois ; `Object.freeze` la
 * refuse au lieu de la propager.
 */
export const SUBSCRIPTION_PLAN_PRICE: Money = Object.freeze(
  money(SUBSCRIPTION_PLAN.amountMinor, SUBSCRIPTION_PLAN.currency),
);

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
