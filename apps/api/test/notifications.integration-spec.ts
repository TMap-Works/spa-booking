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
 *
 * ## Pourquoi `MANAGER` porte désormais les cas de contrat — #1200
 *
 * Ces cas-là parlent de la **forme** de la réponse : vocabulaire, instants,
 * champs omis, motif d'échec. Ils ont besoin que la réponse porte des lignes, et
 * depuis #1200 le journal d'un praticien ne porte que les envois de ses propres
 * rendez-vous. Les faire passer par un jeton `STAFF` aurait confondu deux
 * questions — « la réponse a-t-elle la bonne forme ? » et « l'appelant a-t-il le
 * droit de la lire ? » — et la première serait devenue verte sur une liste vide.
 *
 * La seconde a donc son propre `describe`, en fin de fichier, et c'est là que la
 * frontière de #1200 se prouve.
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
      .set('Authorization', await harness.bearer('MANAGER'))
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
      .set('Authorization', await harness.bearer('MANAGER'))
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
      .set('Authorization', await harness.bearer('MANAGER'))
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
      .set('Authorization', await harness.bearer('MANAGER'))
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
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.failureReason).toContain('expéditeur');
  });

  it('accepte plusieurs statuts d’un coup', async () => {
    const response = await request(server())
      .get(`${BASE}?statuses=failed&statuses=pending`)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);

    expect((response.body as ListBody).items).toHaveLength(2);
  });

  it('filtre par rendez-vous — l’usage du tiroir du back-office', async () => {
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV}`)
      .set('Authorization', await harness.bearer('MANAGER'))
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
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);

    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('@');
    expect(serialized).not.toContain('dedupeKey');
    expect(serialized).not.toContain('providerMessageId');
  });

  it('refuse un filtre inconnu en 400, et nomme le champ fautif', async () => {
    const response = await request(server())
      .get(`${BASE}?statuses=perdu`)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(400);

    const body = response.body as { code: string; message: string; details: unknown };

    expect(body).toHaveProperty('code');
    expect(body).toHaveProperty('details');
    expect(JSON.stringify(body)).toContain('statuses');
  });

  it('refuse un `appointmentId` mal formé en 400, avant toute lecture', async () => {
    await request(server())
      .get(`${BASE}?appointmentId=pas-un-uuid`)
      .set('Authorization', await harness.bearer('MANAGER'))
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

/**
 * **Le journal d'un praticien s'arrête à ses rendez-vous** — #1200.
 *
 * Le constat de la campagne QA `20260922-complet` : `GET /api/v1/notifications`
 * rendait à Sam les 89 lignes du salon, dont 32 rendez-vous de Marc, avec leurs
 * `appointmentId` et leurs `recipientUserId`. Ce sont ces identifiants-là qui
 * ont servi à monter le contournement de #1135 — lequel a fermé la conséquence,
 * pas l'exposition.
 *
 * Trois cas, et le troisième est celui qui empêche les deux premiers d'être
 * verts pour une mauvaise raison : un journal qui ne rendrait plus jamais rien
 * satisferait « Sam ne voit pas Marc » sans rendre le produit utilisable.
 */
describe('GET /api/v1/notifications — la portée du praticien', () => {
  let harness: NotificationsHarness;

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** L'envoi d'un rendez-vous de Marc — celui que Sam ne doit jamais lire. */
  const TRACE_DE_MARC = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const RDV_DE_MARC = '44444444-4444-4444-8444-444444444444';
  const MARC = '55555555-5555-4555-8555-555555555555';

  /**
   * Le compte sur lequel le jeton de Sam est signé.
   *
   * Le harnais le tire au hasard à chaque jeton : on le relit sur la portée que
   * la route vient de poser, ce qui est aussi une façon d'affirmer qu'elle en
   * pose bien une.
   */
  async function scopeOf(bearer: string): Promise<string> {
    await request(server()).get(BASE).set('Authorization', bearer).expect(200);

    const compte = harness.journal.lastQuery?.ownedByUserId;

    expect(typeof compte).toBe('string');

    return compte as string;
  }

  beforeEach(async () => {
    harness = await createNotificationsHarness();

    harness.seed({
      tenantId: harness.tenantId,
      id: TRACE_DE_MARC,
      appointmentId: RDV_DE_MARC,
      recipientUserId: CLIENTE,
      staffUserId: MARC,
      type: 'BOOKING_CONFIRMATION',
      channel: 'SMS',
      status: 'SENT',
      createdAt: new Date('2026-09-06T08:00:00Z'),
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('ne livre à Sam ni le rendez-vous ni le destinataire de Marc', async () => {
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toEqual([]);

    // L'assertion du ticket, mot pour mot : « en aucun cas la réponse ne lui
    // livre les `appointmentId` et les `recipientUserId` des rendez-vous de ses
    // collègues ». Sur le corps entier, pas seulement sur les champs qu'on
    // pense à regarder.
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(RDV_DE_MARC);
    expect(serialized).not.toContain(CLIENTE);
    expect(serialized).not.toContain(TRACE_DE_MARC);
  });

  it('ne se laisse pas rouvrir par le filtre `appointmentId` — le vecteur de #1135', async () => {
    // L'appel exact du ticket. Une liste vide, et non un 403 : distinguer « ce
    // rendez-vous existe mais n'est pas le vôtre » de « ce rendez-vous n'existe
    // pas » ferait de la route un oracle sur l'agenda du salon.
    const response = await request(server())
      .get(`${BASE}?appointmentId=${RDV_DE_MARC}`)
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(CLIENTE);
  });

  it('lui rend les siens, identifiants compris — le journal reste utile', async () => {
    // Sans ce cas, fermer la route entièrement suffirait à faire verdir les deux
    // précédents. Ce que #1200 borne, c'est l'étendue, pas l'usage : Sam doit
    // toujours pouvoir répondre à « ma cliente dit n'avoir rien reçu ».
    const sam = await harness.bearer('STAFF');
    const compte = await scopeOf(sam);

    harness.seed({
      tenantId: harness.tenantId,
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      appointmentId: RDV,
      recipientUserId: CLIENTE,
      staffUserId: compte,
      type: 'REMINDER_24H',
      channel: 'EMAIL',
      status: 'FAILED',
      failureReason: 'SES throttling',
      createdAt: new Date('2026-09-06T10:00:00Z'),
    });

    const response = await request(server()).get(BASE).set('Authorization', sam).expect(200);

    const body = response.body as ListBody;

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      appointmentId: RDV,
      recipientUserId: CLIENTE,
      status: 'failed',
      failureReason: 'SES throttling',
    });
  });

  it('ouvre le journal entier à l’encadrement, comme avant', async () => {
    const response = await request(server())
      .get(BASE)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(200);

    const body = response.body as ListBody;

    expect(body.items.map((item) => item.id)).toEqual([TRACE_DE_MARC]);
    expect(harness.journal.lastQuery?.ownedByUserId).toBeNull();
  });
});
