import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { getTenantId } from '../src/common/tenant';
import { DeliveryEventRepository } from '../src/modules/notifications/delivery-event.repository';
import {
  INTERNAL_TOKEN_HEADER,
  INTERNAL_TOKEN_MIN_LENGTH,
  NOTIFICATIONS_INTERNAL_TOKEN_ENV,
  NotificationsConfig,
} from '../src/modules/notifications/notifications.config';
import type { EmailSuppressionReason } from '../src/modules/notifications/notifications.types';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * `POST /api/v1/notifications/delivery-events` — l'ingestion des rebonds et des
 * plaintes SES (#73).
 *
 * Cette suite exerce la **route**, pas la règle : le classement des événements
 * est éprouvé par `delivery-event.spec.ts` et le balayage des établissements par
 * `delivery-event.service.spec.ts`, l'un et l'autre sans serveur. Ce qui ne se
 * prouve qu'ici :
 *
 * | Exigence | Pourquoi |
 * |---|---|
 * | la route est réellement servie | un contrôleur oublié dans les `controllers` de son module compile et rend 404 |
 * | elle refuse sans jeton d'appel interne | c'est la seule chose qui la sépare d'un anonyme, et elle écrit dans tous les établissements |
 * | elle refuse un jeton de personne | un JWT d'ADMIN est une identité humaine rattachée à un salon ; cette route les traverse tous |
 * | une charge illisible rend 200 | un statut d'échec ferait rejouer jusqu'à la file d'attente morte un message que rien ne réparera |
 * | chaque écriture a lieu dans la portée de son établissement | c'est la seule garantie qu'un rebond ne supprime pas l'adresse du mauvais salon |
 * | la réponse ne porte aucune adresse | elle est journalisée par la Lambda, et notifications §7 l'interdit |
 *
 * ## Ce que le double du dépôt refuse de faire
 *
 * Écrire hors portée de tenant. Il lit `getTenantId()` — le **vrai** contexte,
 * celui que l'extension Prisma consulterait — et lève sinon.
 */

const BASE = '/api/v1/notifications/delivery-events';

/** Un jeton de longueur défendable, propre à cette suite. */
const TOKEN = 'd'.repeat(INTERNAL_TOKEN_MIN_LENGTH);

const ADRESSE = 'morte@exemple.test';

interface DeliveryEventBody {
  outcome: string;
  eventType?: string;
  detail?: string;
  messageId?: string;
  reason?: string;
  recipientCount: number;
  tenantCount: number;
  suppressed: number;
}

/** Une écriture telle que le double l'a reçue — avec la portée qui l'a portée. */
interface Write {
  readonly tenantId: string;
  readonly addresses: readonly string[];
  readonly reason: EmailSuppressionReason;
}

/**
 * Le dépôt d'ingestion, en mémoire.
 *
 * Les identifiants des deux établissements sont tirés par le harnais : ils lui
 * sont donc donnés **après** la construction de l'application, ce qui est
 * précisément ce qui permet de vérifier qu'une écriture a lieu dans la portée
 * d'un salon réel plutôt que d'un identifiant choisi par la suite.
 */
class FakeDeliveryEventRepository {
  public readonly writes: Write[] = [];

  private tenantIds: readonly string[] = [];

  public useTenants(tenantIds: readonly string[]): void {
    this.tenantIds = tenantIds;
  }

  public listTenantIds(): Promise<readonly string[]> {
    return Promise.resolve(this.tenantIds);
  }

  public suppressEmails(
    addresses: readonly string[],
    reason: EmailSuppressionReason,
  ): Promise<number> {
    const tenantId = getTenantId();

    if (tenantId === undefined) {
      throw new Error('suppressEmails appelé hors de toute portée de tenant');
    }

    this.writes.push({ tenantId, addresses, reason });

    // Un salon sur deux connaît l'adresse : c'est ce qui rend `suppressed`
    // observable, et ce qui montre qu'un zéro chez l'un n'empêche pas l'autre.
    return Promise.resolve(tenantId === this.tenantIds[0] ? 1 : 0);
  }
}

function hardBounce(): Record<string, unknown> {
  return {
    eventType: 'Bounce',
    mail: { messageId: 'ses-0102' },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: ADRESSE }],
    },
  };
}

