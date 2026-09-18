import { Inject, Injectable } from '@nestjs/common';
import { SUBSCRIPTION_PLAN, tenantPublicUrl, type TenantBilling } from '@spa/shared';

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
  public async startCheckout(tenantId: string): Promise<{ url: string }> {
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
    });

    await this.repository.updateCurrent({
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
    });

    this.logger.log('Abonnement : session de paiement ouverte', { tenantId });
    return { url: session.url };
  }

  /** Le portail client de Stripe : carte, factures, résiliation. */
  public async openPortal(): Promise<{ url: string }> {
    const record = await this.requireRecord();

    if (record.stripeCustomerId === null) {
      throw new BillingAccountMissingError();
    }

    return this.stripe.createPortalSession({
      customerId: record.stripeCustomerId,
      returnUrl: tenantPublicUrl(record.slug, '/admin/abonnement', {
        baseUrl: this.config.appUrl,
      }),
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
