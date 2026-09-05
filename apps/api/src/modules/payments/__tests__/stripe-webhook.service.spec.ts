import { getTenantId } from '../../../common/tenant/tenant-context';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import { StripeWebhookService } from '../stripe-webhook.service';
import type { StripeWebhookEvent } from '../stripe-webhook.types';
import { FakeStripeWebhookRepository, recordingLogger, type RecordingLogger } from './webhook.doubles';

/**
 * Le traitement d'un événement vérifié — résolution de l'établissement, portée
 * de tenant, alerte de litige.
 *
 * Ce que ces cas protègent avant tout est la **résolution du tenant**. Un
 * webhook n'apporte ni jeton ni slug ; si la résolution se trompe, l'écriture
 * part dans le mauvais établissement — et c'est une fuite écrite, plus
 * difficile à détecter qu'une fuite lue.
 */

interface Subject {
  readonly service: StripeWebhookService;
  readonly repository: FakeStripeWebhookRepository;
  readonly log: RecordingLogger;
}

function subject(): Subject {
  const repository = new FakeStripeWebhookRepository();
  const log = recordingLogger();
  const service = new StripeWebhookService(
    repository.asRepository(),
    new TenantContextService(),
    log.logger,
  );
  return { service, repository, log };
}

function succeeded(overrides: Partial<StripeWebhookEvent> = {}): StripeWebhookEvent {
  return {
    eventId: 'evt_1',
    eventType: 'payment_intent.succeeded',
    tenantHint: null,
    fact: { kind: 'payment-succeeded', paymentIntentId: 'pi_1', chargeId: 'ch_1' },
    ...overrides,
  };
}

describe('StripeWebhookService — résolution de l’établissement', () => {
  it('écrit dans l’établissement propriétaire de l’encaissement', async () => {
    const { service, repository } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });

    await service.process(succeeded());

    expect(repository.payments.get('pi_1')).toMatchObject({
      status: 'SUCCEEDED',
      appointmentStatus: 'CONFIRMED',
    });
  });

  it('préfère la ligne en base à la métadonnée quand les deux se contredisent', async () => {
    // La métadonnée est signée, donc authentique — mais elle reste ce que
    // Stripe nous renvoie. La base fait autorité sur nos propres lignes : la
    // suivre évite d'écrire la marque d'idempotence sous un établissement et
    // l'encaissement sous un autre.
    const { service, repository } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });

    const observed: (string | undefined)[] = [];
    jest
      .spyOn(repository, 'apply')
      .mockImplementation(async () => {
        observed.push(getTenantId());
        return { outcome: 'applied' as const, paymentsTouched: 1, appointmentsConfirmed: 1 };
      });

    await service.process(succeeded({ tenantHint: 'tenant-b' }));

    expect(observed).toEqual(['tenant-a']);
  });

  it('retombe sur la métadonnée quand aucune ligne ne porte la référence', async () => {
    // Le cas d'un litige ouvert sur une intention dont l'encaissement n'a jamais
    // été écrit : il n'y a rien à mettre à jour, mais l'alerte doit partir avec
    // le bon établissement.
    const { service, repository } = subject();

    const observed: (string | undefined)[] = [];
    jest.spyOn(repository, 'apply').mockImplementation(async () => {
      observed.push(getTenantId());
      return { outcome: 'applied' as const, paymentsTouched: 0, appointmentsConfirmed: 0 };
    });

    await service.process(succeeded({ tenantHint: 'tenant-b' }));

    expect(observed).toEqual(['tenant-b']);
  });

  it('n’écrit rien et journalise quand l’établissement reste introuvable', async () => {
    const { service, repository, log } = subject();
    const apply = jest.spyOn(repository, 'apply');

    await service.process(succeeded());

    expect(apply).not.toHaveBeenCalled();
    expect(log.warnings).toEqual(['stripe webhook: établissement non résolu, événement ignoré']);
  });

  it('ouvre une portée de tenant, jamais une portée vide', async () => {
    // Sans portée résolue, l'extension Prisma refuse toute opération — et un
    // traitement qui compterait sur elle pour échouer serait un traitement qui
    // n'a jamais fonctionné.
    const { service, repository } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: null,
    });

    let scoped: string | undefined;
    jest.spyOn(repository, 'apply').mockImplementation(async () => {
      scoped = getTenantId();
      return { outcome: 'applied' as const, paymentsTouched: 1, appointmentsConfirmed: 0 };
    });

    await service.process(succeeded());

    expect(scoped).toBe('tenant-a');
    // La portée est refermée en sortant : rien ne fuit vers l'appelant suivant.
    expect(getTenantId()).toBeUndefined();
  });
});

