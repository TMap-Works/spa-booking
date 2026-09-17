import { StructuredLogger } from '../../../common/logging/structured-logger';
import { NotificationDispatchService } from '../notification-dispatch.service';
import {
  InProcessNotificationPublisher,
  SqsNotificationPublisher,
  notificationPublisherFactory,
  type QueueGateway,
} from '../notification-publisher';
import { NOTIFICATION_QUEUE_URL_ENV, NotificationsConfig } from '../notifications.config';
import type { NotificationMessage } from '../notifications.types';
import {
  countingSender,
  fakeNotificationsRepository,
  recordingLogger,
  stubRenderer,
} from './notifications.doubles';

/**
 * Le port de publication — septième critère d'acceptation de #799 : « l'API
 * publie dans la file au lieu d'expédier en processus ».
 *
 * ## Ce que cette suite établit, et ce qu'elle ne peut pas établir
 *
 * Elle établit le **choix** : quelle implémentation la fabrique monte selon ce
 * que l'environnement fournit, et ce que chacune fait de l'enveloppe. Elle
 * n'établit pas que SQS accepte le message — c'est un fait d'AWS, et aucun test
 * du dépôt n'ouvre de connexion vers lui (notifications §8).
 *
 * Le publieur SQS est donc exercé avec un client bouchonné, et c'est suffisant :
 * ce qui pouvait se tromper ici est la **forme** du corps publié, que la Lambda
 * d'envoi valide champ par champ et rejette en échec permanent.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const QUEUE = 'https://sqs.eu-west-3.amazonaws.com/123456789012/spa-dev-notifications';

function message(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    tenantId: TENANT,
    dedupeKey: 'appointment:22222222-2222-4222-8222-222222222222:BOOKING_CONFIRMATION:EMAIL',
    appointmentId: '22222222-2222-4222-8222-222222222222',
    recipientUserId: '33333333-3333-4333-8333-333333333333',
    type: 'BOOKING_CONFIRMATION',
    channel: 'EMAIL',
    scheduledFor: null,
    ...overrides,
  };
}

/** Une passerelle de file qui enregistre au lieu de publier. */
function recordingQueueGateway(messageId: string | null = 'sqs-1'): {
  readonly gateway: QueueGateway;
  readonly bodies: string[];
} {
  const bodies: string[] = [];

  return {
    bodies,
    gateway: {
      send(body: string): Promise<string | null> {
        bodies.push(body);
        return Promise.resolve(messageId);
      },
    },
  };
}

/** Le publieur SQS, monté sur la passerelle enregistreuse. */
function sqsPublisher(logger: StructuredLogger, messageId: string | null = 'sqs-1') {
  const recorder = recordingQueueGateway(messageId);

  return { publisher: new SqsNotificationPublisher(recorder.gateway, logger), recorder };
}

describe('notifications — la fabrique choisit selon ce que l’environnement fournit', () => {
  it('monte le publieur SQS quand la file est configurée', () => {
    const publisher = notificationPublisherFactory(
      new NotificationsConfig({ [NOTIFICATION_QUEUE_URL_ENV]: QUEUE }),
      {} as NotificationDispatchService,
      recordingLogger().logger,
    );

    expect(publisher).toBeInstanceOf(SqsNotificationPublisher);
  });

  it('retombe sur l’expédition en processus sans file', () => {
    // Ce repli tient le troisième critère d'acceptation : sans lui, un poste
    // local et les suites d'intégration n'écriraient plus **aucune** ligne — pas
    // même la `FAILED` qui prouve au back-office qu'une confirmation aurait dû
    // partir.
    const publisher = notificationPublisherFactory(
      new NotificationsConfig({}),
      {} as NotificationDispatchService,
      recordingLogger().logger,
    );

    expect(publisher).toBeInstanceOf(InProcessNotificationPublisher);
  });

  it('refuse une URL de file mal formée dès l’amorçage', () => {
    // Seule des quatre lectures de configuration à ne pas être différée, et
    // délibérément : une file absente est un mode de marche normal, une file mal
    // écrite est une faute de déploiement qui rendrait la chaîne muette.
    expect(() =>
      notificationPublisherFactory(
        new NotificationsConfig({ [NOTIFICATION_QUEUE_URL_ENV]: 'https://exemple.test' }),
        {} as NotificationDispatchService,
        recordingLogger().logger,
      ),
    ).toThrow(/NOTIFICATION_QUEUE_URL/);
  });
});

describe('notifications — le publieur SQS remet l’enveloppe et rend la main', () => {
  it('publie l’enveloppe entière, et rien de plus', async () => {
    // La Lambda d'envoi valide ces sept champs un par un et rejette le reste en
    // échec **permanent** : un champ manquant n'est pas rejoué, il est perdu.
    // Aucune coordonnée n'y figure — l'enveloppe n'en porte pas.
    const logger = recordingLogger();
    const { publisher, recorder } = sqsPublisher(logger.logger);

    await publisher.publish(message());

    expect(recorder.bodies).toHaveLength(1);
    expect(JSON.parse(recorder.bodies[0] ?? '{}')).toEqual({
      tenantId: TENANT,
      dedupeKey: 'appointment:22222222-2222-4222-8222-222222222222:BOOKING_CONFIRMATION:EMAIL',
      appointmentId: '22222222-2222-4222-8222-222222222222',
      recipientUserId: '33333333-3333-4333-8333-333333333333',
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      scheduledFor: null,
    });
  });

  it('sérialise l’échéance du rappel en ISO 8601, que la Lambda sait relire', async () => {
    const logger = recordingLogger();
    const { publisher, recorder } = sqsPublisher(logger.logger);
    const scheduledFor = new Date('2026-09-08T12:30:00.000Z');

    await publisher.publish(message({ type: 'REMINDER_24H', scheduledFor }));

    expect(JSON.parse(recorder.bodies[0] ?? '{}')).toMatchObject({
      scheduledFor: '2026-09-08T12:30:00.000Z',
    });
  });

  it('ne journalise ni l’URL de la file, ni de coordonnée', async () => {
    // L'URL porte l'identifiant du compte AWS, et un journal est lu par plus de
    // monde qu'une réponse. L'identifiant SQS, lui, est opaque et non personnel.
    const logger = recordingLogger();
    const { publisher } = sqsPublisher(logger.logger);

    await publisher.publish(message());

    const serialized = JSON.stringify(logger.entries);
    expect(serialized).toContain('sqs-1');
    expect(serialized).not.toContain('123456789012');
    expect(serialized).not.toContain('amazonaws.com');
  });
});

describe('notifications — le repli en processus expédie comme avant #799', () => {
  it('appelle l’expédition et laisse la trace attendue', async () => {
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      countingSender().sender,
      logger.logger,
    );

    await new InProcessNotificationPublisher(dispatch).publish(message());

    expect(repository.rows.map((row) => row.status)).toEqual(['SENT']);
  });

  it('laisse remonter l’échec à l’abonné, qui le journalise sans le propager', async () => {
    // Il n'avale rien : c'est l'écouteur qui décide, canal par canal, et il le
    // faisait déjà avant #799.
    const repository = fakeNotificationsRepository();
    const logger = recordingLogger();
    const dispatch = new NotificationDispatchService(
      repository.repository,
      stubRenderer().renderer,
      countingSender([new Error('SES indisponible')]).sender,
      logger.logger,
    );

    await expect(
      new InProcessNotificationPublisher(dispatch).publish(message()),
    ).rejects.toThrow('SES indisponible');
    expect(repository.rows.map((row) => row.status)).toEqual(['FAILED']);
  });
});
