import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { createAppointmentsHarness, type AppointmentsHarness } from './appointments.harness';
import { expectListScopedTo } from './utils/tenant-assertions';
import type { TenantFixture } from './utils/tenant-harness';

/**
 * Fuite inter-tenant sur l'**historique client** — tenant-isolation §6, appliqué
 * à `GET /api/v1/appointments/mine` (#47).
 *
 * ## Ce qu'une traversée coûterait ici
 *
 * Une lecture, mais pas n'importe laquelle : l'historique d'une cliente porte
 * ses heures de rendez-vous, ses prestations, ses montants et ses notes. C'est
 * exactement la donnée personnelle que le CDC §5.1 protège, et une fuite ici
 * livrerait le fichier client d'un salon concurrent — l'incident le plus grave
 * que ce produit puisse produire.
 *
 * ## Deux frontières, et une seule des deux serait insuffisante
 *
 * | Frontière | Ce qui la tient | Le cas qui l'exerce |
 * |---|---|---|
 * | l'**établissement** | le client Prisma scopé, armé par la revendication du jeton | même identifiant de cliente, deux salons |
 * | la **cliente** | `clientId` pris dans `@CurrentUser()`, absent de tout DTO | deux clientes du même salon |
 *
 * Le premier cas est le plus retors, et c'est pour cela qu'il est semé
 * explicitement : deux lignes portant le **même** `clientId` dans deux
 * établissements. Un filtre par cliente sans filtre par établissement les
 * ramènerait toutes les deux, et aucune assertion sur « la liste n'est pas
 * vide » ne le verrait.
 */

const MINE_PATH = '/api/v1/appointments/mine';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe('Isolation inter-tenant — historique des rendez-vous d’une cliente', () => {
  let harness: AppointmentsHarness;

  /**
   * L'identifiant de cliente **partagé** par les deux établissements.
   *
   * Rien ne l'interdit : `users.id` est unique globalement, mais deux jetons
   * signés sur deux tenants peuvent porter le même `sub` — c'est ce qui
   * arriverait si le module émettait un jour un jeton mal apparié, et c'est le
   * scénario qui distingue un filtre par cliente d'un filtre par cliente **et**
   * par établissement.
   */
  const sharedClientId = randomUUID();
  /** Une seconde cliente du même établissement — la frontière interne. */
  const otherClientId = randomUUID();

  let inA: string;
  let inAPast: string;
  let inAOtherClient: string;
  let inB: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();

    const future = new Date(Date.now() + 14 * DAY_MS);
    const past = new Date(Date.now() - 14 * DAY_MS);

    inA = harness.appointments.seedAppointment({
      tenantId: harness.a.tenant.id,
      staffId: harness.a.staffId,
      serviceId: harness.a.serviceId,
      clientId: sharedClientId,
      startsAt: future,
      endsAt: new Date(future.getTime() + HOUR_MS),
    }).id;

    inAPast = harness.appointments.seedAppointment({
      tenantId: harness.a.tenant.id,
      staffId: harness.a.staffId,
      serviceId: harness.a.serviceId,
      clientId: sharedClientId,
      startsAt: past,
      endsAt: new Date(past.getTime() + HOUR_MS),
      status: 'COMPLETED',
    }).id;

    inAOtherClient = harness.appointments.seedAppointment({
      tenantId: harness.a.tenant.id,
      staffId: harness.a.staffId,
      serviceId: harness.a.serviceId,
      clientId: otherClientId,
      startsAt: new Date(future.getTime() + 2 * HOUR_MS),
      endsAt: new Date(future.getTime() + 3 * HOUR_MS),
    }).id;

    inB = harness.appointments.seedAppointment({
      tenantId: harness.b.tenant.id,
      staffId: harness.b.staffId,
      serviceId: harness.b.serviceId,
      // Le même identifiant de cliente que chez A — voir `sharedClientId`.
      clientId: sharedClientId,
      startsAt: future,
      endsAt: new Date(future.getTime() + HOUR_MS),
    }).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Un porteur signé pour cette cliente-**là**, dans cet établissement-**là**. */
  async function bearer(
    userId: string,
    tenant: TenantFixture,
    role: UserRole = 'CLIENT',
  ): Promise<string> {
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId, tenantId: tenant.id, role });
    return `Bearer ${token}`;
  }

  it('ne rend que les rendez-vous de l’établissement du jeton', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', await bearer(sharedClientId, harness.a.tenant))
      .expect(200);

    // Égalité d'ensemble, et non simple absence : une liste vide satisferait
    // « aucun identifiant du voisin » sans rien prouver du filtrage.
    expectListScopedTo(response.body, { ownIds: [inA], foreignIds: [inB, inAOtherClient] });
  });

  it('le même identifiant de cliente ne lit chez B que les lignes de B', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', await bearer(sharedClientId, harness.b.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [inB], foreignIds: [inA, inAPast] });
  });

  it('ne laisse pas une cliente lire l’historique d’une autre du même salon', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', await bearer(otherClientId, harness.a.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [inAOtherClient], foreignIds: [inA, inB] });
  });

  it('n’accepte aucun `clientId` de requête pour viser une autre cliente', async () => {
    // Le `ValidationPipe` global est en `forbidNonWhitelisted` : un champ que le
    // DTO ne déclare pas est refusé en nommant le champ, jamais ignoré en
    // silence — donc jamais interprété comme un filtre.
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming&clientId=${otherClientId}`)
      .set('Authorization', await bearer(sharedClientId, harness.a.tenant))
      .expect(400);

    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body)).not.toContain(inAOtherClient);
  });

  it('n’expose jamais le `tenantId` dans la réponse', async () => {
    // C'est une information interne : elle n'apporte rien au consommateur et
    // invite aux essais (tenant-isolation §4).
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=past`)
      .set('Authorization', await bearer(sharedClientId, harness.a.tenant))
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(harness.a.tenant.id);
    expect(serialized).not.toContain(harness.b.tenant.id);
  });

  it('ne laisse pas un `STAFF` du voisin lire l’historique d’une cliente de A', async () => {
    // Le rang le plus élevé ne traverse pas davantage : la frontière n'est pas
    // une question de droits, c'est une question de portée. Et la route rend
    // l'historique **de son porteur**, jamais celui d'un tiers : un jeton `ADMIN`
    // de B n'y lit que les rendez-vous dont il est lui-même la cliente.
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', await bearer(sharedClientId, harness.b.tenant, 'ADMIN'))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [inB], foreignIds: [inA, inAOtherClient] });
  });

  it('refuse la lecture sans jeton', async () => {
    const response = await request(harness.server()).get(MINE_PATH).expect(401);

    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('rend bien quelque chose au porteur légitime — la contrepartie', async () => {
    // Sans ce cas, un refus systématique — une route cassée, un filtre trop
    // large — ferait verdir toute cette suite sans rien garantir.
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=past`)
      .set('Authorization', await bearer(sharedClientId, harness.a.tenant))
      .expect(200);

    expectListScopedTo(response.body, { ownIds: [inAPast], foreignIds: [inA, inB] });
  });
});
