import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import type { FakeStripeWebhookRepository } from '../src/modules/payments/__tests__/webhook.doubles';
import { MAX_WEBHOOK_BODY_BYTES } from '../src/modules/payments/stripe-webhook.raw-body';
import {
  createWebhookHarness,
  eventBody,
  sign,
  WEBHOOK_PATH,
  type WebhookHarness,
} from './payments-webhook.harness';

/**
 * Le webhook Stripe interrogé en HTTP, sur l'application réellement câblée.
 *
 * Ce que cette suite prouve, et qu'aucun test unitaire ne peut prouver :
 *
 * - la route est **servie** — un contrôleur oublié dans les `controllers` de son
 *   module compile, passe ses tests unitaires, et rend 404 en vrai ;
 * - le corps qui parvient au contrôleur est le corps **brut**, donc la route est
 *   bien sortie du parseur JSON global. C'est le seul endroit du dépôt où cette
 *   propriété est observable, et c'est le critère d'acceptation n°1 de #58 ;
 * - une signature invalide s'arrête en **400 sans qu'aucun traitement n'ait
 *   lieu** — la file reste vide ;
 * - la réponse part **avant** le traitement, qui est bien remis à une file.
 *
 * L'idempotence en base et l'isolation inter-tenant se prouvent contre un vrai
 * moteur, dans `payments-webhook.isolation-spec.ts` : un double en mémoire ne
 * peut pas témoigner d'une contrainte d'unicité ni d'une transaction.
 */

const SUCCESS_BODY = eventBody('payment_intent.succeeded', {
  id: 'pi_1',
  latest_charge: 'ch_1',
  metadata: { tenantId: 'tenant-inconnu', appointmentId: 'rdv-1' },
});

