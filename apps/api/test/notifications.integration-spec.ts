import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createNotificationsHarness, type NotificationsHarness } from './notifications.harness';

/**
 * `GET /api/v1/notifications` — le journal d'envois du back-office (#70,
 * cinquième critère d'acceptation).
 *
 * Ce que cette suite exige, au-delà du fait que la route réponde :
 *
 * | Exigence | Pourquoi |
 * |---|---|
 * | le vocabulaire de la réponse est celui du contrat partagé, en minuscules | le front valide contre `notificationSchema` et rejetterait `SENT` |
 * | les instants sortent en ISO 8601 UTC suffixés `Z` | la conversion au fuseau du salon est un geste d'affichage |
 * | les champs nuls sont **omis** | le contrat les déclare `.optional()`, un `null` y échouerait |
 * | ni coordonnée ni contenu de message | CDC §5.1, notifications §7 |
 * | un filtre inconnu tombe en 400 avec le champ nommé | api-module §5 |
 */

const BASE = '/api/v1/notifications';

const RDV = '11111111-1111-4111-8111-111111111111';
const AUTRE_RDV = '22222222-2222-4222-8222-222222222222';
const CLIENTE = '33333333-3333-4333-8333-333333333333';

interface NotificationBody {
  id: string;
  appointmentId?: string;
  recipientUserId?: string;
  type: string;
  channel: string;
  status: string;
  sentAt?: string;
  failureReason?: string;
  attemptCount: number;
  createdAt: string;
}

interface ListBody {
  items: NotificationBody[];
  limit: number;
}

describe('GET /api/v1/notifications — le journal d’envois', () => {
  let harness: NotificationsHarness;

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  beforeEach(async () => {
    harness = await createNotificationsHarness();

    // Une confirmation partie par e-mail, la même en échec par SMS : c'est
    // exactement ce que produit une réservation quand SNS n'est pas configuré,
    // et c'est ce que le tiroir de rendez-vous doit savoir montrer.
    harness.seed({
      tenantId: harness.tenantId,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      appointmentId: RDV,
      recipientUserId: CLIENTE,
      type: 'BOOKING_CONFIRMATION',
      channel: 'EMAIL',
      status: 'SENT',
      sentAt: new Date('2026-09-06T08:00:01Z'),
      createdAt: new Date('2026-09-06T08:00:00Z'),
    });
    harness.seed({
      tenantId: harness.tenantId,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      appointmentId: RDV,
      recipientUserId: CLIENTE,
      type: 'BOOKING_CONFIRMATION',
      channel: 'SMS',
      status: 'FAILED',
      failureReason: "Aucun expéditeur n'est configuré pour ce canal de notification.",
      createdAt: new Date('2026-09-06T08:00:02Z'),
    });
    harness.seed({
      tenantId: harness.tenantId,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      appointmentId: AUTRE_RDV,
      recipientUserId: CLIENTE,
      type: 'REMINDER_24H',
      channel: 'EMAIL',
      status: 'PENDING',
      createdAt: new Date('2026-09-05T08:00:00Z'),
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('rend les traces du plus récent au plus ancien, avec le plafond appliqué', async () => {
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items.map((item) => item.channel)).toEqual(['sms', 'email', 'email']);
    expect(body.limit).toBe(200);
  });

  it('parle le vocabulaire du contrat partagé, en minuscules', async () => {
    // `notificationSchema` de `@spa/shared` déclare `booking_confirmation`,
    // `email`, `sent`. Rendre la casse de PostgreSQL ferait échouer la
    // validation côté front, sans que rien ne le dise ici.
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV}&channel=email`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items[0]).toMatchObject({
      type: 'booking_confirmation',
      channel: 'email',
      status: 'sent',
    });
  });

  it('rend les instants en ISO 8601 UTC suffixés `Z`', async () => {
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV}&channel=email`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const [trace] = (response.body as ListBody).items;

    expect(trace?.createdAt).toBe('2026-09-06T08:00:00.000Z');
    expect(trace?.sentAt).toBe('2026-09-06T08:00:01.000Z');
  });

  it('omet les champs nuls plutôt que de les rendre à `null`', async () => {
    // Le contrat les déclare `.optional()` : un `null` explicite échouerait à la
    // validation Zod côté front.
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV}&channel=email`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const [trace] = (response.body as ListBody).items;

    expect(trace).not.toHaveProperty('failureReason');
    expect(trace).not.toHaveProperty('scheduledFor');
  });

  it('rend le motif d’échec, qui est tout l’intérêt de l’écran', async () => {
    // « Sans cela, la seule trace d'un rappel jamais parti est la cliente qui ne
    // vient pas » — l'en-tête de `packages/shared/src/schemas/notification.ts`.
    const response = await request(server())
      .get(`${BASE}?statuses=failed`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.failureReason).toContain('expéditeur');
  });

  it('accepte plusieurs statuts d’un coup', async () => {
    const response = await request(server())
      .get(`${BASE}?statuses=failed&statuses=pending`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    expect((response.body as ListBody).items).toHaveLength(2);
  });

  it('filtre par rendez-vous — l’usage du tiroir du back-office', async () => {
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV}`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.appointmentId === RDV)).toBe(true);
  });

  it('ne rend ni coordonnée ni contenu de message', async () => {
    // La table n'en porte pas ; cette assertion garde la propriété visible si
    // quelqu'un élargissait la projection un jour.
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('dedupeKey');
    expect(serialized).not.toContain('providerMessageId');
  });

  it('refuse un filtre inconnu en 400, et nomme le champ fautif', async () => {
    const response = await request(server())
      .get(`${BASE}?statuses=perdu`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(400);

    const body = response.body as { code: string; message: string; details: unknown };

    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('details');
    expect(JSON.stringify(body)).toContain('statuses');
  });

  it('refuse un `appointmentId` mal formé en 400, avant toute lecture', async () => {
    await request(server())
      .get(`${BASE}?appointmentId=pas-un-uuid`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(400);
  });

  it('est servie — son chemin figure bien dans le graphe de l’application', async () => {
    // Un contrôleur oublié dans les `controllers` de son module compile et
    // passe ses tests unitaires, puis rend 404 en vrai.
    await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);
  });
});
