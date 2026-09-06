import { NotificationDispatchService } from '../notification-dispatch.service';
import {
  appointmentDedupeKey,
  type NotificationMessage,
  type NotificationType,
} from '../notifications.types';
import {
  countingSender,
  fakeNotificationsRepository,
  recordingLogger,
  type SendBehaviour,
} from './notifications.doubles';

/**
 * L'ordre d'écriture et l'idempotence des envois — #68, notifications §2.
 *
 * Ce que cette suite mesure tient en un chiffre : **le nombre d'appels à
 * l'expéditeur**. C'est le seul effet irréversible de la chaîne — une fois le
 * SMS parti, aucune écriture en base ne le rappelle — et c'est donc le seul
 * endroit où l'idempotence se constate vraiment. Compter les lignes en base
 * dirait ce que la base a enregistré, pas ce que la cliente a reçu.
 *
 * Le double de dépôt rejoue les deux uniques de la table, sans quoi le comptage
 * serait tautologique : un double complaisant ferait passer le test quelle que
 * soit la conduite du service.
 */

const APPOINTMENT_ID = 'appointment-1';
const RECIPIENT_ID = 'user-1';

function message(
  type: NotificationType = 'REMINDER_24H',
  overrides: Partial<NotificationMessage> = {},
): NotificationMessage {
  const channel = overrides.channel ?? 'SMS';
  const appointmentId = overrides.appointmentId ?? APPOINTMENT_ID;

  return {
    dedupeKey: appointmentDedupeKey(appointmentId, type, channel),
    appointmentId,
    recipientUserId: RECIPIENT_ID,
    type,
    channel,
    scheduledFor: null,
    ...overrides,
  };
}

function build(behaviour: readonly SendBehaviour[] = []) {
  const repository = fakeNotificationsRepository();
  const sender = countingSender(behaviour);
  const logger = recordingLogger();

  return {
    repository,
    sender,
    logger,
    service: new NotificationDispatchService(repository.repository, sender.sender, logger.logger),
  };
}

describe("notifications — l'ordre d'écriture", () => {
  it('inscrit la ligne en `PENDING` avant d’appeler le fournisseur', async () => {
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const statusesAtSendTime: string[] = [];

    // L'expéditeur observe la table au moment précis où on l'appelle. C'est la
    // seule façon de prouver l'ordre : après coup, `SENT` ne dit pas si la ligne
    // existait avant l'appel ou seulement après.
    const sender = {
      send: (): Promise<{ providerMessageId: string }> => {
        statusesAtSendTime.push(...repository.rows.map((row) => row.status));
        return Promise.resolve({ providerMessageId: 'ses-1' });
      },
    };

    const service = new NotificationDispatchService(
      repository.repository,
      sender,
      logger.logger,
    );

    await expect(service.dispatch(message())).resolves.toBe('sent');

    expect(statusesAtSendTime).toEqual(['PENDING']);
  });

  it('passe la ligne à `SENT` avec l’accusé du fournisseur, et pas avant', async () => {
    const { service, repository, sender } = build(['ses-abc123']);

    await expect(service.dispatch(message())).resolves.toBe('sent');

    expect(sender.calls).toHaveLength(1);
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      status: 'SENT',
      providerMessageId: 'ses-abc123',
      attemptCount: 1,
    });
  });

  it("ne transmet aucune coordonnée à l'expéditeur — un compte, pas une adresse", async () => {
    // CDC §5.1 et notifications §7 : l'adresse se relit sur le compte au moment
    // de l'envoi. Si elle transitait par ici, elle finirait dans un message de
    // file et dans un journal.
    const { service, sender } = build();

    await service.dispatch(message());

    expect(sender.calls[0]).toEqual({
      notificationId: 'notification-1',
      type: 'REMINDER_24H',
      channel: 'SMS',
      recipientUserId: RECIPIENT_ID,
      appointmentId: APPOINTMENT_ID,
    });
  });
});