describe('Webhook Stripe — API', () => {
  let harness: WebhookHarness;
  let repository: FakeStripeWebhookRepository;

  beforeEach(async () => {
    harness = await createWebhookHarness();
    repository = harness.repository;
    repository.seed({
      tenantId: harness.tenantId,
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  const post = (body: string, signature?: string): request.Test => {
    const call = request(server()).post(WEBHOOK_PATH).set('Content-Type', 'application/json');
    if (signature !== undefined) {
      call.set('Stripe-Signature', signature);
    }
    // `.send(<string>)` transmet la chaîne telle quelle : supertest ne
    // re-sérialise pas, et ce sont donc bien ces octets-là qui sont signés.
    return call.send(body);
  };

  describe('corps brut et signature', () => {
    it('accepte une livraison signée sur les octets exacts', async () => {
      const response = await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);

      expect(response.body).toEqual({ received: true });
    });

    it('refuse une charge dont seule la mise en forme diffère', async () => {
      // La preuve que le corps n'a pas été re-sérialisé en chemin : la signature
      // porte sur une forme, le corps envoyé en porte une autre, et le
      // contrôleur voit la différence. Derrière `express.json()`, ce cas — et le
      // précédent — se comporteraient à l'identique.
      const reformatted = `${SUCCESS_BODY.slice(0, -1)} }`;

      await post(reformatted, sign(SUCCESS_BODY)).expect(400);
    });

    it('refuse une livraison sans en-tête de signature', async () => {
      const response = await post(SUCCESS_BODY).expect(400);

      expect(response.body).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE', details: {} });
    });

    it('refuse une livraison signée avec un autre secret', async () => {
      await post(SUCCESS_BODY, sign(SUCCESS_BODY, { secret: 'whsec_un_autre' })).expect(400);
    });

    it('refuse une livraison trop ancienne, signature valide comprise', async () => {
      const stale = Math.floor(Date.now() / 1000) - 3600;

      await post(SUCCESS_BODY, sign(SUCCESS_BODY, { timestampSeconds: stale })).expect(400);
    });

    it('ne dit jamais pourquoi elle refuse', async () => {
      // Quatre refus de natures différentes, un seul corps de réponse : la
      // différence ne renseignerait que celui qui sonde.
      //
      // Séquentiel, et non `Promise.all` : supertest met le serveur à l'écoute
      // à la première requête, et quatre appels concurrents sur un serveur pas
      // encore lié se coupent la connexion les uns aux autres (`ECONNRESET`).
      // Ce que ce cas mesure n'a rien à voir avec la concurrence.
      const bodies: unknown[] = [];
      for (const signature of [
        undefined,
        'illisible',
        sign(SUCCESS_BODY, { secret: 'whsec_autre' }),
        sign('{}'),
      ]) {
        bodies.push((await post(SUCCESS_BODY, signature).expect(400)).body as unknown);
      }

      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
    });

    it('n’exécute aucun traitement sur une signature refusée', async () => {
      // « Signature invalide : 400 immédiat, aucun traitement » — la propriété
      // la plus importante de cette route.
      await post(SUCCESS_BODY, sign(SUCCESS_BODY, { secret: 'whsec_autre' })).expect(400);
      await harness.drain();

      expect(repository.processed.size).toBe(0);
      expect(repository.payments.get('pi_1')).toMatchObject({ status: 'PENDING' });
    });

    it('refuse un corps qui dépasse la borne du lecteur brut', async () => {
      const oversized = JSON.stringify({ id: 'evt_x', padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) });

      await post(oversized, sign(oversized)).expect(413);
    });
  });

  describe('acquittement et mise en file', () => {
    it('répond 200 pendant que le traitement est encore bloqué', async () => {
      // La preuve que la réponse n'attend pas le traitement : l'application de
      // l'événement est retenue, et le 200 part quand même. « Un webhook qui
      // dépasse le délai est rejoué et amplifie la charge » — c'est ce que la
      // file évite, et c'est ce que ce cas mesure.
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(repository, 'apply').mockImplementation(async () => {
        await held;
        return { outcome: 'applied' as const, paymentsTouched: 1, appointmentsConfirmed: 1 };
      });

      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);

      release();
      await harness.drain();
    });

    it('applique l’événement une fois la file consommée', async () => {
      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);
      await harness.drain();

      expect(repository.payments.get('pi_1')).toMatchObject({
        status: 'SUCCEEDED',
        appointmentStatus: 'CONFIRMED',
      });
    });

    it('acquitte sans traiter un événement hors périmètre', async () => {
      const body = eventBody('customer.subscription.created', { id: 'sub_1' });

      await post(body, sign(body)).expect(200);
      await harness.drain();

      expect(repository.processed.size).toBe(0);
    });

    it('acquitte un corps signé mais illisible plutôt que de boucler', async () => {
      // Signé par Stripe, donc authentique ; illisible, donc sans rejeu utile.
      // Un 4xx ferait rejouer indéfiniment.
      await post('pas du json', sign('pas du json')).expect(200);
    });

    it('fait passer le rendez-vous en CONFIRMED, et lui seul', async () => {
      // « C'est le webhook, et lui seul, qui fait passer le rendez-vous en
      // confirmed » (payments-stripe §2).
      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);
      await harness.drain();

      expect(repository.payments.get('pi_1')?.appointmentStatus).toBe('CONFIRMED');
    });

    it('n’applique un même événement qu’une fois, même rejoué', async () => {
      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);
      await harness.drain();
      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);
      await harness.drain();

      expect(repository.processed.size).toBe(1);
    });

    it('laisse un refus de carte au rendez-vous encore réservable', async () => {
      const failed = eventBody('payment_intent.payment_failed', { id: 'pi_1' }, 'evt_failed');

      await post(failed, sign(failed)).expect(200);
      await harness.drain();

      expect(repository.payments.get('pi_1')).toMatchObject({
        status: 'FAILED',
        // Le créneau reste tenu : la cliente peut présenter une autre carte.
        appointmentStatus: 'PENDING',
      });
    });

    it('enregistre un remboursement partiel comme tel', async () => {
      const refunded = eventBody(
        'charge.refunded',
        { id: 'ch_1', payment_intent: 'pi_1', amount_captured: 7000, amount_refunded: 2000 },
        'evt_refund',
      );

      await post(refunded, sign(refunded)).expect(200);
      await harness.drain();

      expect(repository.payments.get('pi_1')).toMatchObject({
        status: 'PARTIALLY_REFUNDED',
        refundedAmountMinor: 2000,
      });
    });
  });

  describe('surface', () => {
    it('n’est pas servie en GET', async () => {
      await request(server()).get(WEBHOOK_PATH).expect(404);
    });

    it('ne demande aucun jeton — c’est la signature qui authentifie', async () => {
      // Aucun en-tête `Authorization` n'a été posé par cette suite, et pourtant
      // la livraison passe. La contrepartie est que la signature, elle, ne se
      // négocie pas : les cas ci-dessus l'établissent.
      await post(SUCCESS_BODY, sign(SUCCESS_BODY)).expect(200);
    });
  });
});
