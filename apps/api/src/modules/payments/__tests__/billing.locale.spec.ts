import type { Locale } from '@spa/shared';

import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import type { TenantBillingGate } from '../../identity/tenant-billing.gate';
import type { BillingRecord, BillingRepository } from '../billing/billing.repository';
import { BillingService } from '../billing/billing.service';
import type {
  CreatePortalSessionCommand,
  CreateSubscriptionCheckoutCommand,
  StripeBillingGateway,
} from '../billing/stripe-billing.gateway';
import { testStripeConfig } from './payments.doubles';

/**
 * La langue des pages d'abonnement hébergées par Stripe — #1231.
 *
 * La passerelle prouve qu'elle envoie la langue qu'on lui donne
 * (`stripe-billing.gateway.spec.ts`) ; cette suite-ci prouve **laquelle** on lui
 * donne, sur les deux portes que le gérant emprunte : la page de paiement et le
 * portail de gestion.
 *
 * La règle, dans l'ordre : la préférence du compte, la langue de
 * l'établissement, puis `en`. Ce dernier repli n'est **pas** rejoué ici : il
 * appartient à `toTenantLocale` (`modules/identity/locale.ts`), qui couvre la
 * valeur ayant échappé à `tenants_default_locale_check` — une frontière de
 * dépôt, et non une règle de ce service, qui ne voit jamais qu'une `Locale`.
 */

const TENANT_ID = 't-1';
const USER_ID = 'u-1';

const RECORD: BillingRecord = {
  slug: 'salon-des-lilas',
  name: 'Salon des Lilas',
  contactEmail: 'gerant@example.test',
  status: 'pending',
  trialEndsAt: null,
  currentPeriodEndsAt: null,
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: null,
  stripeCheckoutSessionId: null,
  defaultLocale: 'en',
};

/** Ce que la passerelle a reçu — le seul point d'observation de la suite. */
interface Captured {
  readonly checkout: CreateSubscriptionCheckoutCommand[];
  readonly portal: CreatePortalSessionCommand[];
}

function build(
  record: Partial<BillingRecord>,
  accountLocale: Locale | null,
): { service: BillingService; captured: Captured } {
  const captured: Captured = { checkout: [], portal: [] };

  const repository = {
    findCurrent: () => Promise.resolve({ ...RECORD, ...record }),
    updateCurrent: () => Promise.resolve(),
    findAccountLocale: () => Promise.resolve(accountLocale),
  } as unknown as BillingRepository;

  const stripe: StripeBillingGateway = {
    createCustomer: () => Promise.resolve({ id: 'cus_1' }),
    createSubscriptionCheckout: (command) => {
      captured.checkout.push(command);
      return Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    },
    retrieveCheckoutSession: () =>
      Promise.resolve({ id: 'cs_1', status: 'open', subscriptionId: null }),
    retrieveSubscription: () =>
      Promise.resolve({
        id: 'sub_1',
        customerId: 'cus_1',
        status: 'active',
        trialEndsAt: null,
        currentPeriodEndsAt: null,
      }),
    createPortalSession: (command) => {
      captured.portal.push(command);
      return Promise.resolve({ url: 'https://billing.stripe.com/p/session/ps_1' });
    },
  };

  const service = new BillingService(
    repository,
    stripe,
    testStripeConfig(),
    { appUrl: 'https://booking.example' } as unknown as AppConfigService,
    {} as unknown as TenantBillingGate,
    { log: () => undefined, warn: () => undefined } as unknown as StructuredLogger,
  );

  return { service, captured };
}

describe('langue des pages d’abonnement Stripe', () => {
  describe('page de paiement', () => {
    it.each(['fr', 'en'] as const)(
      'suit la préférence %s du gérant, quelle que soit celle du salon',
      async (locale) => {
        // Le salon est dans l'autre langue : c'est bien le compte qui tranche.
        const other: Locale = locale === 'fr' ? 'en' : 'fr';
        const { service, captured } = build({ defaultLocale: other }, locale);

        await service.startCheckout(TENANT_ID, USER_ID);

        expect(captured.checkout[0]?.locale).toBe(locale);
      },
    );

    it.each(['fr', 'en'] as const)(
      'retombe sur la langue %s du salon quand le compte n’a rien choisi',
      async (locale) => {
        const { service, captured } = build({ defaultLocale: locale }, null);

        await service.startCheckout(TENANT_ID, USER_ID);

        expect(captured.checkout[0]?.locale).toBe(locale);
      },
    );
  });

  describe('portail de gestion', () => {
    it('suit la préférence du gérant', async () => {
      const { service, captured } = build({ defaultLocale: 'en' }, 'fr');

      await service.openPortal(USER_ID);

      expect(captured.portal[0]?.locale).toBe('fr');
    });

    it('retombe sur la langue du salon quand le compte n’a rien choisi', async () => {
      const { service, captured } = build({ defaultLocale: 'fr' }, null);

      await service.openPortal(USER_ID);

      expect(captured.portal[0]?.locale).toBe('fr');
    });
  });
});
