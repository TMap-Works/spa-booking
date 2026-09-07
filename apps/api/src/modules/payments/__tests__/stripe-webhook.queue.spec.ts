import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { DurableWebhookQueue } from '../stripe-webhook.queue';
import type { StripeWebhookRepository } from '../stripe-webhook.repository';
import type { StripeWebhookService } from '../stripe-webhook.service';
import type { StripeWebhookEvent } from '../stripe-webhook.types';
import type { RetrySchedule, SweepSchedule } from '../webhook-retry.policy';
import { FakeStripeWebhookRepository, recordingLogger } from './webhook.doubles';

/**
 * La file durable — ce qu'elle garantit maintenant, et ce qu'elle ne garantit
 * toujours pas (#409).
 *
 * Elle existe pour rendre 200 à Stripe **avant** d'avoir traité
 * (payments-stripe §3). C'était déjà le cas de la file en mémoire qu'elle
 * remplace ; ce qui change est ce que ce 200 **engage**. Avant, il partait quoi
 * qu'il arrive et emportait l'événement avec lui — Stripe ne redélivre que ce
 * qu'il a vu échouer. Maintenant, il ne part qu'une fois la livraison inscrite
 * en base.
 *
 * Les quatre critères du ticket sont exercés ici, un par `describe` :
 * l'inscription avant l'accusé, le réessai borné, la file d'attente morte avec
 * son alerte, et la sérialisation par encaissement. La reprise après un arrêt
 * brutal l'est aussi — c'est `sweepOnce`, et c'est la seule façon d'observer
 * qu'un processus tué ne perd rien.
 *
 * Le dépôt est doublé, la file et le contexte de tenant sont réels : ce qui est
 * mesuré est l'ordonnancement, pas Prisma. Ce que le double ne peut pas
 * montrer — que l'`UPDATE` conditionnel de la prise départage deux instances —
 * se prouve contre un vrai moteur, dans `test/payments-webhook.isolation-spec.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

/** Trois tentatives, aucune attente : la borne s'observe sans faire patienter la suite. */
const IMMEDIATE_RETRY: RetrySchedule = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };

/** Un bail nul : toute livraison non tenue à l'instant même est reprenable. */
const IMMEDIATE_SWEEP: SweepSchedule = { intervalMs: 60_000, leaseMs: 0, batchSize: 10 };

function eventOf(eventId: string, paymentIntentId = 'pi_1'): StripeWebhookEvent {
  return {
    eventId,
    eventType: 'payment_intent.succeeded',
    tenantHint: TENANT,
    fact: { kind: 'payment-succeeded', paymentIntentId, chargeId: null },
  };
}

interface Assembled {
  readonly queue: DurableWebhookQueue;
  readonly repository: FakeStripeWebhookRepository;
  readonly log: ReturnType<typeof recordingLogger>;
  readonly process: jest.Mock;
}

/**
 * La file, son dépôt doublé et son journal — assemblés comme le module les
 * assemble, calendriers instantanés mis à part.
 *
 * `resolveTenant` est celui du vrai service dans son intention — la base
 * d'abord, la métadonnée ensuite — mais réduit à ce que ces cas ont besoin
 * d'observer : un établissement, ou son absence.
 */
function assemble(options: { tenantId?: string | null; retry?: RetrySchedule } = {}): Assembled {
  const repository = new FakeStripeWebhookRepository();
  const log = recordingLogger();
  const process = jest.fn().mockResolvedValue(undefined);
  const service = {
    process,
    resolveTenant: jest.fn().mockResolvedValue(options.tenantId === undefined ? TENANT : options.tenantId),
  } as unknown as StripeWebhookService;

  const queue = new DurableWebhookQueue(
    service,
    repository as unknown as StripeWebhookRepository,
    new TenantContextService(),
    log.logger,
    options.retry ?? IMMEDIATE_RETRY,
    IMMEDIATE_SWEEP,
  );

  return { queue, repository, log, process };
}

