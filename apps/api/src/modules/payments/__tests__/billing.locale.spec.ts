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
 * La langue des pages d'abonnement hébergées par Stripe — #1231, corrigé par
 * #1261.
 *
 * La passerelle prouve qu'elle envoie la langue qu'on lui donne
 * (`stripe-billing.gateway.spec.ts`) ; cette suite-ci prouve **laquelle** on lui
 * donne, sur les deux portes que le gérant emprunte : la page de paiement et le
 * portail de gestion.
 *
 * La règle, dans l'ordre : **la langue soumise** par l'écran qui clique, la
 * préférence du compte, la langue de l'établissement, puis `en`. Ce dernier repli
 * n'est **pas** rejoué ici : il appartient à `toTenantLocale`
 * (`modules/identity/locale.ts`), qui couvre la valeur ayant échappé à
 * `tenants_default_locale_check` — une frontière de dépôt, et non une règle de ce
 * service, qui ne voit jamais qu'une `Locale`.
 *
 * ## Ce que la première étape a coûté, et ce qu'elle rend
 *
 * #1231 s'arrêtait à la préférence du compte, si bien qu'un gérant dont le compte
 * est en français et qui bascule l'interface en anglais partait sur une page
 * Stripe **française** — les signaux inversés par rapport au reste du produit
 * (`apps/web/i18n/resolve.ts`, #845). Les cas « langue soumise » ci-dessous sont
 * précisément ceux qui échouaient avant #1261.
 *
 * La **validation** de cette langue n'est pas ici : `billingRedirectRequestSchema`
 * l'a jugée à la frontière, et le service ne reçoit qu'une `Locale`. Ce que cette
 * suite mesure est la priorité, pas le refus.
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

/** Ce que la passerelle a reçu — le principal point d'observation de la suite. */
interface Captured {
  readonly checkout: CreateSubscriptionCheckoutCommand[];
  readonly portal: CreatePortalSessionCommand[];
  /**
   * Le nombre de lectures de `users.locale`. Une langue soumise doit court-
   * circuiter cette requête : la compter est la seule façon de le constater.
   */
  accountLookups: number;
}

function build(
  record: Partial<BillingRecord>,
  accountLocale: Locale | null,
): { service: BillingService; captured: Captured } {
  const captured: Captured = { checkout: [], portal: [], accountLookups: 0 };

  const repository = {
    findCurrent: () => Promise.resolve({ ...RECORD, ...record }),
    updateCurrent: () => Promise.resolve(),
    findAccountLocale: () => {
      captured.accountLookups += 1;
      return Promise.resolve(accountLocale);
    },
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
  describe('la langue soumise par l’écran l’emporte — #1261', () => {
    it.each(['fr', 'en'] as const)(
      'ouvre la page de paiement en %s, même quand le compte et le salon disent l’autre',
      async (submitted) => {
        // Le cas du ticket : le compte est en français, le sélecteur de langue
        // est passé à l'anglais. C'est le sélecteur qui doit gagner, comme
        // partout ailleurs dans le produit (`apps/web/i18n/resolve.ts`, #845).
        const other: Locale = submitted === 'fr' ? 'en' : 'fr';
        const { service, captured } = build({ defaultLocale: other }, other);

        await service.startCheckout(TENANT_ID, USER_ID, submitted);

        expect(captured.checkout[0]?.locale).toBe(submitted);
      },
    );

    it.each(['fr', 'en'] as const)(
      'ouvre le portail de gestion en %s dans les mêmes conditions',
      async (submitted) => {
        const other: Locale = submitted === 'fr' ? 'en' : 'fr';
        const { service, captured } = build({ defaultLocale: other }, other);

        await service.openPortal(USER_ID, submitted);

        expect(captured.portal[0]?.locale).toBe(submitted);
      },
    );

    it('n’interroge même pas `users.locale` quand la langue est soumise', async () => {
      // Une requête de moins par clic, et surtout : la preuve que l'étape 1 est
      // bien première et non un départage a posteriori.
      const { service, captured } = build({ defaultLocale: 'fr' }, 'fr');

      await service.startCheckout(TENANT_ID, USER_ID, 'en');
      await service.openPortal(USER_ID, 'en');

      expect(captured.accountLookups).toBe(0);
    });

    it('lit `users.locale` quand l’appelant ne soumet aucune langue', async () => {
      // Le contrôle symétrique du cas précédent : l'appelant antérieur à #1261
      // — celui qui n'envoie pas de corps — retrouve exactement la règle de
      // #1231, et non un repli muet sur la langue du salon.
      const { service, captured } = build({ defaultLocale: 'en' }, 'fr');

      await service.startCheckout(TENANT_ID, USER_ID);

      expect(captured.accountLookups).toBe(1);
      expect(captured.checkout[0]?.locale).toBe('fr');
    });
  });

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
