import request from 'supertest';

import { bookableSlot, createAppointmentsHarness, type AppointmentsHarness } from './appointments.harness';

/**
 * Fuite inter-tenant sur la réservation publique — tenant-isolation §6, appliqué
 * à `POST /api/v1/public/:tenantSlug/appointments` (#37).
 *
 * ## Ce que ce protocole devient sur une route d'écriture sans identifiant
 *
 * Le protocole canonique — créer chez A, s'authentifier comme B, tenter lecture,
 * modification et suppression *par identifiant*, exiger 404 — suppose des routes
 * qui **désignent** une ressource. Celle-ci n'en désigne aucune : elle en crée
 * une. La traversée n'y prend donc pas la forme « lire la ressource d'un autre »
 * mais celle, plus dangereuse sur une surface **non authentifiée**, d'« écrire
 * dans l'agenda d'un autre » — en mêlant dans un même corps le slug d'un salon
 * et les identifiants d'un autre.
 *
 * Quatre croisements sont exercés, et chacun doit échouer sans rien apprendre :
 *
 * 1. la prestation de A, demandée sous le slug de B → **404**, jamais 403 ;
 * 2. la prestation de B, demandée sous le slug de A → **404** ;
 * 3. le praticien de B, demandé sous le slug de A → **409**, indistinct d'un
 *    créneau pris ;
 * 4. la fiche cliente : la même adresse e-mail dans les deux salons donne
 *    **deux** fiches, jamais une partagée.
 *
 * S'y ajoute ce que le protocole exige toujours : aucune donnée du voisin n'a
 * bougé, et aucun corps de réponse ne porte son identifiant.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

describe('Isolation inter-tenant — réservation publique', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('refuse en 404 la prestation de A demandée sous le slug de B', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.b.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    // 404 et non 403 : un 403 confirmerait que cette prestation existe ailleurs.
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
    expect(JSON.stringify(response.body)).not.toContain(harness.a.serviceId);
    expect(harness.appointments.appointments).toHaveLength(0);
  });

  it('refuse en 404 la prestation de B demandée sous le slug de A', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.b.serviceId,
        staffId: harness.b.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    expect(response.status).toBe(404);
    expect(harness.appointments.appointments).toHaveLength(0);
  });

  it('refuse en 409 le praticien de B sur une prestation de A', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.b.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    // Le praticien du voisin n'est candidat à aucune prestation d'ici : il ne
    // produit aucun créneau, donc le même 409 qu'un créneau pris. Un 404 propre
    // au praticien aurait distingué « inconnu » de « connu ailleurs ».
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    expect(harness.appointments.appointments).toHaveLength(0);
  });

  it('ne partage pas la fiche cliente entre deux établissements', async () => {
    const inA = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });
    const inB = await request(harness.server())
      .post(BOOKING_PATH(harness.b.tenant.slug))
      .send({
        serviceId: harness.b.serviceId,
        staffId: harness.b.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);
    // Deux fiches, une par salon : l'unicité de l'adresse est `(tenant_id,
    // email)`, et une fiche partagée ferait de l'historique d'une cliente une
    // donnée inter-établissement.
    expect(harness.appointments.clients).toHaveLength(2);
    expect(inA.body.clientId).not.toBe(inB.body.clientId);
    expect(harness.appointments.clients.map((client) => client.tenantId).sort()).toEqual(
      [harness.a.tenant.id, harness.b.tenant.id].sort(),
    );
  });

  it('laisse deux établissements réserver le même instant sans se gêner', async () => {
    await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.b.tenant.slug))
      .send({
        serviceId: harness.b.serviceId,
        staffId: harness.b.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    // La frontière du tenant est dans l'index d'exclusion, pas seulement dans
    // les intentions : deux salons différents ne se disputent pas un créneau.
    expect(response.status).toBe(201);
    expect(harness.appointments.appointments).toHaveLength(2);
    expect(harness.appointments.appointments.map((row) => row.tenantId).sort()).toEqual(
      [harness.a.tenant.id, harness.b.tenant.id].sort(),
    );
  });

  it('n’écrit rien chez le voisin quand la réservation aboutit', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
      });

    expect(response.status).toBe(201);
    expect(
      harness.appointments.appointments.filter((row) => row.tenantId === harness.b.tenant.id),
    ).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain(harness.b.tenant.id);
  });
});
