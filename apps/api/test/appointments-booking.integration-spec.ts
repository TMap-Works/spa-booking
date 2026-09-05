import request from 'supertest';

import type { AppointmentCreatedEvent } from '../src/modules/appointments/events/appointment-created.event';
import {
  BUFFER_AFTER_MINUTES,
  BUFFER_BEFORE_MINUTES,
  bookableSlot,
  createAppointmentsHarness,
  SERVICE_PRICE_MINOR,
  type AppointmentsHarness,
} from './appointments.harness';

/**
 * `POST /api/v1/public/:tenantSlug/appointments` — la réservation du tunnel
 * public, exercée en HTTP (#37).
 *
 * L'application est la **vraie** : préfixe, versionnement, `ValidationPipe`
 * global, `DomainExceptionFilter`, et `TenantScopeMiddleware` qui résout le slug
 * d'URL contre la table `tenants`. Ce qui est prouvé ici et nulle part ailleurs :
 *
 * 1. la route est **servie** — un contrôleur oublié dans les `controllers` de son
 *    module compile, passe ses tests unitaires, et rend 404 en vrai ;
 * 2. le corps invalide sort en 400 `{ code, message, details }`, la forme
 *    d'erreur de toute l'API ;
 * 3. la durée **enregistrée** inclut les deux tampons, alors que la réponse rend
 *    l'intervalle facturé ;
 * 4. un créneau déjà pris sort en 409 `SLOT_NO_LONGER_AVAILABLE` ;
 * 5. réserver sans compte crée la fiche cliente, et une seule — et un créneau
 *    refusé n'en laisse aucune derrière lui, tandis qu'une adresse portée par un
 *    compte du personnel sort en 409 nommé plutôt qu'en 500 (#313) ;
 * 6. l'événement `appointment.created` part réellement ;
 * 7. le corps rendu porte **exactement** les champs de `bookedAppointmentSchema`
 *    — le contrat partagé décrit ce que cette route sert, et le doublon des deux
 *    descriptions ne dérive pas en silence (#314).
 *
 * L'isolation inter-tenant a sa suite propre — `appointments-tenant.isolation-spec.ts`.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const MINUTE_MS = 60_000;

function guest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: 'Camille',
    lastName: 'Rakoto',
    email: 'camille@example.test',
    phone: '+261 34 12 345 67',
    ...overrides,
  };
}

describe('POST /api/v1/public/:tenantSlug/appointments', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
  });

  afterEach(async () => {
    await harness.close();
  });

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    serviceId: harness.a.serviceId,
    staffId: harness.a.staffId,
    startsAt: slot.startsAt.toISOString(),
    client: guest(),
    ...overrides,
  });

  it('réserve un créneau proposé et rend 201 avec l’intervalle facturé', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      status: 'PENDING',
      serviceId: harness.a.serviceId,
      staffId: harness.a.staffId,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      price: { amountMinor: SERVICE_PRICE_MINOR, currency: 'EUR' },
      clientNote: null,
    });
    // Ni `tenantId`, ni `staffNote` : ce que le `select` ne lit pas ne peut pas
    // franchir la frontière du module par inadvertance.
    expect(response.body).not.toHaveProperty('tenantId');
    expect(response.body).not.toHaveProperty('staffNote');
  });

  /**
   * Le corps servi porte **exactement** les champs de `bookedAppointmentSchema`
   * — `packages/shared/src/schemas/appointment.ts` (#314).
   *
   * C'est le deuxième critère de #314, et le `toMatchObject` ci-dessus ne le
   * prouve pas : il vérifie que les champs attendus sont là, jamais qu'aucun
   * autre ne les accompagne. Or c'est un champ **en trop** qui coûte cher ici —
   * `staffNote`, `tenantId`, l'entité Prisma recopiée d'un geste — et les deux
   * `not.toHaveProperty` ne nomment que les deux fuites déjà connues. La liste
   * exhaustive, elle, rattrape aussi celle que personne n'a encore imaginée.
   *
   * Elle est recopiée du contrat plutôt qu'importée, `apps/api` n'en dépendant
   * pas encore (#26) : c'est le doublon assumé qu'exerce aussi
   * `src/modules/appointments/__tests__/guest-contract.spec.ts`, côté requête.
   */
  it('rend exactement les champs de `bookedAppointmentSchema`, ni plus ni moins', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());

    expect(response.status).toBe(201);
    expect(Object.keys(response.body as Record<string, unknown>).sort()).toEqual([
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
    // `price` est le seul champ composé, et le contrat le veut entier + devise :
    // un flottant nu passerait la liste de clés sans passer le contrat.
    expect(Object.keys(response.body.price as Record<string, unknown>).sort()).toEqual([
      'amountMinor',
      'currency',
    ]);
    expect(Number.isInteger(response.body.price.amountMinor)).toBe(true);
    // `null` et non l'absence : le contrat les déclare `nullable`, et un front
    // qui lit `body.cancelledAt` doit trouver la clé, posée à `null`.
    expect(response.body.clientNote).toBeNull();
    expect(response.body.rescheduledFromId).toBeNull();
    expect(response.body.cancelledAt).toBeNull();
    expect(response.body.cancelledBy).toBeNull();
  });

  it('enregistre l’intervalle occupé, tampons compris', async () => {
    await request(harness.server()).post(BOOKING_PATH(harness.a.tenant.slug)).send(body());

    const stored = harness.appointments.appointments[0];
    expect(stored?.startsAt.getTime()).toBe(
      slot.startsAt.getTime() - BUFFER_BEFORE_MINUTES * MINUTE_MS,
    );
    expect(stored?.endsAt.getTime()).toBe(slot.endsAt.getTime() + BUFFER_AFTER_MINUTES * MINUTE_MS);
    expect(stored?.status).toBe('PENDING');
    expect(stored?.tenantId).toBe(harness.a.tenant.id);
  });

  it('crée la fiche cliente depuis les seules coordonnées, sans compte', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());

    expect(harness.appointments.clients).toHaveLength(1);
    const client = harness.appointments.clients[0];
    expect(client?.email).toBe('camille@example.test');
    expect(client?.tenantId).toBe(harness.a.tenant.id);
    expect(response.body.clientId).toBe(client?.id);
  });

  it('ne crée qu’une fiche pour deux réservations de la même adresse', async () => {
    const second = bookableSlot();
    // Le créneau suivant sur la grille : quinze minutes plus loin, donc sans
    // chevauchement avec l'intervalle occupé du premier (80 min à partir de
    // 10:00 occupé) — on décale d'une heure et demie pour être net.
    const later = new Date(second.startsAt.getTime() + 90 * MINUTE_MS).toISOString();

    await request(harness.server()).post(BOOKING_PATH(harness.a.tenant.slug)).send(body());
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body({ startsAt: later }));

    expect(response.status).toBe(201);
    expect(harness.appointments.clients).toHaveLength(1);
    expect(harness.appointments.appointments).toHaveLength(2);
  });

  it('émet appointment.created', async () => {
    const received: AppointmentCreatedEvent[] = [];
    const off = harness.events.onAppointmentCreated((event) => received.push(event));

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());
    off();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      name: 'appointment.created',
      tenantId: harness.a.tenant.id,
      appointmentId: response.body.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
    });
  });

  it('refuse en 409 SLOT_NO_LONGER_AVAILABLE un créneau déjà pris', async () => {
    const first = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());
    expect(first.status).toBe(201);

    const second = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body({ client: guest({ email: 'autre@example.test' }) }));

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    // `details` ne porte que ce que l'appelant a lui-même envoyé — rien du
    // rendez-vous concurrent, sans quoi la réservation deviendrait une sonde
    // d'agenda.
    expect(second.body.details).toEqual({
      staffId: harness.a.staffId,
      startsAt: slot.startsAt.toISOString(),
    });
    expect(harness.appointments.appointments).toHaveLength(1);
    // La perdante n'a laissé **aucune** fiche : la seule au fichier est celle de
    // la réservation qui a abouti (#313). Avant, la résolution était validée
    // avant l'insertion, et chaque course perdue déposait une fiche publique sans
    // rendez-vous.
    expect(harness.appointments.clients).toHaveLength(1);
    expect(harness.appointments.clients[0]?.email).toBe('camille@example.test');
  });

  it('refuse en 409 CLIENT_EMAIL_NOT_BOOKABLE une adresse de compte du personnel', async () => {
    // La décision produit de #313, vue de l'extérieur : la réservation publique ne
    // s'accroche jamais à un compte `MANAGER`/`ADMIN`, et le refus est un 409
    // nommé — jamais le 500 qu'un `P2002` nu produirait.
    harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'gerante@example.test',
      role: 'MANAGER',
    });

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body({ client: guest({ email: 'gerante@example.test' }) }));

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'CLIENT_EMAIL_NOT_BOOKABLE',
      details: {},
    });
    // Le corps d'erreur ne renvoie pas l'adresse : c'est une donnée personnelle,
    // et celui qui vient de la saisir la connaît déjà (CDC §5.1).
    expect(JSON.stringify(response.body)).not.toContain('gerante@example.test');
    expect(harness.appointments.appointments).toHaveLength(0);
    // Aucune seconde fiche : le compte de la gérante reste seul.
    expect(harness.appointments.clients).toHaveLength(1);
  });

  it('réserve normalement sous une adresse déjà cliente — le refus ne vise que le personnel', async () => {
    // Le pendant du cas précédent, et ce qui borne l'information que le refus
    // laisse deviner : une adresse **cliente** rend 201, exactement comme une
    // adresse inconnue. La route ne dit donc rien du fichier client du salon.
    const known = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'camille@example.test',
    });

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());

    expect(response.status).toBe(201);
    expect(response.body.clientId).toBe(known.id);
    expect(harness.appointments.clients).toHaveLength(1);
  });

  it('refuse en 409 un instant que le calendrier ne propose pas', async () => {
    const offGrid = new Date(slot.startsAt.getTime() + 7 * MINUTE_MS).toISOString();

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body({ startsAt: offGrid }));

    expect(response.status).toBe(409);
    expect(harness.appointments.appointments).toHaveLength(0);
    expect(harness.appointments.clients).toHaveLength(0);
  });

  it('refuse en 404 une prestation retirée du catalogue', async () => {
    const service = harness.catalog.services.find(
      (candidate) => candidate.id === harness.a.serviceId,
    );
    if (service !== undefined) {
      service.isActive = false;
    }

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send(body());

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('borne le débit d’une même adresse, agenda et fichier clients compris', async () => {
    // Onze tirs de suite : le premier réserve, les neuf suivants se heurtent au
    // créneau qu'il vient de prendre — et le onzième ne va même pas jusque-là.
    // Sans quota, ce même script prend tous les créneaux libres du salon en
    // quelques secondes, avec des `PENDING` qui occupent l'agenda dès leur
    // création.
    let last: request.Response | undefined;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      // Séquentiel, et non parallèle : la limitation de débit se compte requête
      // après requête, et un tir groupé ne prouverait pas quel appel a franchi le
      // seuil.
      last = await request(harness.server()).post(BOOKING_PATH(harness.a.tenant.slug)).send(body());
    }

    expect(last?.status).toBe(429);
    expect(harness.appointments.appointments).toHaveLength(1);
  });

  it('refuse en 404 un slug d’établissement inconnu, avant tout code métier', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH('salon-qui-n-existe-pas'))
      .send(body());

    expect(response.status).toBe(404);
    expect(harness.appointments.appointments).toHaveLength(0);
  });

  /**
   * L'option « premier disponible » — en HTTP, avec le **vrai** moteur de
   * disponibilité (#36).
   *
   * Ce que cette suite prouve et que la suite unitaire ne peut pas : que le corps
   * est accepté **sans `staffId`** — la validation le refusait avant ce ticket —
   * et que la liste de candidats vient du moteur réel, dont l'ordre est
   * `(instant, praticien)`. Le double du service, lui, rend la liste qu'on lui
   * donne.
   */
  describe('option « premier disponible » (#36)', () => {
    /** Le corps d'une réservation sans préférence : `staffId` simplement absent. */
    const withoutStaff = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
      const { staffId: _ignored, ...rest } = body(overrides);
      return rest;
    };

    /** Les deux praticiens du salon, dans l'ordre où le moteur les rend. */
    function bothStaff(): [string, string] {
      const second = harness.addStaff(harness.a);
      const ordered = [harness.a.staffId, second].sort((left, right) => left.localeCompare(right));
      return [ordered[0] as string, ordered[1] as string];
    }

    it('accepte un corps sans staffId et affecte le premier praticien de l’ordre du moteur', async () => {
      const [first] = bothStaff();

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(withoutStaff());

      expect(response.status).toBe(201);
      // Le rendez-vous rendu **nomme** le praticien affecté : c'est par lui que
      // la cliente apprend qui l'attend.
      expect(response.body.staffId).toBe(first);
    });

    it('bascule sur l’autre praticien quand le premier vient d’être pris', async () => {
      const [first, second] = bothStaff();

      const taken = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ staffId: first }));
      expect(taken.status).toBe(201);

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(withoutStaff({ client: guest({ email: 'autre@example.test' }) }));

      expect(response.status).toBe(201);
      expect(response.body.staffId).toBe(second);
      expect(harness.appointments.appointments).toHaveLength(2);
    });

    it('refuse en 409 sans nommer de praticien quand tous sont pris', async () => {
      const [first, second] = bothStaff();

      for (const staffId of [first, second]) {
        const taken = await request(harness.server())
          .post(BOOKING_PATH(harness.a.tenant.slug))
          .send(body({ staffId, client: guest({ email: `${staffId}@example.test` }) }));
        expect(taken.status).toBe(201);
      }

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(withoutStaff({ client: guest({ email: 'tard@example.test' }) }));

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
      // `null`, et non le dernier praticien tenté : le corps ne nomme jamais un
      // praticien que l'appelante n'a pas désigné.
      expect(response.body.details).toEqual({
        staffId: null,
        startsAt: slot.startsAt.toISOString(),
      });
      expect(harness.appointments.appointments).toHaveLength(2);
    });

    it('refuse toujours un staffId mal formé plutôt que de le lire comme « pas de préférence »', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ staffId: 'pas-un-uuid' }));

      // Facultatif ne veut pas dire permissif : `OptionalPresent` ne saute la
      // validation que sur un champ **absent**, jamais sur une valeur fautive.
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('validation du corps', () => {
    it('refuse une date-heure sans offset explicite', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ startsAt: '2026-09-01T10:00:00' }));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: expect.any(String), message: expect.any(String) });
      expect(response.body).toHaveProperty('details');
    });

    it('refuse un corps sans coordonnées plutôt que de tomber en 500', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
        });

      expect(response.status).toBe(400);
    });

    it('refuse une adresse e-mail invalide', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ client: guest({ email: 'pas-une-adresse' }) }));

      expect(response.status).toBe(400);
    });

    it('rejette un `tenantId` glissé dans le corps', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ tenantId: harness.b.tenant.id }));

      // `forbidNonWhitelisted` : le champ n'est pas ignoré, il fait échouer la
      // requête. C'est ce qui rend visible une tentative plutôt que de la laisser
      // passer sans effet.
      expect(response.status).toBe(400);
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('rejette un `price` imposé par le client', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ price: { amountMinor: 1, currency: 'EUR' } }));

      expect(response.status).toBe(400);
    });

    it('rejette un `endsAt` imposé par le client', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ endsAt: slot.endsAt.toISOString() }));

      expect(response.status).toBe(400);
    });

    it('canonise l’adresse e-mail avant de chercher la fiche', async () => {
      harness.appointments.seedClient({
        tenantId: harness.a.tenant.id,
        email: 'camille@example.test',
      });

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body({ client: guest({ email: '  Camille@Example.TEST  ' }) }));

      expect(response.status).toBe(201);
      // Une seule fiche : sans canonisation, l'unicité `(tenant_id, email)`
      // porterait sur les octets et une seconde fiche serait née.
      expect(harness.appointments.clients).toHaveLength(1);
    });
  });
});
