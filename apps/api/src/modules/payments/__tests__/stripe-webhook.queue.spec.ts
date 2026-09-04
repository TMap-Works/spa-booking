import { InProcessWebhookQueue } from '../stripe-webhook.queue';
import type { StripeWebhookService } from '../stripe-webhook.service';
import type { StripeWebhookEvent } from '../stripe-webhook.types';
import { recordingLogger } from './webhook.doubles';

/**
 * La file en mémoire — ce qu'elle garantit, et ce qu'elle ne garantit pas.
 *
 * Elle existe pour une seule raison : rendre 200 à Stripe **avant** d'avoir
 * traité (payments-stripe §3). Trois propriétés en découlent, et ce sont
 * exactement celles qu'on éprouve ici — le traitement est différé, il n'échoue
 * jamais vers l'appelant, et l'arrêt du conteneur l'attend.
 */

const EVENT: StripeWebhookEvent = {
  eventId: 'evt_1',
  eventType: 'payment_intent.succeeded',
  tenantHint: 'tenant-a',
  fact: { kind: 'payment-succeeded', paymentIntentId: 'pi_1', chargeId: null },
};

function serviceDouble(process: jest.Mock): StripeWebhookService {
  return { process } as unknown as StripeWebhookService;
}

describe('InProcessWebhookQueue', () => {
  it('ne traite rien avant d’avoir rendu la main', () => {
    // Le point de toute la file : `enqueue` revient immédiatement, la réponse
    // HTTP part, et le traitement commence après.
    const process = jest.fn().mockResolvedValue(undefined);
    const queue = new InProcessWebhookQueue(serviceDouble(process), recordingLogger().logger);

    queue.enqueue(EVENT);

    expect(process).not.toHaveBeenCalled();
  });

  it('traite ce qui a été mis en file, dans l’ordre', async () => {
    const seen: string[] = [];
    const process = jest.fn(async (event: StripeWebhookEvent) => {
      seen.push(event.eventId);
    });
    const queue = new InProcessWebhookQueue(serviceDouble(process), recordingLogger().logger);

    queue.enqueue(EVENT);
    queue.enqueue({ ...EVENT, eventId: 'evt_2' });
    await queue.whenIdle();

    expect(seen).toEqual(['evt_1', 'evt_2']);
  });

  it('journalise un échec sans jamais le propager', async () => {
    // Le contrôleur a déjà répondu : une promesse rejetée sans gestionnaire
    // abattrait le processus. Ce que le journal enregistre alors est une
    // **alerte**, et non une trace — le 200 étant parti, Stripe ne rejouera
    // pas, et seul un renvoi manuel rattrapera l'événement.
    const log = recordingLogger();
    const process = jest.fn().mockRejectedValue(new Error('base injoignable'));
    const queue = new InProcessWebhookQueue(serviceDouble(process), log.logger);

    queue.enqueue(EVENT);
    await expect(queue.whenIdle()).resolves.toBeUndefined();

    expect(log.errors).toEqual(['stripe webhook: traitement en échec']);
    expect(log.entries.at(-1)?.meta).toMatchObject({
      eventId: 'evt_1',
      error: 'Error: base injoignable',
    });
  });

  it('attend les traitements en vol à l’arrêt du conteneur', async () => {
    // `SIGTERM` d'ECS → `onApplicationShutdown`. Sans cette attente, un
    // déploiement annulerait les transactions en cours : correct grâce à
    // l'idempotence, mais bruyant et lent.
    let release = (): void => undefined;
    const finished = jest.fn();
    const process = jest.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished();
            resolve();
          };
        }),
    );
    const queue = new InProcessWebhookQueue(serviceDouble(process), recordingLogger().logger);

    queue.enqueue(EVENT);
    const shutdown = queue.onApplicationShutdown();
    // Laisse le `setImmediate` de la file s'exécuter avant de libérer.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await shutdown;

    expect(finished).toHaveBeenCalled();
  });

  it('se déclare inactive quand rien n’a été mis en file', async () => {
    const queue = new InProcessWebhookQueue(
      serviceDouble(jest.fn()),
      recordingLogger().logger,
    );

    await expect(queue.whenIdle()).resolves.toBeUndefined();
  });
});
