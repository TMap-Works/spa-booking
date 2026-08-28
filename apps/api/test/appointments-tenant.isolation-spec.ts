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
 * Cinq croisements sont exercés, et chacun doit échouer sans rien apprendre :
 *
 * 1. la prestation de A, demandée sous le slug de B → **404**, jamais 403 ;
 * 2. la prestation de B, demandée sous le slug de A → **404** ;
 * 3. le praticien de B, demandé sous le slug de A → **409**, indistinct d'un
 *    créneau pris ;
 * 4. la fiche cliente : la même adresse e-mail dans les deux salons donne
 *    **deux** fiches, jamais une partagée ;
 * 5. **sans praticien demandé** — l'option « premier disponible » (#36) : c'est
 *    le serveur qui choisit, et son choix ne doit jamais tomber sur un praticien
 *    du voisin. Aucun identifiant fautif ne traverse alors l'API : la fuite
 *    serait dans la décision elle-même.
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

  /**
   * L'option « premier disponible » ouvre une **cinquième** traversée possible, et
   * c'est la seule que ce ticket ajoute (#36).
   *
   * Toutes les autres supposent un identifiant soumis par l'appelant, qu'on peut
   * refuser. Ici, l'appelant n'en soumet aucun : c'est le **serveur** qui choisit
   * le praticien. Un choix fait sur une liste mal filtrée affecterait un praticien
   * du voisin sans qu'aucun `staffId` fautif n'ait jamais traversé l'API — la
   * fuite serait dans notre propre décision, et aucun refus ne pourrait la
   * rattraper.
   */
  describe('option « premier disponible » — le serveur choisit', () => {
    it('n’affecte jamais un praticien du voisin quand aucun n’est désigné', async () => {
      // Le voisin a lui aussi des praticiens libres à cet instant : c'est ce qui
      // rend le test capable d'échouer. Une liste de candidats non scopée les
      // ferait apparaître, et l'ordre `(instant, praticien)` pourrait en placer
      // un en tête.
      const neighbours = new Set([harness.b.staffId, harness.addStaff(harness.b)]);

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({
          serviceId: harness.a.serviceId,
          startsAt: slot.startsAt.toISOString(),
          client: GUEST,
        });

      expect(response.status).toBe(201);
      expect(neighbours.has(response.body.staffId)).toBe(false);
      expect(response.body.staffId).toBe(harness.a.staffId);

      const written = harness.appointments.appointments;
      expect(written).toHaveLength(1);
      expect(written[0]?.tenantId).toBe(harness.a.tenant.id);
      expect(JSON.stringify(response.body)).not.toContain(harness.b.tenant.id);
    });

    it('ne réserve rien chez A quand la prestation du voisin est demandée sans praticien', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({
          serviceId: harness.b.serviceId,
          startsAt: slot.startsAt.toISOString(),
          client: GUEST,
        });

      // 404 : la prestation du voisin est introuvable d'ici. Sans `staffId` à
      // refuser, c'est le seul contrôle qui reste — et il suffit.
      expect(response.status).toBe(404);
      expect(harness.appointments.appointments).toHaveLength(0);
      expect(JSON.stringify(response.body)).not.toContain(harness.b.serviceId);
    });
  });
});

/**
 * Fuite inter-tenant sur le **report** — tenant-isolation §6, appliqué à
 * `POST /api/v1/public/:tenantSlug/appointments/:appointmentId/reschedule` (#39).
 *
 * Cette route-ci, contrairement à la réservation, **désigne une ressource** : le
 * protocole canonique s'y applique donc dans sa forme normale — créer chez A,
 * demander sous le slug de B, exiger **404**, jamais 403 et jamais la donnée.
 *
 * Ce qui est en jeu est plus grave qu'une lecture : un report réussi
 * franchissant la frontière **annulerait** le rendez-vous d'un salon voisin. Le
 * test vérifie donc aussi qu'après le refus, la ligne du voisin n'a pas bougé.
 */
describe('Isolation inter-tenant — report de rendez-vous', () => {
  let harness: AppointmentsHarness;
  let from: ReturnType<typeof bookableSlot>;
  let to: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    from = bookableSlot();
    to = bookableSlot(14);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Réserve dans l'établissement A et rend l'identifiant obtenu. */
  async function bookInA(): Promise<string> {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: from.startsAt.toISOString(),
        client: GUEST,
      });

    expect(response.status).toBe(201);
    return String(response.body.id);
  }

  it('refuse en 404 le rendez-vous de A demandé sous le slug de B', async () => {
    const inA = await bookInA();

    const response = await request(harness.server())
      .post(`${BOOKING_PATH(harness.b.tenant.slug)}/${inA}/reschedule`)
      .send({ startsAt: to.startsAt.toISOString() });

    // 404 et non 403 : un 403 confirmerait que ce rendez-vous existe ailleurs.
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(response.body)).not.toContain(harness.a.tenant.id);
    expect(JSON.stringify(response.body)).not.toContain(inA);
  });

  it('laisse intact le rendez-vous du voisin après un report refusé', async () => {
    const inA = await bookInA();

    await request(harness.server())
      .post(`${BOOKING_PATH(harness.b.tenant.slug)}/${inA}/reschedule`)
      .send({ startsAt: to.startsAt.toISOString() });

    // Un report qui aurait franchi la frontière aurait **annulé** ce
    // rendez-vous : c'est une écriture, pas une lecture.
    const kept = harness.appointments.appointments.find((row) => row.id === inA);
    expect(kept?.status).toBe('PENDING');
    expect(harness.appointments.appointments).toHaveLength(1);
  });

  it('refuse en 409 le praticien de B comme destination d’un report chez A', async () => {
    const inA = await bookInA();

    const response = await request(harness.server())
      .post(`${BOOKING_PATH(harness.a.tenant.slug)}/${inA}/reschedule`)
      .send({ startsAt: to.startsAt.toISOString(), staffId: harness.b.staffId });

    // Le praticien du voisin ne produit aucun créneau ici : le même 409 qu'un
    // créneau pris, indistinct — la route ne sert pas de sonde d'existence.
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    // Et rien n'a bougé : le rendez-vous d'origine occupe toujours son créneau.
    expect(harness.appointments.appointments).toHaveLength(1);
    expect(harness.appointments.appointments[0]?.status).toBe('PENDING');
  });

  it('n’écrit rien chez le voisin quand le report aboutit', async () => {
    const inA = await bookInA();

    const response = await request(harness.server())
      .post(`${BOOKING_PATH(harness.a.tenant.slug)}/${inA}/reschedule`)
      .send({ startsAt: to.startsAt.toISOString() });

    expect(response.status).toBe(201);
    expect(
      harness.appointments.appointments.filter((row) => row.tenantId === harness.b.tenant.id),
    ).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain(harness.b.tenant.id);
  });
});
