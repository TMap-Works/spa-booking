import { Injectable } from '@nestjs/common';
import type { Locale } from '@spa/shared';

import { StructuredLogger } from '../../../common/logging/structured-logger';
import { PaymentProviderRefusedError, PaymentProviderUnavailableError } from '../payments.errors';
import { STRIPE_API_VERSION, StripeConfig } from '../stripe/stripe.config';

/**
 * L'abonnement des salons chez Stripe — ADR 0016.
 *
 * Un port distinct de `StripeGateway` (encaissement des rendez-vous) : les deux
 * n'ont en commun que le compte et la clé. Les tenir séparés laisse les doubles
 * de test de l'encaissement intacts, et borne ce que chaque module peut
 * demander au prestataire.
 *
 * Tout ce qui touche une carte se passe sur les pages **hébergées** par Stripe
 * — Checkout et le portail client : notre code ne voit que des identifiants
 * (payments-stripe §1, SAQ A).
 */

export const STRIPE_BILLING_GATEWAY = Symbol('STRIPE_BILLING_GATEWAY');

/** Un abonnement tel que Stripe le décrit, réduit à ce que le salon en montre. */
export interface StripeSubscriptionSnapshot {
  readonly id: string;
  readonly customerId: string;
  /** Le statut Stripe brut : `trialing`, `active`, `past_due`, `canceled`… */
  readonly status: string;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEndsAt: Date | null;
}

export interface StripeCheckoutSnapshot {
  readonly id: string;
  /** `open`, `complete` ou `expired`. */
  readonly status: string;
  readonly subscriptionId: string | null;
}

export interface CreateSubscriptionCheckoutCommand {
  readonly customerId: string;
  readonly tenantId: string;
  /** Un prix créé dans Stripe, ou `null` pour le décrire à la volée. */
  readonly priceId: string | null;
  readonly inlinePrice: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly interval: string;
    readonly productName: string;
  };
  readonly trialDays: number;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /**
   * La langue des pages **hébergées par Stripe** — #1231.
   *
   * Portée par la commande plutôt que décidée ici : la passerelle ne sait rien
   * du gérant qui clique, et une langue écrite en dur dans le formulaire était
   * exactement le défaut à corriger. `fr` et `en` sont des étiquettes que Stripe
   * accepte telles quelles pour Checkout comme pour le portail, ce qui évite une
   * table de correspondance dont le seul rôle serait de recopier `Locale`.
   */
  readonly locale: Locale;
}

/**
 * L'ouverture du portail client — nommée, comme la commande de Checkout, plutôt
 * que réécrite au point d'appel.
 *
 * Elle l'était trois fois : dans le port, dans son implémentation HTTP, et dans
 * le double de `billing.locale.spec.ts`. Trois copies d'une même forme, dont
 * l'ajout de `locale` (#1231) venait de montrer qu'elles ne bougent pas
 * ensemble par elles-mêmes.
 */
export interface CreatePortalSessionCommand {
  readonly customerId: string;
  readonly returnUrl: string;
  /** La langue du portail hébergé — même règle que le Checkout (#1231). */
  readonly locale: Locale;
}

export interface StripeBillingGateway {
  createCustomer(command: {
    readonly tenantId: string;
    readonly email: string | null;
    readonly name: string;
  }): Promise<{ readonly id: string }>;
  createSubscriptionCheckout(
    command: CreateSubscriptionCheckoutCommand,
  ): Promise<{ readonly id: string; readonly url: string }>;
  retrieveCheckoutSession(id: string): Promise<StripeCheckoutSnapshot>;
  retrieveSubscription(id: string): Promise<StripeSubscriptionSnapshot>;
  createPortalSession(command: CreatePortalSessionCommand): Promise<{ readonly url: string }>;
}

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 10_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Un identifiant, qu'il soit rendu tel quel ou « expansé » en objet. */
function readReference(source: Record<string, unknown> | null, key: string): string | null {
  return readString(source, key) ?? readString(asRecord(source?.[key]), 'id');
}

/** Un horodatage Unix de Stripe (secondes), en instant — ou `null`. */
function readUnixInstant(source: Record<string, unknown> | null, key: string): Date | null {
  const value = source?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? new Date(value * 1000)
    : null;
}

/**
 * La lecture d'un abonnement — exportée pour que le webhook lise l'objet de
 * l'événement avec **la même** règle que la synchronisation au retour.
 *
 * Depuis la version d'API `2025-03-31.basil`, l'échéance vit sur les **lignes**
 * de l'abonnement et non plus sur l'abonnement lui-même : elle est lue sur la
 * première ligne, l'offre n'en ayant qu'une.
 */
export function readSubscriptionSnapshot(payload: unknown): StripeSubscriptionSnapshot | null {
  const subscription = asRecord(payload);
  const id = readString(subscription, 'id');
  const customerId = readReference(subscription, 'customer');
  const status = readString(subscription, 'status');

  if (id === null || customerId === null || status === null) {
    return null;
  }

  const items = asRecord(subscription?.['items']);
  const firstItem = Array.isArray(items?.['data']) ? asRecord(items['data'][0]) : null;

  return {
    id,
    customerId,
    status,
    trialEndsAt: readUnixInstant(subscription, 'trial_end'),
    currentPeriodEndsAt:
      readUnixInstant(firstItem, 'current_period_end') ??
      readUnixInstant(subscription, 'current_period_end'),
  };
}

