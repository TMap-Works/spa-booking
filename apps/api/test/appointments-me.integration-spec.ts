import request from 'supertest';

import {
  AFTERNOON_END_MINUTE,
  AFTERNOON_START_MINUTE,
  BUFFER_BEFORE_MINUTES,
  CLOSED_WEEKDAY,
  MORNING_END_MINUTE,
  MORNING_START_MINUTE,
  SERVICE_DURATION_MINUTES,
  TENANT_TIMEZONE,
  WORKING_WEEKDAY,
  calendarDate,
  createMyStaffHarness,
  nextWeekday,
  occupied,
  type MyStaffHarness,
} from './appointments-me.harness';

/**
 * `GET /api/v1/me/*` — l'espace du praticien connecté (#811).
 *
 * Ce que cette suite exerce, et que les tests unitaires ne peuvent pas prouver :
 *
 * 1. les trois routes sont **servies**. C'est la panne que la CI ne voit pas :
 *    un contrôleur absent des `controllers` de son module compile, passe ses
 *    tests unitaires, et rend `404 Cannot GET` en vrai ;
 * 2. le **périmètre ne se choisit pas** — un `?staffId=` sort en 400 comme champ
 *    inconnu, ce qui est le quatrième critère du ticket ;
 * 3. la **garde** tient : `STAFF` au minimum, jamais le parcours client ;
 * 4. la réponse porte l'intervalle **facturé**, l'offset du salon, et la cliente
 *    réduite à son prénom et à l'initiale de son nom.
 *
 * La frontière — entre établissements comme entre collègues — a sa propre suite
 * (`appointments-me.isolation-spec.ts`).
 */

const PROFILE_PATH = '/api/v1/me/staff-profile';
const AGENDA_PATH = '/api/v1/me/appointments';
const SCHEDULE_PATH = '/api/v1/me/schedule';

interface MyAgendaRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly utcOffsetMinutes: number;
  readonly service: { readonly id: string; readonly name: string; readonly durationMinutes: number };
  readonly client: { readonly firstName: string; readonly lastInitial: string };
  readonly clientNote?: string;
  readonly staffNote?: string;
}

interface MyAgendaBody {
  readonly staffId: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly appointments: readonly MyAgendaRow[];
}

interface MyScheduleBody {
  readonly staffId: string;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly entries: readonly { weekday: number; startsAt: string; endsAt: string }[];
  readonly timeOff: readonly { id: string; staffId: string; reason: string | null }[];
  readonly closedWeekdays: readonly number[];
}

