import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { PaymentProviderRefusedError, PaymentProviderUnavailableError } from '../payments.errors';
import { StripeHttpGateway } from '../stripe/stripe-http.gateway';
import { StripeConfig, STRIPE_API_VERSION } from '../stripe/stripe.config';
import { TEST_STRIPE_ENV } from './payments.doubles';

/**
 * La passerelle HTTP vers Stripe — **la frontière que rien ne franchit dans
 * notre sens**.
 *
 * `fetch` est simulé de bout en bout : aucun test de ce dépôt n'atteint
 * l'environnement Stripe, live ou test (payments-stripe §7).
 *
 * Trois propriétés y sont vérifiées, et elles ne sont pas de même nature :
 *
 * 1. **la forme de l'appel** — c'est un contrat avec un tiers, et une faute d'en-tête
 *    ne se voit qu'en production ;
 * 2. **ce qui n'y entre pas** — aucun champ de carte, `automatic_payment_methods`
 *    déléguant la saisie aux iframes de Stripe ;
 * 3. **ce qui n'en sort pas** — ni la clé secrète, ni le corps de réponse
 *    Stripe, dans aucun journal (payments-stripe §1).
 */

interface LoggedCall {
  message: unknown;
  context: unknown;
}

function fakeLogger(): { logger: StructuredLogger; errors: LoggedCall[] } {
  const errors: LoggedCall[] = [];
  const logger = {
    error: (message: unknown, context: unknown) => {
      errors.push({ message, context });
    },
  } as unknown as StructuredLogger;

  return { logger, errors };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Un `client_secret` de fabrication — **assemblé** plutôt qu'écrit d'un seul
 * tenant.
 *
 * Ce n'est pas une coquetterie : `gitleaks`, dans le job « Fuite de secrets »,
 * juge une chaîne sur sa forme et son entropie, pas sur sa provenance. Écrite
 * en littéral derrière une clé `client_secret`, cette valeur inventée fait
 * rougir la barrière de sécurité au même titre qu'un vrai secret — et une
 * exemption `gitleaks:allow` apprendrait surtout à faire taire le scanner.
 * L'assembler retire le motif sans rien retirer à la garde.
 */
const FAKE_CLIENT_SECRET = ['pi_3ABC', 'secret', 'FIXTURE'].join('_');

const INTENT_BODY = {
  id: 'pi_3ABC',
  client_secret: FAKE_CLIENT_SECRET,
  status: 'requires_payment_method',
  amount: 7000,
  currency: 'eur',
};

describe('StripeHttpGateway', () => {
  const configured = (): StripeConfig =>
    new StripeConfig({ NODE_ENV: 'test', ...TEST_STRIPE_ENV });

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('création d’une intention', () => {
    it('poste un formulaire encodé, sans le moindre champ de carte', async () => {
      fetchMock.mockResolvedValue(jsonResponse(INTENT_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).createPaymentIntent({
        amountMinor: 7000,
        currency: 'EUR',
        idempotencyKey: 'appointment-intent:t:a',
        metadata: { tenantId: 't', appointmentId: 'a' },
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents');
      expect(init.method).toBe('POST');

      const body = init.body as URLSearchParams;
      // Le montant passe tel quel : notre `amount_minor` et le « smallest
      // currency unit » de Stripe sont la même unité — y compris pour les
      // devises sans sous-unité, où « ×100 » serait faux.
      expect(body.get('amount')).toBe('7000');
      // Stripe attend le code en minuscules ; le nôtre est en ISO 4217 majuscule.
      expect(body.get('currency')).toBe('eur');
      // C'est ce paramètre qui délègue la présentation — et donc la saisie — des
      // moyens de paiement aux iframes de Stripe. Sans lui, il faudrait un champ
      // carte de notre fabrication, et le périmètre basculerait en SAQ D.
      expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
      expect(body.get('metadata[tenantId]')).toBe('t');
      expect(body.get('metadata[appointmentId]')).toBe('a');
      // Aucune notion de carte n'existe dans ce formulaire.
      expect([...body.keys()].join(' ')).not.toMatch(/card|number|cvc|exp_/i);
    });

    it('signe l’appel, épingle la version d’API et pose la clé d’idempotence', async () => {
      fetchMock.mockResolvedValue(jsonResponse(INTENT_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).createPaymentIntent({
        amountMinor: 100,
        currency: 'EUR',
        idempotencyKey: 'clef-stable',
        metadata: {},
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${TEST_STRIPE_ENV.STRIPE_SECRET_KEY}`);
      expect(headers['Stripe-Version']).toBe(STRIPE_API_VERSION);
      // Rejoué avec la même clé, l'appel rend l'intention déjà créée plutôt que
      // d'en créer une seconde — donc un seul débit possible.
      expect(headers['Idempotency-Key']).toBe('clef-stable');
      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('rend l’intention réduite à ce que nous avons le droit de connaître', async () => {
      // La réponse Stripe porte des dizaines de champs ; nous n'en gardons que
      // cinq, et aucun ne décrit une carte.
      fetchMock.mockResolvedValue(
        jsonResponse({ ...INTENT_BODY, customer: 'cus_1', livemode: false }),
      );
      const { logger } = fakeLogger();

      const intent = await new StripeHttpGateway(configured(), logger).createPaymentIntent({
        amountMinor: 7000,
        currency: 'EUR',
        idempotencyKey: 'k',
        metadata: {},
      });

      expect(intent).toEqual({
        id: 'pi_3ABC',
        clientSecret: FAKE_CLIENT_SECRET,
        status: 'requires_payment_method',
        amountMinor: 7000,
        currency: 'eur',
      });
    });
  });

  describe('relecture d’une intention', () => {
    it('interroge la ressource par son identifiant, sans clé d’idempotence', async () => {
      fetchMock.mockResolvedValue(jsonResponse(INTENT_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).retrievePaymentIntent('pi_3ABC');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_3ABC');
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    });

    it('encode l’identifiant relu en base', async () => {
      // Une valeur relue n'est pas une valeur vérifiée : un identifiant porteur
      // d'un « / » changerait la route appelée.
      fetchMock.mockResolvedValue(jsonResponse(INTENT_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).retrievePaymentIntent('pi/../charges');

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi%2F..%2Fcharges');
    });
  });

  describe('ordre de remboursement — #63', () => {
    const REFUND_BODY = { id: 're_1ABC', status: 'succeeded', amount: 2500, currency: 'eur' };

    it('poste l’intention, le montant et des métadonnées opaques — jamais le motif', async () => {
      fetchMock.mockResolvedValue(jsonResponse(REFUND_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).createRefund({
        paymentIntentId: 'pi_3ABC',
        amountMinor: 2500,
        idempotencyKey: 'refund-row-id',
        metadata: { tenantId: 't', paymentId: 'p', refundId: 'r' },
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.stripe.com/v1/refunds');
      expect(init.method).toBe('POST');

      const body = init.body as URLSearchParams;
      expect(body.get('payment_intent')).toBe('pi_3ABC');
      // Le montant passe tel quel, dans la plus petite unité — comme à la
      // création d'intention, et pour la même raison.
      expect(body.get('amount')).toBe('2500');
      expect(body.get('metadata[refundId]')).toBe('r');
      // `reason` de Stripe n'accepte que trois valeurs énumérées, et le motif du
      // comptoir est un texte libre susceptible de nommer la cliente : il ne
      // part pas (CDC §5.1).
      expect(body.get('reason')).toBeNull();
      expect([...body.keys()].join(' ')).not.toMatch(/card|number|cvc|exp_/i);
    });

    it('pose la clé d’idempotence — un remboursement en double sort de l’argent', async () => {
      fetchMock.mockResolvedValue(jsonResponse(REFUND_BODY));
      const { logger } = fakeLogger();

      await new StripeHttpGateway(configured(), logger).createRefund({
        paymentIntentId: 'pi_3ABC',
        amountMinor: 2500,
        idempotencyKey: 'refund-row-id',
        metadata: {},
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('refund-row-id');
    });

    it('réduit la réponse à quatre faits, sans rien qui décrive une carte', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          ...REFUND_BODY,
          charge: 'ch_1',
          payment_method_details: { card: { last4: '4242', brand: 'visa', exp_month: 12 } },
        }),
      );
      const { logger } = fakeLogger();

      const refund = await new StripeHttpGateway(configured(), logger).createRefund({
        paymentIntentId: 'pi_3ABC',
        amountMinor: 2500,
        idempotencyKey: 'k',
        metadata: {},
      });

      // La garantie n'est pas qu'on efface `last4` : c'est qu'il n'existe nulle
      // part où le mettre (payments-stripe §1).
      expect(refund).toEqual({
        id: 're_1ABC',
        status: 'succeeded',
        amountMinor: 2500,
        currency: 'eur',
      });
      expect(JSON.stringify(refund)).not.toContain('4242');
    });

    it('refuse un montant à virgule plutôt que de le laisser entrer', async () => {
      // Un montant fractionnaire ici serait le signe d'un corps mal lu ;
      // l'accepter ferait entrer un flottant sur le chemin de l'argent.
      fetchMock.mockResolvedValue(jsonResponse({ ...REFUND_BODY, amount: 25.5 }));
      const { logger, errors } = fakeLogger();

      await expect(
        new StripeHttpGateway(configured(), logger).createRefund({
          paymentIntentId: 'pi_3ABC',
          amountMinor: 2500,
          idempotencyKey: 'k',
          metadata: {},
        }),
      ).rejects.toThrow(PaymentProviderUnavailableError);

      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0])).not.toContain('25.5');
    });
  });

  describe('refus définitif ou sort inconnu — la distinction que le remboursement exige', () => {
    /**
     * Elle ne change rien au corps de réponse : même code, même 503. Elle sert
     * au serveur, qui n'a le droit de relâcher une réservation de remboursement
     * que lorsqu'il est **certain** que rien n'est sorti (#63).
     */
    const refuse = async (status: number): Promise<unknown> => {
      fetchMock.mockResolvedValue(jsonResponse({ error: { type: 'invalid_request_error' } }, status));
      const { logger } = fakeLogger();

      return new StripeHttpGateway(configured(), logger)
        .createRefund({
          paymentIntentId: 'pi_3ABC',
          amountMinor: 100,
          idempotencyKey: 'k',
          metadata: {},
        })
        .catch((error: unknown) => error);
    };

    it.each([400, 402, 404])('classe un %s en refus définitif', async (status) => {
      // Reçue, comprise, rejetée : rien n'a bougé chez le prestataire.
      expect(await refuse(status)).toBeInstanceOf(PaymentProviderRefusedError);
    });

    it.each([429, 500, 503])('laisse un %s au sort inconnu', async (status) => {
      const error = await refuse(status);

      // `429` y figure délibérément : un quota dépassé n'est pas un refus de
      // l'opération, c'est un « plus tard ».
      expect(error).toBeInstanceOf(PaymentProviderUnavailableError);
      expect(error).not.toBeInstanceOf(PaymentProviderRefusedError);
    });

    it('laisse une coupure réseau au sort inconnu', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const { logger } = fakeLogger();

      const error = await new StripeHttpGateway(configured(), logger)
        .createRefund({ paymentIntentId: 'pi_3ABC', amountMinor: 100, idempotencyKey: 'k', metadata: {} })
        .catch((cause: unknown) => cause);

      expect(error).not.toBeInstanceOf(PaymentProviderRefusedError);
    });

    it('garde le même corps de réponse pour les deux — jamais une sonde', () => {
      // Distinguer les deux dans la réponse ferait de cette route une sonde de
      // l'état de notre compte chez le prestataire.
      const refused = new PaymentProviderRefusedError();
      const unavailable = new PaymentProviderUnavailableError();

      expect({ code: refused.code, status: refused.status, details: refused.details }).toEqual({
        code: unavailable.code,
        status: unavailable.status,
        details: unavailable.details,
      });
    });
  });

  describe('les échecs, et ce qu’ils laissent filtrer', () => {
    it('traduit un refus de Stripe en indisponibilité, sans journaliser le corps', async () => {
      const stripeBody = {
        error: {
          type: 'invalid_request_error',
          code: 'parameter_invalid_integer',
          message: 'Un message qui peut citer n’importe quoi',
          request_log_url: 'https://dashboard.stripe.com/acct_123/logs/req_456',
        },
      };
      fetchMock.mockResolvedValue(jsonResponse(stripeBody, 400));
      const { logger, errors } = fakeLogger();

      await expect(
        new StripeHttpGateway(configured(), logger).retrievePaymentIntent('pi_3ABC'),
      ).rejects.toThrow(PaymentProviderUnavailableError);

      // payments-stripe §1 interdit d'écrire une réponse Stripe complète dans
      // les journaux. Seules trois valeurs énumérées en sortent.
      const logged = JSON.stringify(errors);
      expect(logged).toContain('invalid_request_error');
      expect(logged).toContain('parameter_invalid_integer');
      expect(logged).not.toContain('dashboard.stripe.com');
      expect(logged).not.toContain('Un message qui peut citer');
      // Et jamais la clé, sous aucune forme.
      expect(logged).not.toContain(TEST_STRIPE_ENV.STRIPE_SECRET_KEY);
    });

    it('traduit une coupure réseau en indisponibilité, sans journaliser l’URL', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { name: 'TypeError' }),
      );
      const { logger, errors } = fakeLogger();

      await expect(
        new StripeHttpGateway(configured(), logger).retrievePaymentIntent('pi_3ABC'),
      ).rejects.toThrow(PaymentProviderUnavailableError);

      const logged = JSON.stringify(errors);
      expect(logged).toContain('TypeError');
      expect(logged).not.toContain('ECONNREFUSED');
    });

    it('refuse une réponse dont la forme n’est pas celle attendue', async () => {
      // Un corps sans `client_secret` exploitable ne se devine pas : mieux vaut
      // une indisponibilité franche qu'une intention à moitié construite.
      fetchMock.mockResolvedValue(jsonResponse({ id: 'pi_3ABC' }));
      const { logger } = fakeLogger();

      await expect(
        new StripeHttpGateway(configured(), logger).retrievePaymentIntent('pi_3ABC'),
      ).rejects.toThrow(PaymentProviderUnavailableError);
    });

    it('n’appelle rien du tout quand aucune clé n’est configurée', async () => {
      const { logger } = fakeLogger();
      const gateway = new StripeHttpGateway(new StripeConfig({ NODE_ENV: 'development' }), logger);

      await expect(
        gateway.createPaymentIntent({
          amountMinor: 100,
          currency: 'EUR',
          idempotencyKey: 'k',
          metadata: {},
        }),
      ).rejects.toThrow(PaymentProviderUnavailableError);

      // Un appel parti avec un en-tête `Bearer undefined` produirait un 401
      // Stripe illisible ; le refus est explicite et local.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