@Injectable()
export class StripeBillingHttpGateway implements StripeBillingGateway {
  public constructor(
    private readonly config: StripeConfig,
    private readonly logger: StructuredLogger,
  ) {}

  public async createCustomer(command: {
    tenantId: string;
    email: string | null;
    name: string;
  }): Promise<{ id: string }> {
    const form = new URLSearchParams();
    form.set('name', command.name);
    if (command.email !== null) {
      form.set('email', command.email);
    }
    // Le lien vers le salon, pour que le webhook retrouve l'établissement.
    form.set('metadata[tenantId]', command.tenantId);

    const payload = await this.call('/customers', {
      method: 'POST',
      body: form,
      // Un client Stripe par salon : rejoué, l'appel rend le même client.
      idempotencyKey: `salon-customer-${command.tenantId}`,
    });

    const id = readString(asRecord(payload), 'id');
    if (id === null) {
      return this.unreadable('customer');
    }
    return { id };
  }

  public async createSubscriptionCheckout(
    command: CreateSubscriptionCheckoutCommand,
  ): Promise<{ id: string; url: string }> {
    const form = new URLSearchParams();
    form.set('mode', 'subscription');
    form.set('customer', command.customerId);
    form.set('client_reference_id', command.tenantId);
    form.set('metadata[tenantId]', command.tenantId);
    form.set('line_items[0][quantity]', '1');

    if (command.priceId === null) {
      // Entier, dans la plus petite unité de la devise (payments-stripe §5).
      form.set('line_items[0][price_data][currency]', command.inlinePrice.currency.toLowerCase());
      form.set('line_items[0][price_data][unit_amount]', String(command.inlinePrice.amountMinor));
      form.set('line_items[0][price_data][recurring][interval]', command.inlinePrice.interval);
      form.set('line_items[0][price_data][product_data][name]', command.inlinePrice.productName);
    } else {
      form.set('line_items[0][price]', command.priceId);
    }

    // La carte est enregistrée dès l'inscription et prélevée à la fin de
    // l'essai — la décision du PO (ADR 0016).
    form.set('payment_method_collection', 'always');
    // Stripe refuse un essai de zéro jour : sans essai, le champ est omis.
    if (command.trialDays > 0) {
      form.set('subscription_data[trial_period_days]', String(command.trialDays));
    }
    // Porté par l'abonnement lui-même : c'est lui que décrivent les
    // événements `customer.subscription.*`.
    form.set('subscription_data[metadata][tenantId]', command.tenantId);
    form.set('locale', command.locale);
    form.set('success_url', command.successUrl);
    form.set('cancel_url', command.cancelUrl);

    const payload = asRecord(await this.call('/checkout/sessions', { method: 'POST', body: form }));
    const id = readString(payload, 'id');
    const url = readString(payload, 'url');

    if (id === null || url === null) {
      return this.unreadable('checkout');
    }
    return { id, url };
  }

  public async retrieveCheckoutSession(id: string): Promise<StripeCheckoutSnapshot> {
    const payload = asRecord(
      await this.call(`/checkout/sessions/${encodeURIComponent(id)}`, { method: 'GET' }),
    );
    const status = readString(payload, 'status');

    if (readString(payload, 'id') === null || status === null) {
      return this.unreadable('checkout-retrieve');
    }
    return { id, status, subscriptionId: readReference(payload, 'subscription') };
  }

  public async retrieveSubscription(id: string): Promise<StripeSubscriptionSnapshot> {
    const snapshot = readSubscriptionSnapshot(
      await this.call(`/subscriptions/${encodeURIComponent(id)}`, { method: 'GET' }),
    );
    return snapshot ?? this.unreadable('subscription');
  }

  public async createPortalSession(command: CreatePortalSessionCommand): Promise<{ url: string }> {
    const form = new URLSearchParams();
    form.set('customer', command.customerId);
    form.set('return_url', command.returnUrl);
    form.set('locale', command.locale);

    const url = readString(
      asRecord(await this.call('/billing_portal/sessions', { method: 'POST', body: form })),
      'url',
    );
    return url === null ? this.unreadable('portal') : { url };
  }

  private unreadable(operation: string): never {
    // Le corps n'est pas journalisé : une réponse inattendue est justement
    // celle dont on ne sait pas ce qu'elle contient.
    this.logger.error('Réponse Stripe inexploitable', { operation });
    throw new PaymentProviderUnavailableError();
  }

  /** Même conduite que la passerelle d'encaissement : 503 sans clé, rien du corps en journal. */
  private async call(
    path: string,
    options: { method: 'GET' | 'POST'; body?: URLSearchParams; idempotencyKey?: string },
  ): Promise<unknown> {
    if (!this.config.isConfigured) {
      this.logger.error('Aucune clé Stripe configurée', { path });
      throw new PaymentProviderUnavailableError();
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await fetch(`${STRIPE_API_BASE}${path}`, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      this.logger.error('Appel Stripe impossible', {
        path,
        reason: cause instanceof Error ? cause.name : 'unknown',
      });
      throw new PaymentProviderUnavailableError();
    }

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = asRecord(asRecord(payload)?.['error']);
      this.logger.error('Stripe a refusé l’appel', {
        path,
        status: response.status,
        type: readString(error, 'type') ?? 'unknown',
        code: readString(error, 'code') ?? 'unknown',
      });
      throw response.status >= 400 && response.status < 500 && response.status !== 429
        ? new PaymentProviderRefusedError()
        : new PaymentProviderUnavailableError();
    }

    return payload;
  }
}
