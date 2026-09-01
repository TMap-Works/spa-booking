import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { TokenService } from '../src/modules/identity/token.service';
import {
  BUFFER_AFTER_MINUTES,
  BUFFER_BEFORE_MINUTES,
  SERVICE_DURATION_MINUTES,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';

/**
 * `GET /api/v1/appointments/mine` — l'historique de la cliente connectée (#47,
 * deuxième critère).
 *
 * Ce que cette suite exerce, et que les tests unitaires ne peuvent pas prouver :
 * la route est **servie**, le DTO de requête est appliqué, et la réponse porte
 * l'intervalle **facturé** et non l'intervalle occupé qui est en base.
 *
 * La frontière inter-tenant, elle, a sa propre suite
 * (`appointments-mine.isolation-spec.ts`).
 */

const MINE_PATH = '/api/v1/appointments/mine';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** L'intervalle **occupé** d'un soin qui commence à `billedStart`. */
function occupied(billedStart: Date): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(billedStart.getTime() - BUFFER_BEFORE_MINUTES * MINUTE_MS),
    endsAt: new Date(
      billedStart.getTime() + (SERVICE_DURATION_MINUTES + BUFFER_AFTER_MINUTES) * MINUTE_MS,
    ),
  };
}

describe('GET /api/v1/appointments/mine', () => {
  let harness: AppointmentsHarness;
  const clientId = randomUUID();

  let demain: string;
  let apresDemain: string;
  let hier: string;
  let annuleFutur: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();

    const seed = (billedStart: Date, status?: 'CANCELLED' | 'COMPLETED'): string =>
      harness.appointments.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staffId,
        serviceId: harness.a.serviceId,
        clientId,
        ...occupied(billedStart),
        ...(status === undefined ? {} : { status }),
      }).id;

    apresDemain = seed(new Date(Date.now() + 2 * DAY_MS));
    demain = seed(new Date(Date.now() + 1 * DAY_MS));
    hier = seed(new Date(Date.now() - 1 * DAY_MS), 'COMPLETED');
    // Le cas qui distingue « à venir » d'un simple filtre de temps : un
    // rendez-vous annulé pour dans trois jours n'a plus rien à honorer, et doit
    // donc descendre dans l'historique plutôt que disparaître des deux moitiés.
    annuleFutur = seed(new Date(Date.now() + 3 * DAY_MS), 'CANCELLED');
  });

  afterEach(async () => {
    await harness.close();
  });

  const bearer = async (): Promise<string> => {
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId: clientId, tenantId: harness.a.tenant.id, role: 'CLIENT' });
    return `Bearer ${token}`;
  };

  const ids = (body: unknown): string[] =>
    (body as ReadonlyArray<{ id: string }>).map((row) => row.id);

  it('rend « à venir » du plus proche au plus lointain', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', await bearer())
      .expect(200);

    expect(ids(response.body)).toEqual([demain, apresDemain]);
  });

  it('rend « passés » du plus récent au plus ancien, annulations comprises', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=past`)
      .set('Authorization', await bearer())
      .expect(200);

    // L'annulé de dans trois jours est dans l'historique, et il y est **avant**
    // celui d'hier : l'ordre est décroissant sur l'instant, pas sur le passé.
    expect(ids(response.body)).toEqual([annuleFutur, hier]);
  });

  it('les deux moitiés sont disjointes et couvrent tout', async () => {
    const authorization = await bearer();
    const upcoming = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming`)
      .set('Authorization', authorization)
      .expect(200);
    const past = await request(harness.server())
      .get(`${MINE_PATH}?scope=past`)
      .set('Authorization', authorization)
      .expect(200);

    const all = [...ids(upcoming.body), ...ids(past.body)].sort();
    // Aucun rendez-vous ne peut disparaître de l'espace client : c'est la
    // propriété qui fait de « à venir » et « passés » deux moitiés et non deux
    // filtres indépendants.
    expect(all).toEqual([apresDemain, demain, hier, annuleFutur].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('sert « à venir » par défaut, sans paramètre', async () => {
    const response = await request(harness.server())
      .get(MINE_PATH)
      .set('Authorization', await bearer())
      .expect(200);

    expect(ids(response.body)).toEqual([demain, apresDemain]);
  });

  it('rend l’intervalle **facturé**, pas l’intervalle occupé', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming&limit=1`)
      .set('Authorization', await bearer())
      .expect(200);

    const [first] = response.body as ReadonlyArray<{ startsAt: string; endsAt: string }>;
    expect(first).toBeDefined();

    const duration =
      (Date.parse(first?.endsAt ?? '') - Date.parse(first?.startsAt ?? '')) / MINUTE_MS;
    // La durée du soin, tampons exclus : la cliente n'a pas à connaître la
    // cadence interne du salon.
    expect(duration).toBe(SERVICE_DURATION_MINUTES);
  });

  it('borne la liste au `limit` demandé', async () => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=upcoming&limit=1`)
      .set('Authorization', await bearer())
      .expect(200);

    expect(ids(response.body)).toEqual([demain]);
  });

  it.each([
    ['scope inconnu', 'scope=hier'],
    ['limit non entier', 'limit=deux'],
    ['limit nul', 'limit=0'],
    ['limit au-dessus du plafond', 'limit=101'],
    ['champ non déclaré', 'clientId=00000000-0000-4000-8000-000000000000'],
  ])('refuse en 400 : %s', async (_label, query) => {
    const response = await request(harness.server())
      .get(`${MINE_PATH}?${query}`)
      .set('Authorization', await bearer())
      .expect(400);

    // La forme d'erreur du contrat, que le front lit sur `code`.
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(response.body).toHaveProperty('message');
    expect(response.body).toHaveProperty('details');
  });

  it('rend une liste vide plutôt qu’un 404 pour un compte sans rendez-vous', async () => {
    // Un historique vide est le cas normal d'un compte qui vient d'être créé :
    // le front affiche un état vide, il n'a pas d'erreur à traiter.
    const token = await harness.app
      .get(TokenService)
      .signAccessToken({ userId: randomUUID(), tenantId: harness.a.tenant.id, role: 'CLIENT' });

    const response = await request(harness.server())
      .get(MINE_PATH)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual([]);
  });

  it('n’expose ni le motif d’annulation ni la note interne du salon', async () => {
    // `AppointmentView` est la sortie unique du module et ne les porte pas : un
    // motif écrit par un praticien est une note interne (#40).
    const response = await request(harness.server())
      .get(`${MINE_PATH}?scope=past`)
      .set('Authorization', await bearer())
      .expect(200);

    const [first] = response.body as ReadonlyArray<Record<string, unknown>>;
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'cancelledAt',
      'cancelledBy',
      'clientId',
      'clientNote',
      'endsAt',
      'id',
      'price',
      'rescheduledFromId',
      'serviceId',
      'staffId',
      'startsAt',
      'status',
    ]);
  });
});
