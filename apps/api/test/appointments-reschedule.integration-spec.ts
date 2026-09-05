import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { AppointmentCreatedEvent } from '../src/modules/appointments/events/appointment-created.event';
import type { AppointmentRescheduledEvent } from '../src/modules/appointments/events/appointment-rescheduled.event';
import {
  bookableSlot,
  createAppointmentsHarness,
  SERVICE_PRICE_MINOR,
  type AppointmentsHarness,
} from './appointments.harness';

/**
 * `POST /api/v1/public/:tenantSlug/appointments/:appointmentId/reschedule` — le
 * report, exercé en HTTP (#39).
 *
 * L'application est la **vraie** : préfixe, versionnement, `ValidationPipe`
 * global, `DomainExceptionFilter`, et `TenantScopeMiddleware` qui résout le slug
 * d'URL contre la table `tenants`. Ce qui est prouvé ici et nulle part ailleurs :
 *
 * 1. la route est **servie** — un contrôleur oublié dans les `controllers` de son
 *    module compile, passe ses tests unitaires, et rend 404 en vrai ;
 * 2. le report rend **201** et un rendez-vous neuf, lié au précédent par
 *    `rescheduledFromId` — pas 200 sur le même identifiant ;
 * 3. l'ancien rendez-vous est `CANCELLED`, et les deux lignes coexistent : c'est
 *    l'historique que le quatrième critère de #39 demande ;
 * 4. un rendez-vous terminé, annulé ou no-show sort en 422
 *    `INVALID_STATE_TRANSITION` ;
 * 5. un identifiant mal formé sort en 400, un identifiant inconnu en 404 ;
 * 6. l'événement `appointment.rescheduled` part réellement — et
 *    `appointment.created` **ne part pas** ;
 * 7. un créneau d'arrivée qui **chevauche** celui d'origine aboutit (#316), sans
 *    que l'agenda s'ouvre pour autant : un rendez-vous voisin qui recouvre
 *    l'arrivée rend toujours 409.
 *
 * L'isolation inter-tenant a sa suite propre —
 * `appointments-tenant.isolation-spec.ts` ; l'atomicité de la transaction, la
 * sienne contre un vrai PostgreSQL — `appointments-exclusion.integration-spec.ts`.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const RESCHEDULE_PATH = (slug: string, id: string): string =>
  `${BOOKING_PATH(slug)}/${id}/reschedule`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

describe('POST /api/v1/public/:tenantSlug/appointments/:appointmentId/reschedule', () => {
  let harness: AppointmentsHarness;
  /** Le créneau d'origine — 10:00 occupé, donc 10:10 facturé. */
  let from: ReturnType<typeof bookableSlot>;
  /** Le créneau d'arrivée, le même jour, hors de portée du premier. */
  let to: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    from = bookableSlot();
    to = bookableSlot(14);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Réserve le créneau d'origine et rend le rendez-vous obtenu. */
  async function book(): Promise<{ id: string; clientId: string }> {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: from.startsAt.toISOString(),
        client: GUEST,
      });

    expect(response.status).toBe(201);
    return { id: String(response.body.id), clientId: String(response.body.clientId) };
  }

  it('reporte un rendez-vous et rend 201 avec un rendez-vous neuf, lié au précédent', async () => {
    const booked = await book();

    const response = await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
      .send({ startsAt: to.startsAt.toISOString() });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PENDING',
      serviceId: harness.a.serviceId,
      staffId: harness.a.staffId,
      clientId: booked.clientId,
      startsAt: to.startsAt.toISOString(),
      endsAt: to.endsAt.toISOString(),
      rescheduledFromId: booked.id,
      // Le prix reste celui figé à la réservation d'origine.
      price: { amountMinor: SERVICE_PRICE_MINOR, currency: 'EUR' },
    });
    expect(response.body.id).not.toBe(booked.id);
  });

  it('laisse les deux rendez-vous en base, l’ancien annulé', async () => {
    const booked = await book();

    await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
      .send({ startsAt: to.startsAt.toISOString() });

    // Deux lignes, pas une : c'est ce qui distingue un report d'un `UPDATE` des
    // dates, et ce qui fait que l'historique de la cliente montre les deux.
    expect(harness.appointments.appointments).toHaveLength(2);
    const previous = harness.appointments.appointments.find(
      (candidate) => candidate.id === booked.id,
    );
    expect(previous?.status).toBe('CANCELLED');
    const created = harness.appointments.appointments.find(
      (candidate) => candidate.id !== booked.id,
    );
    expect(created?.rescheduledFromId).toBe(booked.id);
  });

  it('enregistre pour le nouveau créneau l’intervalle occupé, tampons compris', async () => {
    const booked = await book();

    await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
      .send({ startsAt: to.startsAt.toISOString() });

    const created = harness.appointments.appointments.find(
      (candidate) => candidate.id !== booked.id,
    );
    // La réponse rend le facturé, la base garde l'occupé — c'est lui que la
    // contrainte d'exclusion compare.
    expect(created?.startsAt.toISOString()).toBe(to.occupiedStartsAt.toISOString());
  });

  it('change de praticien quand la demande en désigne un autre', async () => {
    const booked = await book();
    const other = harness.addStaff(harness.a);

    const response = await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
      .send({ startsAt: to.startsAt.toISOString(), staffId: other });

    expect(response.status).toBe(201);
    expect(response.body.staffId).toBe(other);
  });

  it('refuse en 422 un rendez-vous qui n’occupe plus son créneau', async () => {
    const seeded = harness.appointments.seedAppointment({
      tenantId: harness.a.tenant.id,
      staffId: harness.a.staffId,
      serviceId: harness.a.serviceId,
      startsAt: from.occupiedStartsAt,
      // L'intervalle occupé : soin de soixante minutes, plus les deux tampons.
      endsAt: new Date(from.occupiedStartsAt.getTime() + 80 * 60_000),
      status: 'CANCELLED',
    });

    const response = await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, seeded.id))
      .send({ startsAt: to.startsAt.toISOString() });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('refuse en 409 un instant que le calendrier ne proposait pas', async () => {
    const booked = await book();

    const response = await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
      // Sept minutes après l'ouverture : hors de la grille de quinze minutes.
      .send({ startsAt: new Date(to.startsAt.getTime() + 7 * 60_000).toISOString() });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
  });

  it('refuse en 404 un rendez-vous inconnu', async () => {
    const response = await request(harness.server())
      .post(RESCHEDULE_PATH(harness.a.tenant.slug, randomUUID()))
      .send({ startsAt: to.startsAt.toISOString() });

    expect(response.status).toBe(404);
  });

  /**
   * Le report vers un créneau qui **chevauche** celui d'origine (#316).
   *
   * ## Ce que ces cas exigent du décor, et pourquoi
   *
   * Le moteur de disponibilité lit la table `appointments` ; les deux doubles du
   * harnais, eux, sont deux stocks distincts, et une réservation écrite dans
   * celui des rendez-vous n'apparaît pas dans celui de la disponibilité. Sans
   * `occupy`, le calendrier proposerait le créneau chevauchant **même sans
   * l'exclusion**, et ces cas verdiraient sans rien prouver. Le reflet est donc
   * la condition du test, pas une commodité : il remet le décor dans l'état où
   * la base le mettrait d'elle-même.
   */
  describe('report vers un créneau qui chevauche celui d’origine (#316)', () => {
    /** Soin de soixante minutes, plus les deux tampons de dix. */
    const OCCUPIED_MS = 80 * 60_000;

    /**
     * Le créneau visé : un quart d'heure **plus tard** que celui d'origine.
     *
     * Le sens du décalage n'importe pas au moteur — d'un côté comme de l'autre,
     * l'intervalle d'arrivée recouvre celui de départ, et c'est ce recouvrement
     * que l'exclusion existe pour lever. Le décalage vers l'avant est retenu
     * parce qu'il laisse de la place au rendez-vous voisin du second cas, qui
     * doit occuper l'arrivée sans avoir jamais gêné la réservation d'origine.
     */
    const nudged = (): Date => new Date(from.startsAt.getTime() + 15 * 60_000);

    /**
     * Reflète dans le moteur de disponibilité un rendez-vous du stock des
     * rendez-vous — ce que la base fait d'elle-même, les deux doubles non.
     */
    const occupy = (id: string, occupiedStartsAt: Date): void => {
      harness.availability.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staffId,
        id,
        startsAt: occupiedStartsAt,
        endsAt: new Date(occupiedStartsAt.getTime() + OCCUPIED_MS),
      });
    };

    it('décale d’un quart d’heure un soin d’une heure chez le même praticien', async () => {
      const booked = await book();
      occupy(booked.id, from.occupiedStartsAt);

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: nudged().toISOString() });

      // Le geste le plus courant du comptoir, et un 409 jusqu'à #316.
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        staffId: harness.a.staffId,
        startsAt: nudged().toISOString(),
        rescheduledFromId: booked.id,
      });
    });

    it('refuse encore le même décalage quand un autre rendez-vous occupe l’arrivée', async () => {
      const booked = await book();
      occupy(booked.id, from.occupiedStartsAt);
      // Le rendez-vous suivant, adossé au premier : il ne gênait pas la
      // réservation d'origine, il recouvre l'intervalle d'arrivée. L'exclusion
      // ne porte que sur le rendez-vous déplacé, et lui seul.
      occupy(randomUUID(), new Date(from.occupiedStartsAt.getTime() + OCCUPIED_MS));

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: nudged().toISOString() });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    });

    it('ne réécrit rien quand l’instant demandé est celui que le rendez-vous occupe déjà', async () => {
      const booked = await book();
      occupy(booked.id, from.occupiedStartsAt);
      // Après la réservation : c'est le report seul qu'on observe.
      const moved: AppointmentRescheduledEvent[] = [];
      const off = harness.events.onAppointmentRescheduled((event) => moved.push(event));

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: from.startsAt.toISOString() });
      off();

      // L'exclusion rend ce créneau proposable ; sans garde, le report
      // aboutirait — et la cliente perdrait l'identifiant de sa confirmation
      // pour un geste qui ne la déplace pas.
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        id: booked.id,
        startsAt: from.startsAt.toISOString(),
        rescheduledFromId: null,
      });
      // Une seule ligne, toujours occupante : rien n'a été annulé, rien n'a été
      // créé, et aucun report n'entre dans le reporting du CDC §1.4.
      expect(harness.appointments.appointments).toHaveLength(1);
      expect(harness.appointments.appointments[0]?.status).toBe('PENDING');
      expect(moved).toHaveLength(0);
    });
  });

  describe('validation du corps et du chemin', () => {
    it('refuse en 400 un identifiant de rendez-vous mal formé', async () => {
      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, 'pas-un-uuid'))
        .send({ startsAt: to.startsAt.toISOString() });

      // `ParseUUIDPipe` : la requête ne descend jamais jusqu'au pilote
      // PostgreSQL pour en revenir en 500.
      expect(response.status).toBe(400);
    });

    it('refuse en 400 une date-heure sans offset explicite', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: '2026-09-01T10:00:00' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: expect.any(String), details: expect.any(Object) });
    });

    it('refuse en 400 un corps sans `startsAt`', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({});

      expect(response.status).toBe(400);
    });

    it('rejette un `serviceId` glissé dans le corps', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: to.startsAt.toISOString(), serviceId: harness.b.serviceId });

      // `forbidNonWhitelisted` : reporter ne change pas la prestation, et le
      // champ fait échouer la requête plutôt que d'être ignoré en silence.
      expect(response.status).toBe(400);
      expect(harness.appointments.appointments).toHaveLength(1);
    });

    it('rejette un `price` imposé par le client', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: to.startsAt.toISOString(), price: { amountMinor: 1, currency: 'EUR' } });

      expect(response.status).toBe(400);
    });

    it('rejette un `status` imposé par le client', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: to.startsAt.toISOString(), status: 'CONFIRMED' });

      expect(response.status).toBe(400);
    });
  });

  describe('événement de domaine', () => {
    it('émet `appointment.rescheduled` avec les deux créneaux', async () => {
      const received: AppointmentRescheduledEvent[] = [];
      const off = harness.events.onAppointmentRescheduled((event) => received.push(event));
      const booked = await book();

      const response = await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: to.startsAt.toISOString() });
      off();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        name: 'appointment.rescheduled',
        tenantId: harness.a.tenant.id,
        appointmentId: response.body.id,
        previousAppointmentId: booked.id,
        startsAt: to.startsAt.toISOString(),
        previousStartsAt: from.startsAt.toISOString(),
      });
    });

    it('n’émet pas `appointment.created` sur un report', async () => {
      const booked = await book();
      // Après la réservation : c'est le report seul qu'on observe.
      const created: AppointmentCreatedEvent[] = [];
      const off = harness.events.onAppointmentCreated((event) => created.push(event));

      await request(harness.server())
        .post(RESCHEDULE_PATH(harness.a.tenant.slug, booked.id))
        .send({ startsAt: to.startsAt.toISOString() });
      off();

      expect(created).toHaveLength(0);
    });
  });
});
