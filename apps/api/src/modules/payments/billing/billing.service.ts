import { Inject, Injectable } from '@nestjs/common';
import {
  SUBSCRIPTION_PLAN,
  tenantPublicUrl,
  type Locale,
  type TenantBilling,
} from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { AppConfigService } from '../../../config/app-config.service';
import { TenantBillingGate } from '../../identity/tenant-billing.gate';
import { BillingAccountMissingError, BillingNotApplicableError } from '../payments.errors';
import { StripeConfig } from '../stripe/stripe.config';
import { BillingRepository, type BillingRecord } from './billing.repository';
import { billingStatusFromStripe } from './billing.status';
import {
  STRIPE_BILLING_GATEWAY,
  type StripeBillingGateway,
  type StripeSubscriptionSnapshot,
} from './stripe-billing.gateway';

/**
 * L'abonnement du salon courant — ADR 0016.
 *
 * ## Deux chemins vers le même état, et pourquoi il en faut deux
 *
 * Stripe annonce chaque changement d'abonnement par webhook
 * (`customer.subscription.*`), et c'est le chemin nominal en production. Mais un
 * webhook n'atteint pas un poste de développement, et il peut arriver après que
 * le gérant est revenu de la page de paiement. L'écran d'abonnement relit donc
 * l'abonnement **chez Stripe** à chaque affichage (`current`), et applique ce
 * qu'il y trouve par la même fonction que le webhook (`applySubscription`).
 * Stripe reste la seule source de vérité : rien ici ne déduit un paiement de la
 * seule réponse du navigateur (payments-stripe §2).
 */
@Injectable()
export class BillingService {
  public constructor(
    private readonly repository: BillingRepository,
    @Inject(STRIPE_BILLING_GATEWAY) private readonly stripe: StripeBillingGateway,
    private readonly stripeConfig: StripeConfig,
    private readonly config: AppConfigService,
    private readonly gate: TenantBillingGate,
    private readonly logger: StructuredLogger,
  ) {}