describe('POST /api/v1/notifications/delivery-events — les rebonds et les plaintes', () => {
  let harness: TenantHarness;
  let repository: FakeDeliveryEventRepository;

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  const start = async (
    env: NodeJS.ProcessEnv = { [NOTIFICATIONS_INTERNAL_TOKEN_ENV]: TOKEN },
  ): Promise<void> => {
    repository = new FakeDeliveryEventRepository();
    harness = await createTenantHarness({
      overrides: [
        { provide: DeliveryEventRepository, useValue: repository },
        { provide: NotificationsConfig, useValue: new NotificationsConfig(env) },
      ],
    });
    repository.useTenants([harness.a.id, harness.b.id]);
  };

  afterEach(async () => {
    await harness.close();
  });

  describe('la garde', () => {
    beforeEach(async () => {
      await start();
    });

    it('refuse un appel sans jeton', async () => {
      const response = await request(server()).post(BASE).send(hardBounce()).expect(401);

      expect(response.body).toMatchObject({ code: 'INTERNAL_CALLER_REJECTED' });
      // Ni le jeton attendu, ni sa longueur : tout cela renseignerait qui
      // cherche à le deviner.
      expect(JSON.stringify(response.body)).not.toContain(TOKEN);
    });

    it('refuse un jeton faux', async () => {
      await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, 'x'.repeat(INTERNAL_TOKEN_MIN_LENGTH))
        .send(hardBounce())
        .expect(401);
    });

    it('n’accepte aucun jeton de personne à sa place', async () => {
      // Un jeton d'ADMIN est une identité humaine, rattachée à un
      // établissement ; la route les traverse tous et ne la reconnaît pas.
      await request(server())
        .post(BASE)
        .set('Authorization', await harness.bearer('ADMIN'))
        .send(hardBounce())
        .expect(401);
    });

    it('n’écrit rien quand la garde a refusé', async () => {
      await request(server()).post(BASE).send(hardBounce()).expect(401);

      expect(repository.writes).toEqual([]);
    });
  });

  it('répond 503 tant qu’aucun jeton n’est configuré — défaut fermé', async () => {
    await start({});

    const response = await request(server())
      .post(BASE)
      .set(INTERNAL_TOKEN_HEADER, TOKEN)
      .send(hardBounce())
      .expect(503);

    expect(response.body).toMatchObject({ code: 'INTERNAL_CALLER_NOT_CONFIGURED' });
  });

  describe('l’ingestion', () => {
    beforeEach(async () => {
      await start();
    });

    it('supprime l’adresse dans chaque établissement, dans sa propre portée', async () => {
      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .send(hardBounce())
        .expect(200);

      const body = response.body as DeliveryEventBody;

      expect(body).toMatchObject({
        outcome: 'suppress',
        eventType: 'BOUNCE',
        reason: 'HARD_BOUNCE',
        detail: 'General',
        messageId: 'ses-0102',
        recipientCount: 1,
        tenantCount: 2,
        // Un seul des deux salons connaissait l'adresse — et l'autre a bien
        // été visité, ce que `tenantCount` établit.
        suppressed: 1,
      });

      expect(repository.writes.map((write) => write.tenantId)).toEqual([
        harness.a.id,
        harness.b.id,
      ]);
      expect(repository.writes.every((write) => write.reason === 'HARD_BOUNCE')).toBe(true);
    });

    it('n’écrit rien pour un rebond transitoire', async () => {
      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .send({ eventType: 'Bounce', bounce: { bounceType: 'Transient' } })
        .expect(200);

      expect(response.body).toMatchObject({ outcome: 'transient', suppressed: 0 });
      expect(repository.writes).toEqual([]);
    });

    it('rend 200 sur une charge illisible plutôt que de la faire rejouer', async () => {
      // Un statut d'échec ferait rejouer le message jusqu'à la file d'attente
      // morte, et l'alarme de profondeur signalerait une panne là où il n'y a
      // qu'un message inattendu que rien ne réparera.
      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .send({ eventType: 'Teleportation' })
        .expect(200);

      expect(response.body).toMatchObject({ outcome: 'unreadable', suppressed: 0 });
      expect(repository.writes).toEqual([]);
    });

    it('ne rend jamais l’adresse qu’elle vient de supprimer', async () => {
      // La réponse est journalisée par la Lambda : une adresse dedans y
      // resterait aussi longtemps que la rétention du groupe de journaux.
      const response = await request(server())
        .post(BASE)
        .set(INTERNAL_TOKEN_HEADER, TOKEN)
        .send(hardBounce())
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(ADRESSE);
    });
  });
});