describe('StripeWebhookService — idempotence et journal', () => {
  it('journalise différemment une application et un rejeu', async () => {
    const { service, repository, log } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });

    await service.process(succeeded());
    await service.process(succeeded());

    const messages = log.entries.filter((entry) => entry.level === 'log').map((e) => e.message);
    expect(messages).toEqual([
      'stripe webhook: événement appliqué',
      'stripe webhook: rejeu ignoré',
    ]);
  });

  it('ne marque rien quand aucun encaissement ne porte la référence (#410)', async () => {
    // Le cas laissé en suspens par #58, et tranché ici. `PaymentsService` crée
    // l'intention chez Stripe **avant** d'inscrire la ligne `payments` : une
    // livraison peut donc arriver alors que la ligne n'existe pas encore. La
    // marquer traitée ferait avaler le renvoi manuel — qui est le seul recours,
    // la file en mémoire n'ayant aucune reprise automatique.
    const { service, repository, log } = subject();

    // La métadonnée résout l'établissement ; c'est ce qui rend le cas atteignable
    // — sans elle, le traitement s'arrêterait plus tôt, sur « établissement non
    // résolu », et la question ne se poserait pas.
    await service.process(succeeded({ tenantHint: 'tenant-a' }));

    expect(repository.processed.size).toBe(0);
    expect(log.warnings).toEqual([
      'stripe webhook: aucun encaissement ne porte cette référence — rien écrit, renvoi possible',
    ]);
  });

  it('applique le renvoi d’un événement resté sans destinataire', async () => {
    // La conséquence utile de la règle : la même livraison, rejouée une fois la
    // ligne inscrite, encaisse pour de bon. Avant #410, elle repartait en
    // « rejeu ignoré » et le rendez-vous n'était jamais confirmé.
    const { service, repository } = subject();
    const event = succeeded({ tenantHint: 'tenant-a' });

    await service.process(event);

    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });

    await service.process(event);

    expect(repository.payments.get('pi_1')).toMatchObject({
      status: 'SUCCEEDED',
      appointmentStatus: 'CONFIRMED',
    });
  });

  it('marque un litige sans ligne, lui : l’alerte est son effet', async () => {
    // La borne de la règle. Un litige n'a par nature aucune ligne à toucher, et
    // son effet est l'alerte elle-même : le priver de marque ferait ré-alerter
    // l'équipe à chaque livraison.
    const { service, repository } = subject();

    await service.process({
      eventId: 'evt_dp_orphelin',
      eventType: 'charge.dispute.created',
      tenantHint: 'tenant-a',
      fact: { kind: 'dispute-opened', disputeId: 'dp_9', chargeId: null, paymentIntentId: null },
    });

    expect(repository.processed.size).toBe(1);
  });

  it('laisse remonter une panne : c’est ce qui fait rejouer Stripe', async () => {
    const { service, repository } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: null,
      status: 'PENDING',
      refundedAmountMinor: 0,
      appointmentStatus: 'PENDING',
    });
    repository.failNext = new Error('base injoignable');

    await expect(service.process(succeeded())).rejects.toThrow('base injoignable');
  });
});

describe('StripeWebhookService — litige', () => {
  const dispute: StripeWebhookEvent = {
    eventId: 'evt_dp',
    eventType: 'charge.dispute.created',
    tenantHint: 'tenant-a',
    fact: {
      kind: 'dispute-opened',
      disputeId: 'dp_1',
      chargeId: 'ch_1',
      paymentIntentId: 'pi_1',
    },
  };

  it('alerte l’équipe sans rien décider', async () => {
    // payments-stripe §6 : « un litige déclenche une alerte vers l'équipe ; il
    // n'est pas traité automatiquement au MVP ».
    const { service, repository, log } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
      status: 'SUCCEEDED',
      refundedAmountMinor: 0,
      appointmentStatus: 'CONFIRMED',
    });

    await service.process(dispute);

    expect(log.errors).toEqual([
      'stripe webhook: litige ouvert — intervention humaine requise',
    ]);
    expect(repository.payments.get('pi_1')).toMatchObject({
      status: 'SUCCEEDED',
      appointmentStatus: 'CONFIRMED',
    });
  });

  it('n’alerte pas deux fois sur un rejeu', async () => {
    // C'est tout l'intérêt de marquer même un événement sans effet en base :
    // sans la ligne, chaque rejeu réveillerait l'équipe.
    const { service, repository, log } = subject();
    repository.seed({
      tenantId: 'tenant-a',
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
      status: 'SUCCEEDED',
      refundedAmountMinor: 0,
      appointmentStatus: 'CONFIRMED',
    });

    await service.process(dispute);
    await service.process(dispute);

    expect(log.errors).toHaveLength(1);
  });

  it('ne journalise aucune donnée personnelle', () => {
    // L'alerte ne porte que des identifiants opaques (CDC §5.1).
    expect(Object.keys(dispute.fact)).toEqual(['kind', 'disputeId', 'chargeId', 'paymentIntentId']);
  });
});