  /** L'état de l'abonnement, resynchronisé avec Stripe quand il y a de quoi. */
  public async current(tenantId: string): Promise<TenantBilling> {
    let record = await this.requireRecord();

    if (record.status !== 'managed') {
      try {
        record = await this.syncFromStripe(tenantId, record);
      } catch (error) {
        // Stripe injoignable : l'écran montre l'état connu plutôt qu'une
        // erreur. Le webhook, ou le prochain affichage, rattrapera.
        this.logger.warn('Abonnement : resynchronisation Stripe impossible', {
          tenantId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      }
    }

    return {
      status: record.status,
      trialEndsAt: record.trialEndsAt?.toISOString() ?? null,
      currentPeriodEndsAt: record.currentPeriodEndsAt?.toISOString() ?? null,
      hasBillingAccount: record.stripeCustomerId !== null,
    };
  }

  /**
   * Ouvre une session Stripe Checkout : l'offre unique, avec son essai gratuit,
   * la carte enregistrée d'emblée. Rend l'adresse de la page hébergée.
   */
  public async startCheckout(tenantId: string, userId: string): Promise<{ url: string }> {
    const record = await this.requireRecord();

    if (record.status === 'managed') {
      throw new BillingNotApplicableError();
    }
    if (record.status !== 'pending' && record.status !== 'canceled') {
      throw new BillingNotApplicableError('L’abonnement de ce salon est déjà en cours.');
    }

    const customerId =
      record.stripeCustomerId ??
      (
        await this.stripe.createCustomer({
          tenantId,
          email: record.contactEmail,
          name: record.name,
        })
      ).id;

    const returnUrl = (retour: string): string =>
      tenantPublicUrl(record.slug, `/admin/abonnement?retour=${retour}`, {
        baseUrl: this.config.appUrl,
      });

    const session = await this.stripe.createSubscriptionCheckout({
      customerId,
      tenantId,
      priceId: this.stripeConfig.subscriptionPriceId,
      inlinePrice: {
        amountMinor: SUBSCRIPTION_PLAN.amountMinor,
        currency: SUBSCRIPTION_PLAN.currency,
        interval: SUBSCRIPTION_PLAN.interval,
        productName: SUBSCRIPTION_PLAN.name,
      },
      // Un salon qui revient après une résiliation n'a pas droit à un second
      // essai : la carte est prélevée tout de suite.
      trialDays: record.status === 'pending' ? SUBSCRIPTION_PLAN.trialDays : 0,
      successUrl: returnUrl('paiement'),
      cancelUrl: returnUrl('annule'),
      locale: await this.localeFor(userId, record),
    });

    await this.repository.updateCurrent({
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
    });

    this.logger.log('Abonnement : session de paiement ouverte', { tenantId });
    return { url: session.url };
  }

  /** Le portail client de Stripe : carte, factures, résiliation. */
  public async openPortal(userId: string): Promise<{ url: string }> {
    const record = await this.requireRecord();

    if (record.stripeCustomerId === null) {
      throw new BillingAccountMissingError();
    }

    return this.stripe.createPortalSession({
      customerId: record.stripeCustomerId,
      returnUrl: tenantPublicUrl(record.slug, '/admin/abonnement', {
        baseUrl: this.config.appUrl,
      }),
      locale: await this.localeFor(userId, record),
    });
  }

  /**
   * Écrit ce que Stripe dit d'un abonnement — le point commun du webhook et de
   * la resynchronisation. La portée doit être posée sur le salon.
   */
  public async applySubscription(
    tenantId: string,
    snapshot: StripeSubscriptionSnapshot,
  ): Promise<BillingRecord> {
    const status = billingStatusFromStripe(snapshot.status);

    await this.repository.updateCurrent({
      ...(status === null ? {} : { status }),
      trialEndsAt: snapshot.trialEndsAt,
      currentPeriodEndsAt: snapshot.currentPeriodEndsAt,
      stripeCustomerId: snapshot.customerId,
      stripeSubscriptionId: snapshot.id,
    });
    this.gate.invalidate(tenantId);

    return this.requireRecord();
  }

  /**
   * La langue des pages hébergées par Stripe — #1231.
   *
   * ## La règle, dans l'ordre
   *
   * La préférence du gérant qui clique (`users.locale`), la langue de
   * l'établissement (`tenants.default_locale`) sinon, et `en` en dernier ressort
   * — ce dernier repli étant tenu par `toTenantLocale`, dans le dépôt. C'est
   * exactement la règle de `resolveRecipientLocale` pour les notifications
   * (#854) : une personne qui a choisi sa langue la retrouve partout, y compris
   * sur une page qui n'est pas la nôtre.
   *
   * ## Pourquoi à l'ouverture, et non à l'inscription
   *
   * La session Checkout et la session de portail sont créées à chaque clic : la
   * langue se résout donc à l'instant où la page s'ouvre. Un gérant qui bascule
   * son compte en anglais et rouvre son abonnement voit l'anglais, sans qu'il y
   * ait rien à réémettre chez Stripe.
   *
   * `record` est celui que l'appelant a déjà lu — le repli d'établissement ne
   * coûte aucune requête de plus, seule la préférence du compte en demande une.
   */
  private async localeFor(userId: string, record: BillingRecord): Promise<Locale> {
    return (await this.repository.findAccountLocale(userId)) ?? record.defaultLocale;
  }

  private async syncFromStripe(tenantId: string, record: BillingRecord): Promise<BillingRecord> {
    let subscriptionId = record.stripeSubscriptionId;

    // Revenu de la page de paiement avant que le webhook ne l'annonce : la
    // session Checkout dit quel abonnement elle a créé.
    if (subscriptionId === null && record.stripeCheckoutSessionId !== null) {
      const checkout = await this.stripe.retrieveCheckoutSession(record.stripeCheckoutSessionId);
      subscriptionId = checkout.status === 'complete' ? checkout.subscriptionId : null;
    }

    if (subscriptionId === null) {
      return record;
    }

    return this.applySubscription(tenantId, await this.stripe.retrieveSubscription(subscriptionId));
  }

  private async requireRecord(): Promise<BillingRecord> {
    const record = await this.repository.findCurrent();
    if (record === null) {
      throw new NotFoundError('Établissement introuvable.');
    }
    return record;
  }
}
