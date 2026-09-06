import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import {
  bookableSlot,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';
import type { TenantFixture } from './utils/tenant-harness';

/**
 * Fuite inter-tenant sur les **trois écritures de comptoir** — tenant-isolation
 * §6, appliqué aux routes de #461.
 *
 * ## Ce que ces trois routes rendraient possible si la frontière cédait
 *
 * Elles n'ont pas toutes le même pouvoir de nuisance, et c'est pourquoi elles
 * sont toutes les trois exercées :
 *
 * | Route | Ce qu'une traversée ferait |
 * |---|---|
 * | `POST /appointments` | poser un rendez-vous dans l'agenda d'un salon voisin, au nom d'une de ses clientes |
 * | `POST /:id/reschedule` | déplacer le rendez-vous d'un voisin, donc annuler le sien et en créer un autre |
 * | `POST /:id/status` | solder ou marquer no-show le rendez-vous d'un voisin — irréversible |
 *
 * La création se distingue des deux autres : elle ne désigne pas un rendez-vous
 * mais **trois ressources** — prestation, praticien, fiche cliente — et chacune
 * est une porte d'entrée distincte. Une traversée par le seul `clientId` suffit
 * à rattacher un rendez-vous à la cliente d'un autre salon ; c'est le cas que la
 * clé étrangère composite `(tenant_id, client_id)` ferme, et que la traduction
 * en 404 rend indiscernable d'un identifiant inventé.
 *
 * Dans tous les cas **404, jamais 403** : un 403 confirmerait l'existence de la
 * ressource à qui vient d'essayer de l'atteindre (tenant-isolation §4). Et dans
 * tous les cas, l'état du voisin est relu après le refus — c'est ce qui
 * distingue « la réponse est bonne » de « rien n'a été écrit ».
 */

const DESK_PATH = '/api/v1/appointments';

const RESCHEDULE_PATH = (id: string): string => `${DESK_PATH}/${id}/reschedule`;

const STATUS_PATH = (id: string): string => `${DESK_PATH}/${id}/status`;

describe('Isolation inter-tenant — écritures de rendez-vous au comptoir', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;
  /** Une fiche cliente de A, et une de B — deux annuaires qui ne se croisent pas. */
  let clientDeA: string;
  let clientDeB: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();

    clientDeA = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'camille@lilas.test',
    }).id;
    clientDeB = harness.appointments.seedClient({
      tenantId: harness.b.tenant.id,
      email: 'camille@port.test',
    }).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  /**
   * Un porteur signé pour cet établissement-**là**.
   *
   * L'établissement est explicite et non implicite : un jeton signé sur une
   * portée qui ne désigne aucun établissement ferait verdir tous les cas de
   * traversée sans avoir jamais visé le voisin — le mode de défaillance qu'un
   * harnais de fuite ne peut pas se permettre.
   */
  async function bearer(role: UserRole, tenant: TenantFixture): Promise<string> {
    const tokens = harness.app.get(TokenService);
    const token = await tokens.signAccessToken({
      userId: randomUUID(),
      tenantId: tenant.id,
      role,
    });
    return `Bearer ${token}`;
  }

  /** Pose un rendez-vous chez A, par la route de comptoir, et rend son identifiant. */
  async function poseChezA(): Promise<string> {
    const response = await request(harness.server())
      .post(DESK_PATH)
      .set('Authorization', await bearer('STAFF', harness.a.tenant))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        clientId: clientDeA,
      });

    expect(response.status).toBe(201);
    return String((response.body as { id: string }).id);
  }

  describe('POST /appointments — poser chez le voisin', () => {
    it('refuse en 404 la prestation de A avec un jeton `STAFF` de B', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
          clientId: clientDeB,
        });

      // La prestation est résolue par `ServicesService`, déjà borné au tenant du
      // jeton : elle est introuvable, jamais interdite.
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('refuse en 404 la fiche cliente du voisin, dans son propre établissement', async () => {
      const response = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({
          serviceId: harness.b.serviceId,
          staffId: harness.b.staffId,
          startsAt: slot.startsAt.toISOString(),
          // Tout est de B, sauf la cliente — c'est le seul champ qui traverse.
          clientId: clientDeA,
        });

      // La clé étrangère composite `(tenant_id, client_id)` refuse la ligne, et
      // le repository traduit ce refus en 404 : sans cela, le salon B aurait pu
      // rattacher son rendez-vous à une cliente de A, et le seul symptôme aurait
      // été un 500.
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('rend le **même** 404 pour une fiche inventée et pour celle du voisin', async () => {
      const corps = (clientId: string): Record<string, unknown> => ({
        serviceId: harness.b.serviceId,
        staffId: harness.b.staffId,
        startsAt: slot.startsAt.toISOString(),
        clientId,
      });

      const inventée = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send(corps(randomUUID()));
      const duVoisin = await request(harness.server())
        .post(DESK_PATH)
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send(corps(clientDeA));

      // « Inexistante » et « existante ailleurs » doivent être indiscernables,
      // faute de quoi la différence sert de sonde d'annuaire client.
      expect(inventée.status).toBe(duVoisin.status);
      expect(inventée.body.code).toBe(duVoisin.body.code);
    });

    it('n’écrit rien chez le voisin quand la pose aboutit', async () => {
      await poseChezA();

      expect(
        harness.appointments.appointments.filter((row) => row.tenantId === harness.b.tenant.id),
      ).toHaveLength(0);
    });
  });

  describe('POST /:id/reschedule — déplacer chez le voisin', () => {
    it('refuse en 404 le rendez-vous de A avec un jeton `STAFF` de B', async () => {
      const chezA = await poseChezA();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
    });

    it('ne laisse pas même un `ADMIN` du voisin déplacer chez A', async () => {
      const chezA = await poseChezA();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(chezA))
        .set('Authorization', await bearer('ADMIN', harness.b.tenant))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      // Le rang le plus élevé ne traverse pas davantage : la frontière n'est pas
      // une question de droits, c'est une question de portée.
      expect(response.status).toBe(404);
    });

    it('laisse le rendez-vous du voisin intact, et n’en crée aucun second', async () => {
      const chezA = await poseChezA();

      await request(harness.server())
        .post(RESCHEDULE_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      const gardé = harness.appointments.appointments.find((row) => row.id === chezA);
      expect(gardé?.status).toBe('PENDING');
      expect(gardé?.cancelledAt).toBeNull();
      // Un report traversant aurait laissé **deux** lignes : l'ancienne annulée
      // et une neuve. Le compte est donc la preuve la plus directe.
      expect(harness.appointments.appointments).toHaveLength(1);
    });

    it('accepte le même appel avec le jeton du bon établissement', async () => {
      const chezA = await poseChezA();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.a.tenant))
        .send({ startsAt: bookableSlot(14).startsAt.toISOString() });

      // Le contrôle de la contrepartie : sans lui, un refus systématique — une
      // route cassée, par exemple — ferait verdir toute cette suite.
      expect(response.status).toBe(201);
    });
  });

  describe('POST /:id/status — solder chez le voisin', () => {
    it('refuse en 404 le rendez-vous de A avec un jeton `STAFF` de B', async () => {
      const chezA = await poseChezA();

      const response = await request(harness.server())
        .post(STATUS_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({ status: 'confirmed' });

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
    });

    it('laisse le statut du voisin intact après le refus', async () => {
      const chezA = await poseChezA();

      await request(harness.server())
        .post(STATUS_PATH(chezA))
        .set('Authorization', await bearer('ADMIN', harness.b.tenant))
        .send({ status: 'no_show' });

      // `NO_SHOW` est terminal : une traversée n'aurait aucun geste de
      // rattrapage, et le praticien de A découvrirait son créneau rendu à la
      // vente sans rien avoir demandé.
      const gardé = harness.appointments.appointments.find((row) => row.id === chezA);
      expect(gardé?.status).toBe('PENDING');
    });

    it('rend le **même** 404 pour un identifiant qui n’existe nulle part', async () => {
      const chezA = await poseChezA();

      const inconnu = await request(harness.server())
        .post(STATUS_PATH(randomUUID()))
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({ status: 'confirmed' });
      const ailleurs = await request(harness.server())
        .post(STATUS_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.b.tenant))
        .send({ status: 'confirmed' });

      expect(inconnu.status).toBe(ailleurs.status);
      expect(inconnu.body.code).toBe(ailleurs.body.code);
    });

    it('accepte le même appel avec le jeton du bon établissement', async () => {
      const chezA = await poseChezA();

      const response = await request(harness.server())
        .post(STATUS_PATH(chezA))
        .set('Authorization', await bearer('STAFF', harness.a.tenant))
        .send({ status: 'confirmed' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'CONFIRMED' });
    });
  });
});