describe('GET /api/v1/me/*', () => {
  let harness: MyStaffHarness;
  /** La cliente du rendez-vous semé — son nom sert l'assertion d'initiale. */
  let clientId: string;

  /** Le prochain mardi, dix heures — le jour où le praticien travaille. */
  const billed = nextWeekday(WORKING_WEEKDAY, 10);
  const day = calendarDate(billed);

  beforeAll(async () => {
    harness = await createMyStaffHarness();

    clientId = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      firstName: 'Camille',
      lastName: 'durand',
      email: 'camille@example.test',
    }).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('GET /me/staff-profile', () => {
    it('rend la fiche du compte connecté', async () => {
      const response = await request(harness.server())
        .get(PROFILE_PATH)
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      expect(response.body).toEqual({
        id: harness.a.staff.staffId,
        displayName: harness.a.staff.displayName,
        isActive: true,
      });
      // `bio` est **absente** et non `null` : `staffMemberSchema` la déclare
      // `.optional()`, et un `null` explicite y ferait échouer la fiche entière.
      expect(response.body).not.toHaveProperty('bio');
      // Le compte ne ressort jamais de la fiche — il y est entré, il n'en sort pas.
      expect(response.body).not.toHaveProperty('userId');
      expect(response.body).not.toHaveProperty('tenantId');
    });

    it('rend 404 STAFF_PROFILE_NOT_FOUND à un compte sans fiche', async () => {
      const response = await request(harness.server())
        .get(PROFILE_PATH)
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'MANAGER'),
        )
        .expect(404);

      expect(response.body).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    });

    it('refuse un jeton absent', async () => {
      await request(harness.server()).get(PROFILE_PATH).expect(401);
    });

    it('refuse un compte client', async () => {
      await request(harness.server())
        .get(PROFILE_PATH)
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'CLIENT'),
        )
        .expect(403);
    });
  });

  describe('GET /me/appointments', () => {
    it('rend le soin, son offset et la cliente réduite à son initiale', async () => {
      const seeded = harness.appointments.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staff.staffId,
        serviceId: harness.a.serviceId,
        clientId,
        status: 'CONFIRMED',
        clientNote: 'Allergie aux huiles d’amande',
        staffNote: 'Prévoir la cabine du fond',
        ...occupied(billed),
        display: {
          serviceName: 'Massage 60 min',
          serviceDurationMinutes: SERVICE_DURATION_MINUTES,
          serviceBufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
        },
      });

      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      const body = response.body as MyAgendaBody;

      expect(body.staffId).toBe(harness.a.staff.staffId);
      expect(body.timezone).toBe(TENANT_TIMEZONE);
      expect(body).toMatchObject({ from: day, to: day });
      expect(body.appointments).toHaveLength(1);

      const row = body.appointments[0] as MyAgendaRow;

      expect(row.id).toBe(seeded.id);
      expect(row.reference).toBe(seeded.reference);
      expect(row.status).toBe('CONFIRMED');
      // L'heure du **soin**, jamais celle de la cabine : la ligne est occupée
      // dix minutes plus tôt, et c'est délibérément invisible ici.
      expect(row.startsAt).toBe(billed.toISOString());
      expect(row.endsAt).toBe(
        new Date(billed.getTime() + SERVICE_DURATION_MINUTES * 60_000).toISOString(),
      );
      expect(row.utcOffsetMinutes).toBe(0);
      expect(row.service).toEqual({
        id: harness.a.serviceId,
        name: 'Massage 60 min',
        durationMinutes: SERVICE_DURATION_MINUTES,
      });
      // Prénom et **initiale**, en capitale : le nom semé est en minuscules.
      expect(row.client).toEqual({ firstName: 'Camille', lastInitial: 'D' });
      expect(row.clientNote).toBe('Allergie aux huiles d’amande');
      expect(row.staffNote).toBe('Prévoir la cabine du fond');
      // Ce qu'un planning ne montre pas, et que l'agenda du comptoir montre :
      expect(row).not.toHaveProperty('price');
      expect(row).not.toHaveProperty('staff');
      expect(row).not.toHaveProperty('dataConsentAt');
    });

    it('sert la journée courante du salon quand aucune borne n’est donnée', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      const body = response.body as MyAgendaBody;
      const today = calendarDate(new Date());

      expect(body).toMatchObject({ from: today, to: today });
    });

    it('refuse un staffId en paramètre — le périmètre ne se choisit pas', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ staffId: harness.a.colleague.staffId })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('refuse un tenantId en paramètre, par la même porte', async () => {
      await request(harness.server())
        .get(AGENDA_PATH)
        .query({ tenantId: harness.b.tenant.id })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(400);
    });

    it('refuse une fenêtre plus large que trente et un jours', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: '2026-01-01', to: '2026-03-01' })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(422);

      expect(response.body).toMatchObject({ code: 'APPOINTMENT_RANGE_TOO_WIDE' });
    });

    it('rend 404 à un compte sans fiche, avant même de juger la fenêtre', async () => {
      const response = await request(harness.server())
        .get(AGENDA_PATH)
        .query({ from: '2026-01-01', to: '2026-03-01' })
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'MANAGER'),
        )
        .expect(404);

      expect(response.body).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    });
  });

  describe('GET /me/schedule', () => {
    it('rend les horaires, les absences et les jours de fermeture', async () => {
      const absence = await harness.seedTimeOff({
        tenant: harness.a.tenant,
        staffId: harness.a.staff.staffId,
        startsAt: new Date(billed.getTime() - 3_600_000),
        endsAt: new Date(billed.getTime() + 7_200_000),
        reason: 'Formation',
      });

      const response = await request(harness.server())
        .get(SCHEDULE_PATH)
        .query({ from: day, to: day })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      const body = response.body as MyScheduleBody;

      expect(body.staffId).toBe(harness.a.staff.staffId);
      expect(body.timezone).toBe(TENANT_TIMEZONE);
      // Les plages sont **récurrentes** : rendues telles quelles, en heures
      // murales, et non déployées sur les jours de la fenêtre.
      expect(body.entries).toEqual([
        { weekday: WORKING_WEEKDAY, startsAt: minutesToWall(MORNING_START_MINUTE), endsAt: minutesToWall(MORNING_END_MINUTE) },
        {
          weekday: WORKING_WEEKDAY,
          startsAt: minutesToWall(AFTERNOON_START_MINUTE),
          endsAt: minutesToWall(AFTERNOON_END_MINUTE),
        },
      ]);
      expect(body.timeOff).toHaveLength(1);
      expect(body.timeOff[0]).toMatchObject({
        id: absence.id,
        staffId: harness.a.staff.staffId,
        reason: 'Formation',
      });
      expect(body.closedWeekdays).toEqual([CLOSED_WEEKDAY]);
    });

    it('n’expose pas les absences hors de la fenêtre demandée', async () => {
      const far = calendarDate(new Date(billed.getTime() + 20 * 86_400_000));

      const response = await request(harness.server())
        .get(SCHEDULE_PATH)
        .query({ from: far, to: far })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(200);

      expect((response.body as MyScheduleBody).timeOff).toHaveLength(0);
    });

    it('refuse un staffId en paramètre', async () => {
      await request(harness.server())
        .get(SCHEDULE_PATH)
        .query({ staffId: harness.a.colleague.staffId })
        .set('Authorization', await harness.bearerFor(harness.a.staff.userId, harness.a.tenant))
        .expect(400);
    });

    it('rend 404 à un compte sans fiche', async () => {
      const response = await request(harness.server())
        .get(SCHEDULE_PATH)
        .set(
          'Authorization',
          await harness.bearerFor(harness.a.accountWithoutProfile, harness.a.tenant, 'MANAGER'),
        )
        .expect(404);

      expect(response.body).toMatchObject({ code: 'STAFF_PROFILE_NOT_FOUND' });
    });
  });
});

/** `540` → `09:00` — l'heure murale que le service rend. */
function minutesToWall(minutes: number): string {
  const hours = Math.floor(minutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
