import request from 'supertest';

import {
  BUFFER_BEFORE_MINUTES,
  SERVICE_DURATION_MINUTES,
  WORKING_WEEKDAY,
  calendarDate,
  createMyStaffHarness,
  nextWeekday,
  occupied,
  type MyStaffHarness,
} from './appointments-me.harness';

/**
 * Les trois frontières de l'espace praticien — `GET /api/v1/me/*` (#811,
 * cinquième critère).
 *
 * Elles ne sont pas de même nature, et c'est pour cela qu'elles sont réunies :
 *
 * | Frontière | Ce qui la tient |
 * |---|---|
 * | entre **établissements** | l'extension Prisma : la fiche du voisin est introuvable, pas interdite |
 * | entre **collègues** | la dérivation : le `staffId` vient de `(tenantId, userId)`, jamais d'un paramètre |
 * | entre **comptes avec et sans fiche** | `STAFF_PROFILE_NOT_FOUND`, un 404 et non un 403 |
 *
 * ## Ce qui rend cette suite sévère
 *
 * Chaque cas de traversée est doublé d'un **cas de contrôle** : la même lecture
 * faite par le bon compte doit, elle, rendre la ligne. Sans lui, une suite de
 * fuite verdit aussi bien sur une isolation correcte que sur une route qui ne
 * rend jamais rien — et c'est le mode de défaillance le plus courant de ce genre
 * de test.
 *
 * Aucun de ces refus n'est un 403 : un 403 confirmerait l'existence de ce qu'on
 * vise (tenant-isolation §4).
 */

const PROFILE_PATH = '/api/v1/me/staff-profile';
const AGENDA_PATH = '/api/v1/me/appointments';
const SCHEDULE_PATH = '/api/v1/me/schedule';

interface AgendaBody {
  readonly staffId: string;
  readonly appointments: readonly { readonly id: string }[];
}

describe('frontières de GET /api/v1/me/*', () => {
  let harness: MyStaffHarness;

  const billed = nextWeekday(WORKING_WEEKDAY, 10);
  const day = calendarDate(billed);

  /** Le rendez-vous du praticien de A — celui que lui seul doit voir. */
  let mine: { id: string };
  /** Celui de son collègue, dans le même salon. */
  let colleagues: { id: string };
  /** Celui du praticien du salon voisin. */
  let neighbours: { id: string };

  const seedFor = (
    tenantId: string,
    staffId: string,
    serviceId: string,
    hourUtc: number,
  ): { id: string } => {
    const start = new Date(billed.getTime() + (hourUtc - 10) * 3_600_000);

    return harness.appointments.seedAppointment({
      tenantId,
      staffId,
      serviceId,
      status: 'CONFIRMED',
      ...occupied(start),
      display: {
        serviceDurationMinutes: SERVICE_DURATION_MINUTES,
        serviceBufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
      },
    });
  };

  beforeAll(async () => {
    harness = await createMyStaffHarness();

    mine = seedFor(harness.a.tenant.id, harness.a.staff.staffId, harness.a.serviceId, 10);
    colleagues = seedFor(harness.a.tenant.id, harness.a.colleague.staffId, harness.a.serviceId, 11);
    neighbours = seedFor(harness.b.tenant.id, harness.b.staff.staffId, harness.b.serviceId, 10);

    await harness.seedTimeOff({
      tenant: harness.b.tenant,
      staffId: harness.b.staff.staffId,
      startsAt: new Date(billed.getTime() - 3_600_000),
      endsAt: new Date(billed.getTime() + 3_600_000),
      reason: 'Absence du voisin',
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('un praticien du salon B ne voit rien du salon A', () => {
    it('ne rend, sur son agenda, que ses propres lignes', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.b.staff.userId, harness.b.tenant))
        .expect(200);

      const body = response.body as AgendaBody;

      expect(body.staffId).toBe(harness.b.staff.staffId);
      expect(body.appointments.map((row) => row.id)).toEqual([neighbours.id]);
    });

    it('rend 404 quand son compte est présenté sur la portée du salon A', async () => {
      // Le cas structurel : un jeton **signé sur A** portant le compte d'un
      // praticien de B. La fiche est cherchée à `(tenantId = A, userId = B)`, et
      // il n'y en a pas — 404, jamais la fiche de B, jamais un 403.
      const response = await request(harness.server())
        .get(PROFILE_PATH)
        .set('Authorization', await harness.bearerFor(harness.b.staff.userId, harness.a.tenant))
        .expect(404);

      expect(response.body).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    });

    it('ne voit pas l’absence du praticien voisin sur son propre planning', async () => {
      const response = await request(harness.server())
        .get(SCHEDULE_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      expect((response.body as { timeOff: unknown[] }).timeOff).toHaveLength(0);
    });

    it('cas de contrôle : le praticien de B voit bien sa propre absence', async () => {
      const response = await request(harness.server())
        .get(SCHEDULE_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.b.staff.userId, harness.b.tenant))
        .expect(200);

      expect((response.body as { timeOff: { reason: string }[] }).timeOff).toHaveLength(1);
    });
  });

  describe('un praticien ne voit pas les rendez-vous d’un collègue', () => {
    it('ne rend que ses propres lignes, jamais celles du collègue', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      const body = response.body as AgendaBody;

      expect(body.staffId).toBe(harness.a.staff.staffId);
      expect(body.appointments.map((row) => row.id)).toEqual([mine.id]);
      expect(body.appointments.map((row) => row.id)).not.toContain(colleagues.id);
    });

    it('cas de contrôle : le collègue voit la ligne que le premier ne voit pas', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.a.colleague.userId, harness.a.tenant))
        .expect(200);

      const body = response.body as AgendaBody;

      expect(body.staffId).toBe(harness.a.colleague.staffId);
      expect(body.appointments.map((row) => row.id)).toEqual([colleagues.id]);
    });

    it('un staffId de collègue passé en paramètre est refusé, pas honoré', async () => {
      // 400 et non « liste du collègue » : le champ est inconnu du schéma
      // `.strict()`, et il l'est *avant* que quoi que ce soit ne soit lu.
      await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: day, to: day, staffId: harness.a.colleague.staffId })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(400);
    });
  });

  describe('un compte MANAGER sans fiche praticien reçoit 404', () => {
    it.each([PROFILE_PATH, AGENDA_PATH, SCHEDULE_PATH])('%s rend 404', async (path) => {
      const response = await request(harness.server())
        .get(path)
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'MANAGER'),
        )
        .expect(404);

      expect(response.body).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    });

    it('un ADMIN sans fiche reçoit le même 404 — ce n’est pas une question de rang', async () => {
      await request(harness.server())
        .get(AGENDA_PATH)
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'ADMIN'),
        )
        .expect(404);
    });
  });
});
