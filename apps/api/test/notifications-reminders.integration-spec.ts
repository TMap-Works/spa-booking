import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { getTenantId } from '../src/common/tenant';
import {
  INTERNAL_TOKEN_HEADER,
  INTERNAL_TOKEN_MIN_LENGTH,
  NOTIFICATIONS_INTERNAL_TOKEN_ENV,
  NotificationsConfig,
} from '../src/modules/notifications/notifications.config';
import type { DueReminder } from '../src/modules/notifications/notifications.types';
import { ReminderSweepRepository } from '../src/modules/notifications/reminder-sweep.repository';
import {
  REMINDER_LEAD_MS,
  REMINDER_WINDOW_MS,
} from '../src/modules/notifications/reminder-window';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * `POST /api/v1/notifications/reminders/sweep` — le balayage horaire du rappel
 * J-1 (#71).
 *
 * Cette suite exerce la **route**, pas la règle : la fenêtre, la tolérance et le
 * choix des canaux sont éprouvés par les suites unitaires, qui n'ont besoin
 * d'aucun serveur. Ce qui ne se prouve qu'ici :
 *
 * | Exigence | Pourquoi |
 * |---|---|
 * | la route est réellement servie | un contrôleur oublié dans les `controllers` de son module compile et rend 404 |
 * | elle refuse sans jeton d'appel interne | c'est la seule chose qui la sépare d'un anonyme, et elle lit tous les établissements |
 * | elle refuse un jeton faux, et un jeton de personne | une comparaison distraite laisserait passer n'importe quoi |
 * | l'enveloppe rendue est celle que la file attend | c'est la Lambda qui la recopie telle quelle dans SQS |
 * | chaque enveloppe porte l'établissement de sa propre portée | un balayage qui les mélangerait enverrait le rappel d'un salon à la cliente d'un autre |
 *
 * ## Ce que le double du dépôt refuse de faire
 *
 * Répondre hors portée de tenant. Il lit `getTenantId()` — le **vrai** contexte,
 * celui que l'extension Prisma consulterait — et lève sinon. Un balayage qui
 * oublierait d'ouvrir la portée, ou qui l'ouvrirait une fois pour toutes sur le
 * premier salon, fait donc rougir cette suite plutôt que de passer.
 */

const BASE = '/api/v1/notifications/reminders/sweep';

/** Un jeton de longueur défendable, propre à cette suite. */
const TOKEN = 'r'.repeat(INTERNAL_TOKEN_MIN_LENGTH);

const CLIENTE_A = '33333333-3333-4333-8333-333333333333';
const CLIENTE_B = '44444444-4444-4444-8444-444444444444';
const RDV_A = '11111111-1111-4111-8111-111111111111';
const RDV_B = '22222222-2222-4222-8222-222222222222';

interface SweepMessageBody {
  tenantId: string;
  dedupeKey: string;
  appointmentId: string;
  recipientUserId: string;
  type: string;
  channel: string;
  scheduledFor?: string;
}

interface SweepBody {
  sweptAt: string;
  from: string;
  to: string;
  tenantCount: number;
  appointmentCount: number;
  truncated: boolean;
  messages: SweepMessageBody[];
}

/**
 * Le dépôt de balayage, en mémoire.
 *
 * Semé **après** la construction de l'application, parce que les identifiants
 * des deux établissements sont tirés par le harnais : c'est ce qui permet de
 * vérifier qu'une enveloppe porte bien l'établissement de sa portée, et non un
 * identifiant que la suite aurait choisi.
 */
class FakeSweepRepository {
  private readonly seeded: DueReminder[] = [];

  public seed(reminder: DueReminder): void {
    this.seeded.push(reminder);
  }

  public listTenantIds(): Promise<readonly string[]> {
    return Promise.resolve([...new Set(this.seeded.map((reminder) => reminder.tenantId))]);
  }

  public findDueAppointments(
    window: { readonly from: Date; readonly to: Date },
    limit: number,
  ): Promise<readonly Omit<DueReminder, 'tenantId'>[]> {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new Error('findDueAppointments appelé hors de toute portée de tenant');
    }

    return Promise.resolve(
      this.seeded
        .filter((reminder) => reminder.tenantId === tenantId)
        .filter((reminder) => reminder.startsAt >= window.from && reminder.startsAt < window.to)
        .slice(0, limit)
        .map(({ tenantId: _ignored, ...rest }) => rest),
    );
  }
}

/** Un rendez-vous dû, au milieu de la fenêtre du balayage à venir. */
function inWindow(): Date {
  return new Date(Date.now() + REMINDER_LEAD_MS + REMINDER_WINDOW_MS / 2);
}

