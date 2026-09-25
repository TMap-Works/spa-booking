import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { StripeBillingHttpGateway } from '../billing/stripe-billing.gateway';
import { testStripeConfig } from './payments.doubles';

/**
 * La passerelle d'abonnement — les pages **hébergées par Stripe**, Checkout et
 * portail client.
 *
 * `fetch` est simulé de bout en bout : aucun test de ce dépôt n'atteint
 * l'environnement Stripe, live ou test (payments-stripe §7).
 *
 * Ce que la suite vérifie :
 *
 * 1. **la langue transmise** — `#1231` : elle vient de la commande, et la
 *    passerelle ne décide plus à la place du gérant ;
 * 2. **ce qui n'entre pas dans le formulaire** — aucun champ de carte, la
 *    saisie restant sur les pages de Stripe (payments-stripe §1, SAQ A).
 */

function fakeLogger(): StructuredLogger {
  return { error: () => undefined } as unknown as StructuredLogger;
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

const CHECKOUT_BODY = { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
const PORTAL_BODY = { url: 'https://billing.stripe.com/p/session/ps_test_1' };

const CHECKOUT_COMMAND = {
  customerId: 'cus_1',
  tenantId: 't-1',
  priceId: null,
  inlinePrice: { amountMinor: 4900, currency: 'EUR', interval: 'month', productName: 'Offre' },
  trialDays: 14,
  successUrl: 'https://salon.example/admin/abonnement?retour=paiement',
  cancelUrl: 'https://salon.example/admin/abonnement?retour=annule',
} as const;

describe('StripeBillingHttpGateway', () => {
  const gateway = (): StripeBillingHttpGateway =>
    new StripeBillingHttpGateway(testStripeConfig(), fakeLogger());

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  function postedBody(): URLSearchParams {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return init.body as URLSearchParams;
  }

  describe('session de paiement de l’abonnement', () => {
    // Les deux langues du produit, et non la seule qui était écrite en dur :
    // c'est le défaut que #1231 corrige — un gérant anglophone payait sur une
    // page en français.
    it.each(['fr', 'en'] as const)(
      'transmet la langue %s telle que la commande la porte',
      async (locale) => {
        fetchMock.mockResolvedValue(jsonResponse(CHECKOUT_BODY));

        await gateway().createSubscriptionCheckout({ ...CHECKOUT_COMMAND, locale });

        expect(postedBody().get('locale')).toBe(locale);
      },
    );

    it('ne pose aucun champ de carte dans le formulaire', async () => {
      fetchMock.mockResolvedValue(jsonResponse(CHECKOUT_BODY));

      await gateway().createSubscriptionCheckout({ ...CHECKOUT_COMMAND, locale: 'en' });

      const body = postedBody();
      // La carte est saisie sur la page hébergée ; notre formulaire n'en parle
      // pas — `payment_method_collection` dit seulement *quand* Stripe la
      // demande, jamais ce qu'elle contient.
      expect(body.get('payment_method_collection')).toBe('always');
      expect([...body.keys()].join(' ')).not.toMatch(/\bcard|number|cvc|exp_/i);
    });
  });

  describe('portail de gestion', () => {
    it.each(['fr', 'en'] as const)('ouvre le portail en %s', async (locale) => {
      fetchMock.mockResolvedValue(jsonResponse(PORTAL_BODY));

      await gateway().createPortalSession({
        customerId: 'cus_1',
        returnUrl: 'https://salon.example/admin/abonnement',
        locale,
      });

      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
      expect(postedBody().get('locale')).toBe(locale);
    });
  });
});