describe("notifications — le rejeu d'un message SQS", () => {
  it('rejoué deux fois, le même message ne produit qu’un seul envoi', async () => {
    // Le quatrième critère d'acceptation de #68, et la raison d'être du module :
    // SQS garantit au-moins-une-fois, jamais exactement-une-fois.
    const { service, repository, sender } = build();
    const sqsMessage = message();

    await expect(service.dispatch(sqsMessage)).resolves.toBe('sent');
    await expect(service.dispatch(sqsMessage)).resolves.toBe('skipped');

    expect(sender.calls).toHaveLength(1);
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({ status: 'SENT', attemptCount: 1 });
  });

  it('rejoué dix fois, il n’en produit toujours qu’un', async () => {
    const { service, sender } = build();
    const sqsMessage = message();

    const outcomes = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      outcomes.push(await service.dispatch(sqsMessage));
    }

    expect(outcomes).toEqual(['sent', ...Array<string>(9).fill('skipped')]);
    expect(sender.calls).toHaveLength(1);
  });

  it('ignore aussi le rejeu d’un message composé avec une autre clé de déduplication', async () => {
    // Deux producteurs qui ne se coordonnent pas — l'événement de domaine et le
    // balayage horaire — composeraient deux `dedupe_key` différentes pour un
    // même rappel. C'est `notifications_live_once` qui les sérialise, et lui
    // seul : l'unique sur la clé de livraison laisserait passer les deux.
    const { service, sender } = build();

    await expect(service.dispatch(message())).resolves.toBe('sent');
    await expect(
      service.dispatch(message('REMINDER_24H', { dedupeKey: 'sweep:2026-09-06T10:00Z:sms' })),
    ).resolves.toBe('skipped');

    expect(sender.calls).toHaveLength(1);
  });

  it('n’ignore pas ce qui n’est pas un doublon — autre canal, autre type, autre rendez-vous', async () => {
    // La borne symétrique : un index trop large étoufferait des messages
    // légitimes, et le test du rejeu passerait quand même.
    const { service, sender } = build();

    await service.dispatch(message('REMINDER_24H', { channel: 'SMS' }));
    await service.dispatch(message('REMINDER_24H', { channel: 'EMAIL' }));
    await service.dispatch(message('BOOKING_CONFIRMATION', { channel: 'SMS' }));
    await service.dispatch(message('REMINDER_24H', { appointmentId: 'appointment-2' }));

    expect(sender.calls).toHaveLength(4);
  });
});

describe("notifications — l'échec d'expédition", () => {
  it('inscrit `FAILED` puis relève, pour que SQS reprenne la main', async () => {
    // Aucune reprise maison : le backoff est celui de la file (notifications §4).
    const panne = new Error('SES throttling');
    const { service, repository } = build([panne]);

    await expect(service.dispatch(message())).rejects.toThrow(panne);

    expect(repository.rows[0]).toMatchObject({
      status: 'FAILED',
      failureReason: 'SES throttling',
      providerMessageId: null,
    });
  });

  it('rend la place : le rejeu qui suit un échec envoie pour de bon', async () => {
    // C'est tout l'intérêt du filtre partiel de l'index. Si `FAILED` occupait la
    // place, un throttling passager condamnerait le rappel pour de bon.
    const { service, repository, sender } = build([new Error('SES throttling')]);
    const sqsMessage = message();

    await expect(service.dispatch(sqsMessage)).rejects.toThrow('SES throttling');
    await expect(service.dispatch(sqsMessage)).resolves.toBe('sent');

    expect(sender.calls).toHaveLength(2);
    // Une seule ligne, et son compteur de tentatives porte les deux essais : la
    // reprise est une transition, jamais une seconde insertion.
    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      status: 'SENT',
      attemptCount: 2,
      failureReason: null,
    });
  });

  it('n’inscrit pas de pile ni de charge utile en base — le message, et rien d’autre', async () => {
    // `failure_reason` est relu par un humain qui diagnostique, et une erreur de
    // pilote AWS porte volontiers l'adresse du destinataire dans sa charge utile.
    const { service, repository } = build([{ reject: { destinataire: 'x@y.z' } }]);

    await expect(service.dispatch(message())).rejects.toBeDefined();

    expect(repository.rows[0]?.failureReason).toBe('erreur non standard (object)');
  });

  it('tronque un motif d’échec plus long que la colonne', async () => {
    const { service, repository } = build([new Error('x'.repeat(900))]);

    await expect(service.dispatch(message())).rejects.toBeDefined();

    expect(repository.rows[0]?.failureReason).toHaveLength(500);
  });
});