describe('POST /api/v1/notifications/reminders/sweep — le balayage du rappel J-1', () => {
  let harness: TenantHarness;
  let sweep: FakeSweepRepository;

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  const start = async (
    env: NodeJS.ProcessEnv = { [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN },
  ): Promise<void> => {
    sweep = new FakeSweepRepository();
    harness = await createTenantHarness({
      overrides: [
        { provide: ReminderSweepRepository, useValue: sweep },
        { provide: NotificationsConfig, useValue: new NotificationsConfig(env) },
      ],
    });
  };

  afterEach(async () => {
    await harness.close();
  });

  describe('la garde', () => {
    beforeEach(async () => {
      await start();
    });

    it('refuse un appel sans jeton', async () => {
      const response = await request(server()).post(BASE).expect(401);

      expect(response.body).toMatchObject({ code: 'INTERNAL_CALLER_REJECTED' });
      // Ni le jeton attendu, ni sa longueur : tout cela renseignerait qui
      // cherche à le deviner.
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    });

    it('refuse un jeton faux', async () => {
      await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, 'x'.repeat(INTERNAL_TOKEN_MIN_LENGTH))
        .expect(401);
    });

    it('n’accepte aucun jeton de personne à sa place', async () => {
      // Un jeton d'ADMIN est une identité humaine, rattachée à un
      // établissement ; la route en traverse tous les établissements et ne la
      // reconnaît pas.
      await request(server())
        .post(BASE)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(401);
    });
  });

  it('répond 503 tant qu’aucun jeton n’est configuré — défaut fermé', async () => {
    await start({});

    const response = await request(server())
      .post(BASE)
      .set(INTERNAL_TOKEN_HEADER, TOKEN)
      .expect(503);

    expect(response.body).toMatchObject({ code: 'INTERNAL_CALLER_NOT_CONFIGURED' });
  });

  describe('le balayage', () => {
    beforeEach(async () => {
      await start();
    });

    it('rend les enveloppes attendues par la file, dans le vocabulaire du domaine', async () => {
      const startsAt = inWindow();
      sweep.seed({
        tenantId: harness.a.id,
        appointmentId: RDV_A,
        clientId: CLIENTE_A,
        startsAt,
        hasEmail: true,
        hasSms: false,
        liveChannels: [],
      });

      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .expect(200);

      const body = response.body as SweepBody;

      expect(body.appointmentCount).toBe(1);
      expect(body.truncated).toBe(false);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).toMatchObject({
        tenantId: harness.a.id,
        appointmentId: RDV_A,
        recipientUserId: CLIENTE_A,
        // En **majuscules** : c'est le vocabulaire que la Lambda d'envoi valide,
        // et cette enveloppe part telle quelle dans SQS.
        type: 'REMINDER_24H',
        channel: 'EMAIL',
      });
      expect(body.messages[0]?.dedupeKey).toBe(`appointment:${RDV_A}:REMINDER_24H:EMAIL`);
      // Les instants sortent en ISO 8601 UTC : la conversion au fuseau du salon
      // est un geste d'affichage, et il n'y a pas d'affichage ici.
      expect(body.from.endsWith('Z')).toBe(true);
      expect(body.to.endsWith('Z')).toBe(true);
      expect(body.messages[0]?.scheduledFor).toBe(
        new Date(startsAt.getTime() - REMINDER_LEAD_MS).toISOString(),
      );
    });

    it('rattache chaque enveloppe à l’établissement dont la portée l’a produite', async () => {
      sweep.seed({
        tenantId: harness.a.id,
        appointmentId: RDV_A,
        clientId: CLIENTE_A,
        startsAt: inWindow(),
        hasEmail: true,
        hasSms: false,
        liveChannels: [],
      });
      sweep.seed({
        tenantId: harness.b.id,
        appointmentId: RDV_B,
        clientId: CLIENTE_B,
        startsAt: inWindow(),
        hasEmail: true,
        hasSms: false,
        liveChannels: [],
      });

      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .expect(200);

      const body = response.body as SweepBody;

      expect(body.tenantCount).toBe(2);
      expect(
        body.messages.map((message) => `${message.tenantId}|${message.appointmentId}`).sort(),
      ).toEqual([`${harness.a.id}|${RDV_A}`, `${harness.b.id}|${RDV_B}`].sort());
    });

    it('ne retient rien pour un rendez-vous pris à moins de 24 heures', async () => {
      sweep.seed({
        tenantId: harness.a.id,
        appointmentId: RDV_A,
        clientId: CLIENTE_A,
        startsAt: new Date(Date.now() + 12 * 3_600_000),
        hasEmail: true,
        hasSms: true,
        liveChannels: [],
      });

      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .expect(200);

      const body = response.body as SweepBody;

      expect(body.appointmentCount).toBe(0);
      expect(body.messages).toEqual([]);
    });
  });
});
