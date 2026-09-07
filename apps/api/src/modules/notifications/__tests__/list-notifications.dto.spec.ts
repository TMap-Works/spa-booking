import {
  NOTIFICATION_CHANNEL_FILTERS,
  NOTIFICATION_STATUS_FILTERS,
  NOTIFICATION_TYPE_FILTERS,
  toNotificationDto,
  toNotificationListDto,
  toNotificationSearch,
  type ListNotificationsQueryDto,
} from '../dto/list-notifications.dto';
import { NOTIFICATION_LIST_MAX, NotificationsService } from '../notifications.service';
import type { NotificationsRepository } from '../notifications.repository';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
  type NotificationListQuery,
  type NotificationTrace,
} from '../notifications.types';

/**
 * La frontière HTTP du journal d'envois — le passage entre le vocabulaire du
 * contrat partagé et celui du domaine.
 *
 * C'est le seul endroit du module où deux casses coexistent, et le seul où une
 * divergence silencieuse est possible : `notificationSchema` de `@spa/shared`
 * dit `booking_confirmation`, l'énumération PostgreSQL dit
 * `BOOKING_CONFIRMATION`, et rien à la compilation ne rapproche les deux.
 */

const TRACE: NotificationTrace = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  appointmentId: '11111111-1111-4111-8111-111111111111',
  recipientUserId: '22222222-2222-4222-8222-222222222222',
  type: 'BOOKING_CONFIRMATION',
  channel: 'EMAIL',
  status: 'SENT',
  scheduledFor: null,
  sentAt: new Date('2026-09-06T08:00:01Z'),
  attemptCount: 1,
  failureReason: null,
  createdAt: new Date('2026-09-06T08:00:00Z'),
};

describe('notifications — les deux vocabulaires se correspondent terme à terme', () => {
  it('chaque valeur du domaine a son filtre, et réciproquement', () => {
    // Une valeur ajoutée d'un côté sans l'autre laisserait la requête refuser un
    // type que la réponse peut rendre. Les listes étant dérivées, ce témoin
    // vérifie surtout que la dérivation est bien celle qu'on croit.
    expect(NOTIFICATION_TYPE_FILTERS).toEqual(NOTIFICATION_TYPES.map((v) => v.toLowerCase()));
    expect(NOTIFICATION_CHANNEL_FILTERS).toEqual(NOTIFICATION_CHANNELS.map((v) => v.toLowerCase()));
    expect(NOTIFICATION_STATUS_FILTERS).toEqual(NOTIFICATION_STATUSES.map((v) => v.toLowerCase()));
  });

  it('les filtres sont exactement ceux que `@spa/shared` déclare', () => {
    // Recopiés du contrat, délibérément : si le paquet partagé changeait un
    // libellé, c'est ici que la divergence doit se voir.
    expect(NOTIFICATION_TYPE_FILTERS).toEqual([
      'booking_confirmation',
      'reminder_24h',
      'cancellation',
    ]);
    expect(NOTIFICATION_CHANNEL_FILTERS).toEqual(['email', 'sms']);
    expect(NOTIFICATION_STATUS_FILTERS).toEqual(['pending', 'sent', 'failed']);
  });

  it('remonte les filtres de la requête dans le vocabulaire du domaine', () => {
    const dto: ListNotificationsQueryDto = {
      appointmentId: '11111111-1111-4111-8111-111111111111',
      type: 'reminder_24h',
      channel: 'sms',
      statuses: ['failed', 'pending'],
    };

    expect(toNotificationSearch(dto)).toEqual({
      appointmentId: '11111111-1111-4111-8111-111111111111',
      type: 'REMINDER_24H',
      channel: 'SMS',
      statuses: ['FAILED', 'PENDING'],
    });
  });

  it('n’invente aucun filtre absent de la requête', () => {
    // Un `type: undefined` transmis au dépôt deviendrait un `WHERE type = NULL`
    // et ne rendrait jamais rien.
    expect(toNotificationSearch({})).toEqual({});
  });
});

describe('notifications — la sérialisation d’une trace', () => {
  it('met la casse du contrat et rend les instants en UTC', () => {
    expect(toNotificationDto(TRACE)).toEqual({
      id: TRACE.id,
      appointmentId: TRACE.appointmentId,
      recipientUserId: TRACE.recipientUserId,
      type: 'booking_confirmation',
      channel: 'email',
      status: 'sent',
      sentAt: '2026-09-06T08:00:01.000Z',
      attemptCount: 1,
      createdAt: '2026-09-06T08:00:00.000Z',
    });
  });

  it('omet les champs nuls plutôt que de les rendre à `null`', () => {
    const dto = toNotificationDto({ ...TRACE, appointmentId: null, sentAt: null });

    expect(dto).not.toHaveProperty('appointmentId');
    expect(dto).not.toHaveProperty('sentAt');
  });

  it('rend le motif d’échec quand il y en a un', () => {
    const dto = toNotificationDto({
      ...TRACE,
      status: 'FAILED',
      sentAt: null,
      failureReason: 'SES throttling',
    });

    expect(dto).toMatchObject({ status: 'failed', failureReason: 'SES throttling' });
  });

  it('annonce le plafond appliqué sur l’enveloppe', () => {
    expect(toNotificationListDto([TRACE])).toEqual({
      items: [toNotificationDto(TRACE)],
      limit: NOTIFICATION_LIST_MAX,
    });
  });
});

describe('notifications — le plafond de lecture est une règle du service', () => {
  function build() {
    const queries: NotificationListQuery[] = [];
    const repository = {
      list: (query: NotificationListQuery) => {
        queries.push(query);
        return Promise.resolve([]);
      },
    } as unknown as NotificationsRepository;

    return { queries, service: new NotificationsService(repository) };
  }

  it('applique le plafond quand l’appelant n’en demande pas', async () => {
    // Une lecture non bornée est un déni de service à une requête sur un
    // établissement actif.
    const { queries, service } = build();

    await service.list({});

    expect(queries[0]?.limit).toBe(NOTIFICATION_LIST_MAX);
  });

  it('honore une demande plus étroite', async () => {
    const { queries, service } = build();

    await service.list({ limit: 5 });

    expect(queries[0]?.limit).toBe(5);
  });

  it('ne laisse pas l’appelant dépasser le plafond', async () => {
    const { queries, service } = build();

    await service.list({ limit: 10_000 });

    expect(queries[0]?.limit).toBe(NOTIFICATION_LIST_MAX);
  });
});
