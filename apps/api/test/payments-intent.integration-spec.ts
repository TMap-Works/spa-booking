import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { PaymentProviderUnavailableError } from '../src/modules/payments/payments.errors';
import {
  createPaymentsHarness,
  TEST_STRIPE_ENV,
  type PaymentsHarness,
} from './payments.harness';

/**
 * Le module `payments` interrogé en HTTP, sur l'application réellement câblée —
 * `ValidationPipe` global, filtre d'exceptions, middleware de tenant compris.
 *
 * Ce que cette suite prouve, et que les tests unitaires ne peuvent pas :
 *
 * - la route est **réellement servie** — un contrôleur oublié dans les
 *   `controllers` de son module compile et passe ses tests unitaires, puis rend
 *   404 en vrai ;
 * - le **refus des champs non déclarés**, dont un `amount` et — surtout — tout
 *   ce qui ressemble à une carte. C'est là que la frontière SAQ A se prouve au
 *   niveau du transport : `forbidNonWhitelisted` rejette la requête avant
 *   qu'une seule ligne de code métier ne tourne, donc avant tout journal ;
 * - la **forme des réponses**, en particulier l'absence de `tenantId` et de la
 *   clé secrète ;
 * - la **table des codes** — 400, 404, 409, 422, 503 — telle que le front
 *   l'attend.
 *
 * L'isolation inter-tenant proprement dite vit dans
 * `payments-tenant.isolation-spec.ts`.
 */

const ROUTE = (slug: string): string => `/api/v1/public/${slug}/payments/intents`;

