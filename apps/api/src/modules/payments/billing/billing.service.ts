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
   *
   * `submittedLocale` est la langue de la session qui clique, quand l'appelant en
   * envoie une — voir {@link localeFor}.
   */
  public async startCheckout(
    tenantId: string,
    userId: string,
    submittedLocale?: Locale,
  ): Promise<{ url: string }> {
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
      locale: await this.localeFor(userId, record, submittedLocale),
    });

    await this.repository.updateCurrent({
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
    });

    this.logger.log('Abonnement : session de paiement ouverte', { tenantId });
    return { url: session.url };
  }

  /**
   * Le portail client de Stripe : carte, factures, résiliation.
   *
   * `submittedLocale` joue le même rôle que pour la page de paiement — voir
   * {@link localeFor}.
   */
  public async openPortal(userId: string, submittedLocale?: Locale): Promise<{ url: string }> {
    const record = await this.requireRecord();

    if (record.stripeCustomerId === null) {
      throw new BillingAccountMissingError();
    }

    return this.stripe.createPortalSession({
      customerId: record.stripeCustomerId,
      returnUrl: tenantPublicUrl(record.slug, '/admin/abonnement', {
        baseUrl: this.config.appUrl,
      }),
      locale: await this.localeFor(userId, record, submittedLocale),
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
   * La langue des pages hébergées par Stripe — #1231, corrigé par #1261.
   *
   * ## La règle, dans l'ordre
   *
   * 1. **La langue soumise** — celle que le back-office affiche à l'instant du
   *    clic, transmise par l'appelant. Ce qu'une personne a explicitement demandé
   *    gagne sur ce qu'on sait d'elle ;
   * 2. **la préférence du compte** (`users.locale`), qui vaut pour tous ses
   *    appareils ;
   * 3. **la langue de l'établissement** (`tenants.default_locale`) ;
   * 4. **`en`** en dernier ressort — repli tenu par `toTenantLocale`, dans le
   *    dépôt.
   *
   * C'est **l'ordre d'`apps/web/i18n/resolve.ts`** (#845), amputé du seul signal
   * qui n'a pas de sens ici : `Accept-Language`, que le front consulte pour
   * deviner la langue de qui n'a rien demandé, et qui n'arriverait jusqu'à cette
   * route que via une action serveur dont l'en-tête est celui du serveur.
   *
   * #1231 s'arrêtait à l'étape 2, et les signaux se trouvaient donc **inversés**
   * par rapport au reste du produit : un gérant dont le compte est en français et
   * qui bascule l'interface en anglais obtenait encore une page Stripe en
   * français. L'export CSV du reporting avait déjà tranché dans ce sens (#851,
   * « la langue vient de l'interface au moment de l'export »).
   *
   * ## Ce que cette méthode ne fait pas : juger la langue soumise
   *
   * Elle reçoit une `Locale`, jamais une chaîne : `billingRedirectRequestSchema`
   * l'a validée à la frontière, et une valeur qui ne désigne aucune des deux
   * langues du contrat a déjà rendu 400 `VALIDATION_ERROR` sans atteindre ce
   * service. Retomber ici sur la préférence du compte aurait ouvert la page dans
   * une langue que personne n'a demandée, en masquant l'appelant fautif.
   *
   * ## Pourquoi à l'ouverture, et non à l'inscription
   *
   * La session Checkout et la session de portail sont créées à chaque clic : la
   * langue se résout donc à l'instant où la page s'ouvre. Un gérant qui bascule
   * l'interface en anglais et rouvre son abonnement voit l'anglais, sans qu'il y
   * ait rien à réémettre chez Stripe.
   *
   * `record` est celui que l'appelant a déjà lu — le repli d'établissement ne
   * coûte aucune requête de plus. La préférence du compte en demande une, et une
   * langue soumise l'épargne : l'étape 1 court-circuite la lecture.
   */
  private async localeFor(
    userId: string,
    record: BillingRecord,
    submittedLocale?: Locale,
  ): Promise<Locale> {
    return (
      submittedLocale ??
      (await this.repository.findAccountLocale(userId)) ??
      record.defaultLocale
    );
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