describe('DurableWebhookQueue', () => {
  describe('l’inscription précède l’accusé', () => {
    it('inscrit la livraison avant de rendre la main, sans avoir traité', async () => {
      // Les deux moitiés de la propriété centrale du ticket, dans le même cas :
      // quand `enqueue` revient, la livraison est **sur disque** — donc elle
      // survivra au processus — et le traitement n'a **pas** commencé — donc le
      // 200 ne l'attend pas.
      const { queue, repository, process } = assemble();

      await queue.enqueue(eventOf('evt_1'));

      expect(repository.deliveries.size).toBe(1);
      expect(process).not.toHaveBeenCalled();

      await queue.whenIdle();
    });

    it('rejette quand la livraison n’a pas pu être inscrite', async () => {
      // Le contrat inversé par #409. Un contrôleur qui acquitterait malgré cet
      // échec rendrait 200 sur un événement que plus personne ne détient : la
      // route doit rendre 500, pour que Stripe redélivre.
      const { queue, repository } = assemble();
      jest.spyOn(repository, 'spool').mockRejectedValue(new Error('base injoignable'));

      await expect(queue.enqueue(eventOf('evt_1'))).rejects.toThrow('base injoignable');
    });

    it('acquitte sans inscrire un événement qu’aucun établissement ne revendique', async () => {
      // Aucune ligne `payments`, aucune métadonnée : la règle multi-tenant ne
      // lui laisse aucune place où être conservé. Rendre un non-2xx ferait
      // redélivrer trois jours durant un événement qui ne nous concerne pas.
      const { queue, repository, log, process } = assemble({ tenantId: null });

      await queue.enqueue(eventOf('evt_1'));

      expect(repository.deliveries.size).toBe(0);
      expect(process).not.toHaveBeenCalled();
      expect(log.warnings).toContain(
        'stripe webhook: établissement non résolu, livraison non inscrite',
      );
    });

    it('n’inscrit pas un second travail pour une redélivrance', async () => {
      // L'unique `(tenant_id, event_id)` tranche : Stripe a redélivré pendant
      // que la première attendait, et la première chaîne aboutira pour les deux.
      const { queue, repository, process } = assemble();

      await queue.enqueue(eventOf('evt_1'));
      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(process).toHaveBeenCalledTimes(1);
      expect(repository.deliveries.size).toBe(0);
    });

    it('retire la livraison de la file une fois appliquée', async () => {
      // La preuve que le travail a eu lieu est la ligne de
      // `processed_webhook_events` ; garder ici un second enregistrement ferait
      // grossir une table de file pour redire ce qu'un journal dit déjà.
      const { queue, repository } = assemble();

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(repository.deliveries.size).toBe(0);
    });
  });

  describe('réessai borné', () => {
    it('réessaie un traitement en échec, puis aboutit', async () => {
      const { queue, repository, process, log } = assemble();
      process.mockRejectedValueOnce(new Error('interblocage')).mockResolvedValue(undefined);

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(process).toHaveBeenCalledTimes(2);
      expect(repository.deliveries.size).toBe(0);
      expect(log.warnings).toContain('stripe webhook: traitement en échec, réessai programmé');
    });

    it('ne dépasse jamais le nombre de tentatives du calendrier', async () => {
      const { queue, process } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(process).toHaveBeenCalledTimes(IMMEDIATE_RETRY.maxAttempts);
    });

    it('reprend le compteur là où une livraison reprise l’avait laissé', async () => {
      // La reprise ne remet pas le compteur à zéro : sans cela, une livraison
      // qui échoue durablement rebondirait indéfiniment entre le balayage et le
      // réessai, sans jamais atteindre la file d'attente morte.
      const { queue, repository, process } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));
      repository.deliveries.set('presque-morte', {
        id: 'presque-morte',
        tenantId: TENANT,
        serializationKey: 'pi_1',
        event: eventOf('evt_repris'),
        attempts: IMMEDIATE_RETRY.maxAttempts - 1,
        status: 'PENDING',
        claimedAt: null,
        nextAttemptAt: new Date(0),
        lastError: 'Error: base injoignable',
      });

      await queue.sweepOnce();
      await queue.whenIdle();

      // Une seule tentative de plus, et la borne est franchie.
      expect(process).toHaveBeenCalledTimes(1);
      expect(repository.deliveries.get('presque-morte')).toMatchObject({
        status: 'DEAD',
        attempts: IMMEDIATE_RETRY.maxAttempts,
      });
    });

    it('rend la main sans boucler quand la replanification elle-même échoue', async () => {
      // La base est probablement la cause de la panne d'origine. La ligne garde
      // son état, son bail vieillit, et le balayage la reprendra — c'est le
      // filet que cette file existe pour tendre.
      const { queue, repository, process } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));
      jest.spyOn(repository, 'rescheduleDelivery').mockRejectedValue(new Error('toujours rien'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(process).toHaveBeenCalledTimes(1);
      expect([...repository.deliveries.values()][0]).toMatchObject({ status: 'PENDING' });
    });
  });

  describe('file d’attente morte et alerte', () => {
    it('enterre la livraison et alerte après épuisement des réessais', async () => {
      const { queue, repository, process, log } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect([...repository.deliveries.values()][0]).toMatchObject({
        status: 'DEAD',
        lastError: 'Error: base injoignable',
        claimedAt: null,
      });
      expect(log.errors).toContain(
        'stripe webhook: livraison abandonnée après épuisement des réessais — intervention humaine requise',
      );
    });

    it('nomme dans l’alerte de quoi agir sans ouvrir le code', async () => {
      // L'alerte **est** la chaîne d'alerte du MVP : un journal `error` que
      // CloudWatch déclenche. Elle porte des identifiants opaques et un
      // établissement — aucune donnée personnelle, aucune donnée de carte.
      const { queue, process, log } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect(log.entries.at(-1)?.meta).toMatchObject({
        eventId: 'evt_1',
        eventType: 'payment_intent.succeeded',
        tenantId: TENANT,
        attempts: IMMEDIATE_RETRY.maxAttempts,
        error: 'Error: base injoignable',
      });
    });

    it('laisse la livraison reprenable si la mise en file d’attente morte échoue', async () => {
      const { queue, repository, process, log } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));
      jest.spyOn(repository, 'deadLetterDelivery').mockRejectedValue(new Error('toujours rien'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      expect([...repository.deliveries.values()][0]).toMatchObject({ status: 'PENDING' });
      expect(log.warnings).toContain(
        'stripe webhook: mise en file d’attente morte impossible, livraison laissée reprenable',
      );
    });

    it('remet au travail une livraison enterrée quand Stripe la redélivre', async () => {
      // L'alerte d'abandon appelle un seul geste : renvoyer l'événement depuis
      // le tableau de bord Stripe une fois l'incident tranché. Avaler ce renvoi
      // comme un rejeu — c'est ce que ferait l'unique `(tenant, event)` laissé
      // à lui-même — laisserait l'encaissement `PENDING` pour de bon, et
      // l'alerte demanderait une action qu'aucun chemin n'exécute.
      const { queue, repository, process } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));

      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();
      expect([...repository.deliveries.values()][0]).toMatchObject({ status: 'DEAD' });

      process.mockResolvedValue(undefined);
      await queue.enqueue(eventOf('evt_1'));
      await queue.whenIdle();

      // Reprise, appliquée, puis retirée de la file : la ligne morte a servi.
      expect(repository.deliveries.size).toBe(0);
    });

    it('ne propage jamais l’échec vers l’appelant', async () => {
      // La méthode s'exécute sans appelant : une promesse rejetée sans
      // gestionnaire abattrait le processus, et perdrait tout ce que la file
      // est là pour ne pas perdre.
      const { queue, process } = assemble();
      process.mockRejectedValue(new Error('base injoignable'));

      await queue.enqueue(eventOf('evt_1'));
      await expect(queue.whenIdle()).resolves.toBeUndefined();
    });
  });

  describe('reprise après un arrêt brutal', () => {
    it('reprend une livraison que plus personne ne tient', async () => {
      // Le troisième critère du ticket. La livraison est inscrite, le processus
      // meurt avant de la traiter : c'est exactement l'état que laisse un
      // `SIGKILL`, et une autre instance — ou la même à son retour — la reprend
      // sans avoir à savoir qu'une instance est morte.
      const { queue, repository, process } = assemble();
      repository.deliveries.set('orpheline', {
        id: 'orpheline',
        tenantId: TENANT,
        serializationKey: 'pi_1',
        event: eventOf('evt_perdu'),
        attempts: 0,
        status: 'PENDING',
        claimedAt: null,
        nextAttemptAt: new Date(0),
        lastError: null,
      });

      await queue.sweepOnce();
      await queue.whenIdle();

      expect(process).toHaveBeenCalledTimes(1);
      expect(repository.deliveries.size).toBe(0);
    });

    it('ne reprend pas une livraison déjà enterrée', async () => {
      const { queue, repository, process } = assemble();
      repository.deliveries.set('morte', {
        id: 'morte',
        tenantId: TENANT,
        serializationKey: 'pi_1',
        event: eventOf('evt_mort'),
        attempts: 3,
        status: 'DEAD',
        claimedAt: null,
        nextAttemptAt: new Date(0),
        lastError: 'Error: base injoignable',
      });

      await queue.sweepOnce();
      await queue.whenIdle();

      expect(process).not.toHaveBeenCalled();
    });

    it('survit à une base injoignable au moment du balayage', async () => {
      // Le tour s'exécute sur un minuteur, sans appelant. Une base momentanément
      // muette n'est pas un incident : le tour suivant reprendra ce que
      // celui-ci n'a pas vu.
      const { queue, repository, log } = assemble();
      jest
        .spyOn(repository, 'claimAbandonedDeliveries')
        .mockRejectedValue(new Error('base injoignable'));

      await expect(queue.sweepOnce()).resolves.toBeUndefined();
      expect(log.warnings).toContain('stripe webhook: balayage de reprise indisponible');
    });

    it('ne balaie plus une fois l’arrêt commencé', async () => {
      const { queue, repository } = assemble();
      const claim = jest.spyOn(repository, 'claimAbandonedDeliveries');

      await queue.onApplicationShutdown();
      await queue.sweepOnce();

      expect(claim).not.toHaveBeenCalled();
    });
  });

  describe('sérialisation par encaissement', () => {
    it('chaîne deux livraisons du même encaissement', async () => {
      // Le second constat du ticket, tranché. Avant, `enqueue` éventaillait :
      // deux événements portant sur le même `pi_…` pouvaient s'appliquer en
      // parallèle, et l'ordre n'était pas garanti.
      const running: string[] = [];
      const finished: string[] = [];
      const { queue, process } = assemble();
      process.mockImplementation(async (event: StripeWebhookEvent) => {
        running.push(event.eventId);
        await new Promise<void>((resolve) => setImmediate(resolve));
        finished.push(event.eventId);
      });

      await queue.enqueue(eventOf('evt_1', 'pi_1'));
      await queue.enqueue(eventOf('evt_2', 'pi_1'));
      await queue.whenIdle();

      // Chaque traitement s'achève avant que le suivant ne commence.
      expect(running).toEqual(['evt_1', 'evt_2']);
      expect(finished).toEqual(['evt_1', 'evt_2']);
    });

    it('laisse deux encaissements distincts avancer de front', async () => {
      // Rien ne justifierait de faire attendre la seconde : les deux livraisons
      // ne se disputent aucune ligne.
      const started: string[] = [];
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const { queue, process } = assemble();
      process.mockImplementation(async (event: StripeWebhookEvent) => {
        started.push(event.eventId);
        await held;
      });

      await queue.enqueue(eventOf('evt_1', 'pi_1'));
      await queue.enqueue(eventOf('evt_2', 'pi_2'));
      // Laisse les deux `setImmediate` s'exécuter : les deux traitements sont
      // alors entrés, alors qu'aucun n'est sorti.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(started).toEqual(['evt_1', 'evt_2']);

      release();
      await queue.whenIdle();
    });

    it('ne retient pas une chaîne dont la dernière livraison est finie', async () => {
      // Sans ce ménage, la table des chaînes grossirait d'une entrée par
      // encaissement vu, pour la vie du processus.
      const { queue } = assemble();

      await queue.enqueue(eventOf('evt_1', 'pi_1'));
      await queue.whenIdle();

      expect((Reflect.get(queue, 'chains') as Map<string, unknown>).size).toBe(0);
    });
  });

  describe('cycle de vie du conteneur', () => {
    it('attend les traitements en vol à l’arrêt', async () => {
      // `SIGTERM` d'ECS → `onApplicationShutdown`. Un déploiement ordinaire ne
      // laisse donc rien derrière lui, et ce qu'il laisserait tout de même est
      // repris par le balayage.
      let release = (): void => undefined;
      const finished = jest.fn();
      const { queue, process } = assemble();
      process.mockImplementation(
        async () =>
          new Promise<void>((resolve) => {
            release = () => {
              finished();
              resolve();
            };
          }),
      );

      await queue.enqueue(eventOf('evt_1'));
      const shutdown = queue.onApplicationShutdown();
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await shutdown;

      expect(finished).toHaveBeenCalled();
    });

    it('arme puis désarme le balayage périodique', async () => {
      const { queue } = assemble();

      queue.onApplicationBootstrap();
      expect(Reflect.get(queue, 'sweeper')).not.toBeNull();

      await queue.onApplicationShutdown();
      expect(Reflect.get(queue, 'sweeper')).toBeNull();
    });

    it('se déclare inactive quand rien n’a été mis en file', async () => {
      const { queue } = assemble();

      await expect(queue.whenIdle()).resolves.toBeUndefined();
    });
  });
});