describe('Paiement — intention de paiement d’un rendez-vous', () => {
  let harness: PaymentsHarness;

  beforeEach(async () => {
    harness = await createPaymentsHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<PaymentsHarness['server']> => harness.server();

  const seedAppointment = (input: { status?: string; amountMinor?: number } = {}): string =>
    harness.repository.seedAppointment({
      tenantId: harness.tenantId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }),
    }).id;

  describe('le cas passant', () => {
    it('ouvre le paiement et rend de quoi monter Stripe Elements', async () => {
      const appointmentId = seedAppointment({ amountMinor: 7000 });

      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(201);

      expect(response.body).toMatchObject({
        appointmentId,
        amount: { amountMinor: 7000, currency: 'EUR' },
        status: 'PENDING',
        publishableKey: TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY,
      });
      expect(response.body.clientSecret).toContain('_secret_');
      expect(response.body.paymentId).toEqual(expect.any(String));
    });

    it('ne rend ni `tenantId`, ni clé secrète, ni la moindre notion de carte', async () => {
      const appointmentId = seedAppointment();

      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(201);

      const serialised = JSON.stringify(response.body);
      // `tenantId` est une information interne : l'exposer n'apporte rien au
      // consommateur et invite aux essais (tenant-isolation §4).
      expect(serialised).not.toContain(harness.tenantId);
      expect(serialised).not.toContain(TEST_STRIPE_ENV.STRIPE_SECRET_KEY);
      expect(Object.keys(response.body).sort()).toEqual([
        'amount',
        'appointmentId',
        'clientSecret',
        'paymentId',
        'publishableKey',
        'status',
      ]);
    });

    it('rend deux fois la même intention — un double clic ne double pas le débit', async () => {
      const appointmentId = seedAppointment();

      const first = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(201);
      const second = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(201);

      expect(second.body.paymentId).toBe(first.body.paymentId);
      expect(harness.repository.allPayments()).toHaveLength(1);
      expect(harness.stripe.commands).toHaveLength(1);
    });
  });

  describe('le corps de la requête, et ce qu’il ne peut pas porter', () => {
    it('refuse un corps vide en nommant le champ manquant', async () => {
      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.anything() });
      expect(JSON.stringify(response.body)).toContain('appointmentId');
    });

    it('refuse un identifiant qui n’est pas un UUID', async () => {
      // Un identifiant mal formé est un 400 qui nomme le champ, jamais une
      // requête qui descend jusqu'au pilote PostgreSQL pour en revenir en 500.
      await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId: 'pas-un-uuid' })
        .expect(400);
    });

    it('refuse un montant imposé par l’appelant', async () => {
      // Le montant est le prix figé à la réservation. `forbidNonWhitelisted`
      // rejette la requête plutôt que d'ignorer le champ en silence : ignorer
      // aurait laissé croire au front que son montant avait été pris en compte.
      const appointmentId = seedAppointment({ amountMinor: 7000 });

      await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId, amountMinor: 1 })
        .expect(400);

      expect(harness.stripe.commands).toHaveLength(0);
    });

    it('refuse un `tenantId` glissé dans le corps', async () => {
      // Le scénario de fuite le plus direct : le tenant vient du slug d'URL
      // résolu par le middleware, et de nulle part ailleurs.
      await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId: randomUUID(), tenantId: harness.otherTenantId })
        .expect(400);
    });

    it.each([
      ['numéro de carte', { cardNumber: '4242424242424242' }],
      ['cryptogramme', { cvc: '123' }],
      ['expiration', { expMonth: 12, expYear: 2030 }],
      ['piste magnétique', { track2: ';4242424242424242=30121010000012345678?' }],
    ])('refuse un corps porteur d’un %s', async (_label, extra) => {
      // Le quatrième critère de #57 : aucun PAN, CVC ou piste magnétique ne
      // transite par notre API. La requête est rejetée par le pipe global, donc
      // avant tout code métier et avant tout journal applicatif.
      const appointmentId = seedAppointment();

      await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId, ...extra })
        .expect(400);

      expect(harness.repository.allPayments()).toHaveLength(0);
      expect(harness.stripe.commands).toHaveLength(0);
    });
  });

  describe('les refus métier', () => {
    it('rend 404 pour un rendez-vous inconnu', async () => {
      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId: randomUUID() })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('rend 404 pour un établissement inconnu, sans qu’aucun code métier ne tourne', async () => {
      await request(server())
        .post(ROUTE('salon-qui-nexiste-pas'))
        .send({ appointmentId: randomUUID() })
        .expect(404);
    });

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])('rend 422 pour un rendez-vous %s', async (status) => {
      const appointmentId = seedAppointment({ status });

      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(422);

      expect(response.body).toMatchObject({
        code: 'APPOINTMENT_NOT_PAYABLE',
        details: { status },
      });
    });

    it('rend 409 quand le rendez-vous est déjà encaissé', async () => {
      const appointmentId = seedAppointment();
      harness.repository.seedPayment({
        tenantId: harness.tenantId,
        appointmentId,
        status: 'SUCCEEDED',
      });

      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(409);

      expect(response.body.code).toBe('PAYMENT_ALREADY_SETTLED');
    });

    it('rend 503 quand le prestataire refuse, sans rien dire de lui', async () => {
      const appointmentId = seedAppointment();
      harness.stripe.failWith = new PaymentProviderUnavailableError();

      const response = await request(server())
        .post(ROUTE(harness.tenantSlug))
        .send({ appointmentId })
        .expect(503);

      // 503 et non 500 : la conduite du front est de retenter. Et le corps ne
      // porte aucun détail du prestataire.
      expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      expect(response.body.details).toEqual({});
      // Rien n'a été inscrit : une ligne `payments` sans intention serait un
      // encaissement fantôme qui bloquerait toute reprise.
      expect(harness.repository.allPayments()).toHaveLength(0);
    });
  });

  describe('un déploiement sans clés Stripe', () => {
    it('démarre, et refuse chaque encaissement en 503', async () => {
      // La borne d'api-module §7 est le **déploiement** : en `test` et en
      // `development`, l'absence complète de clés laisse l'application monter —
      // sans quoi toutes les suites d'intégration du dépôt, y compris celles
      // qui ne parlent que de créneaux, auraient exigé une variable Stripe.
      // Le refus est alors explicite, et par requête.
      const unconfigured = await createPaymentsHarness({ withoutStripeKeys: true });

      try {
        const appointmentId = unconfigured.repository.seedAppointment({
          tenantId: unconfigured.tenantId,
        }).id;

        const response = await request(unconfigured.server())
          .post(ROUTE(unconfigured.tenantSlug))
          .send({ appointmentId })
          .expect(503);

        expect(response.body.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      } finally {
        await unconfigured.close();
      }
    });
  });
});
