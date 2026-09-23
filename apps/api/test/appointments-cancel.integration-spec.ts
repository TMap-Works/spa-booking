import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { AppointmentCancelledEvent } from '../src/modules/appointments/events/appointment-cancelled.event';
import type { AppointmentCreatedEvent } from '../src/modules/appointments/events/appointment-created.event';
import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import {
  bookableSlot,
  createAppointmentsHarness,
  type AppointmentsHarness,
} from './appointments.harness';

/**
 * L'annulation, exercée en HTTP — les **deux** côtés du comptoir (#40).
 *
 * | Route | Appelant |
 * |---|---|
 * | `POST /api/v1/public/:tenantSlug/appointments/:id/cancel` | la cliente **du rendez-vous**, jeton `CLIENT` (#1135) |
 * | `POST /api/v1/appointments/:id/cancel` | le salon, jeton `STAFF` et au-dessus |
 *
 * L'application est la **vraie** : préfixe, versionnement, `ValidationPipe`
 * global, `DomainExceptionFilter`, gardes d'authentification et de rôles, et
 * `TenantScopeMiddleware` qui résout le slug d'URL contre la table `tenants`. Ce
 * qui est prouvé ici et nulle part ailleurs :
 *
 * 1. les deux routes sont **servies** — un contrôleur oublié dans les
 *    `controllers` de son module compile, passe ses tests unitaires, et rend 404
 *    en vrai ;
 * 2. l'annulation rend **200** et non 201 : rien n'est créé ;
 * 3. `cancelledBy` vient de la **porte** — `CLIENT` d'un côté, `STAFF` de
 *    l'autre — et aucun corps ne peut le contredire ;
 * 4. le motif est **enregistré** et n'est **jamais rendu** ;
 * 5. le créneau libéré se réserve à nouveau, tout de suite, par la route
 *    publique ;
 * 6. la route de back-office est gardée : 401 sans jeton, 403 sous le rang ;
 * 7. la route **publique** l'est aussi depuis #1135 : 401 sans jeton, 403 sur un
 *    jeton de praticien, 404 sur le rendez-vous d'une autre cliente — et aucune
 *    trace `cancelledBy: CLIENT` n'est écrite dans ces trois cas.
 *
 * L'isolation inter-tenant a sa suite propre —
 * `appointments-cancel.isolation-spec.ts` ; la trace en base, la sienne contre un
 * vrai PostgreSQL — `appointments-exclusion.integration-spec.ts` — et la
 * concurrence, la sienne — `appointments-exclusion.concurrency-spec.ts`, jouée
 * par la cible `npm run test:concurrency`.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const PUBLIC_CANCEL_PATH = (slug: string, id: string): string =>
  `${BOOKING_PATH(slug)}/${id}/cancel`;

const DESK_CANCEL_PATH = (id: string): string => `/api/v1/appointments/${id}/cancel`;

const GUEST = {
  firstName: 'Camille',
  lastName: 'Rakoto',
  email: 'camille@example.test',
  phone: '+261 34 12 345 67',
} as const;

/** La borne de `appointments.cancellation_reason` — `VARCHAR(500)`. */
const REASON_MAX_LENGTH = 500;

describe('Annulation d’un rendez-vous — les deux surfaces', () => {
  let harness: AppointmentsHarness;
  let slot: ReturnType<typeof bookableSlot>;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
  });

  afterEach(async () => {
    await harness.close();
  });

  /**
   * Réserve le créneau et rend le rendez-vous obtenu, **avec le porteur de sa
   * cliente** (#1135).
   *
   * L'annulation publique n'est plus ouverte à la seule connaissance de
   * l'identifiant : elle exige le jeton de la cliente du rendez-vous. Le rendre
   * ici, plutôt que le fabriquer dans chaque cas, est ce qui garde ces cas
   * lisibles — ils parlent de la trace, du créneau libéré et du cycle de vie, et
   * la garde a ses propres cas plus bas.
   */
  async function book(): Promise<{ id: string; clientId: string; authorization: string }> {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .send({
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: GUEST,
        dataConsent: true,
      });

    expect(response.status).toBe(201);
    const clientId = String(response.body.clientId);
    return {
      id: String(response.body.id),
      clientId,
      authorization: await bearerFor(clientId, 'CLIENT'),
    };
  }

  /**
   * Un porteur signé par le **vrai** `TokenService`, pour l'établissement du
   * harnais.
   *
   * Le harnais de rendez-vous n'expose pas `bearer` — les suites de #37 et #39
   * n'en avaient pas besoin, toutes leurs routes étant publiques. Le jeton est
   * donc signé ici, par le même service que la connexion réelle : c'est la seule
   * façon d'exercer `JwtAuthGuard` pour ce qu'il fait, lire le `tenantId` d'un
   * jeton *vérifié* et le poser dans le contexte de requête.
   */
  async function bearerFor(userId: string, role: UserRole): Promise<string> {
    const tokens = harness.app.get(TokenService);
    const token = await tokens.signAccessToken({
      userId,
      tenantId: harness.a.tenant.id,
      role,
    });
    return `Bearer ${token}`;
  }

  /** Un porteur de ce rôle, pour un compte quelconque de l'établissement. */
  function bearer(role: UserRole): Promise<string> {
    return bearerFor(randomUUID(), role);
  }

  describe('POST /api/v1/public/:tenantSlug/appointments/:appointmentId/cancel', () => {
    it('annule et rend 200 avec la trace structurelle', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({ reason: 'Empêchement de dernière minute' });

      // 200 et non 201 : rien n'a été créé, un rendez-vous a changé d'état.
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id: booked.id,
        status: 'CANCELLED',
        cancelledBy: 'CLIENT',
      });
      expect(response.body.cancelledAt).toEqual(expect.any(String));
    });

    it('enregistre le motif sans jamais le rendre', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({ reason: 'Grippe' });

      // Deuxième critère de #40 : le motif est **enregistré**…
      const stored = harness.appointments.appointments.find((row) => row.id === booked.id);
      expect(stored?.cancellationReason).toBe('Grippe');
      expect(stored?.cancelledBy).toBe('CLIENT');
      expect(stored?.cancelledAt).toBeInstanceOf(Date);
      // …et il ne ressort pas : la vue est servie au comptoir comme au parcours
      // public, et un motif écrit par un praticien est une note interne.
      expect(JSON.stringify(response.body)).not.toContain('Grippe');
    });

    it('accepte une annulation sans motif', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({});

      // Exiger un motif ferait abandonner des annulations, donc laisserait des
      // créneaux fantômes bloqués.
      expect(response.status).toBe(200);
      expect(
        harness.appointments.appointments.find((row) => row.id === booked.id)?.cancellationReason,
      ).toBeNull();
    });

    it('compte pour absent un motif que l’élagage réduit à rien', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({ reason: '   ' });

      // `@Trim()` ramène la saisie à la chaîne vide, et une chaîne vide n'est pas
      // un motif : la colonne reste `NULL`. Sans cela, un
      // `cancellation_reason IS NOT NULL` compterait comme motivée une
      // annulation qui ne l'est pas — le chiffre même que le deuxième critère de
      // #40 existe pour rendre lisible.
      expect(response.status).toBe(200);
      expect(
        harness.appointments.appointments.find((row) => row.id === booked.id)?.cancellationReason,
      ).toBeNull();
    });

    it('rend le créneau immédiatement réservable', async () => {
      const booked = await book();

      await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({});

      // Troisième critère de #40, exercé par la porte d'entrée : le créneau se
      // revend, sans qu'aucune libération n'ait été écrite.
      const reprise = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
          client: { ...GUEST, email: 'autre@example.test' },
          dataConsent: true,
        });

      expect(reprise.status).toBe(201);
      expect(reprise.body.id).not.toBe(booked.id);
    });

    it('ne rouvre pas le créneau à deux réservations à la fois', async () => {
      const booked = await book();
      await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({});

      const payload = {
        serviceId: harness.a.serviceId,
        staffId: harness.a.staffId,
        startsAt: slot.startsAt.toISOString(),
        client: { ...GUEST, email: 'autre@example.test' },
        dataConsent: true,
      };
      await request(harness.server()).post(BOOKING_PATH(harness.a.tenant.slug)).send(payload);
      const troisieme = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({ ...payload, client: { ...GUEST, email: 'troisieme@example.test' } });

      // Le créneau a été rendu, il n'a pas été ouvert.
      expect(troisieme.status).toBe(409);
      expect(troisieme.body).toMatchObject({ code: 'SLOT_NO_LONGER_AVAILABLE' });
    });

    it('refuse en 422 un rendez-vous déjà annulé', async () => {
      const booked = await book();
      await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({});

      const rejoue = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
        .set('Authorization', booked.authorization)
        .send({ reason: 'encore' });

      // Le refus vient du service de cycle de vie, jamais du contrôleur —
      // quatrième critère de #40.
      expect(rejoue.status).toBe(422);
      expect(rejoue.body).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        details: { from: 'CANCELLED', to: 'CANCELLED' },
      });
      // Et la trace de la première annulation n'a pas été réécrite.
      expect(
        harness.appointments.appointments.find((row) => row.id === booked.id)?.cancellationReason,
      ).toBeNull();
    });

    it.each(['COMPLETED', 'NO_SHOW'] as const)('refuse en 422 un rendez-vous %s', async (status) => {
      // La cliente est **nommée** sur la ligne semée : sans cela le refus serait
      // le 404 de propriété de #1135, et ce cas-ci ne dirait plus rien du cycle
      // de vie qu'il existe pour exercer.
      const clientId = randomUUID();
      const seeded = harness.appointments.seedAppointment({
        tenantId: harness.a.tenant.id,
        staffId: harness.a.staffId,
        serviceId: harness.a.serviceId,
        clientId,
        startsAt: slot.occupiedStartsAt,
        endsAt: new Date(slot.occupiedStartsAt.getTime() + 80 * 60_000),
        status,
      });

      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, seeded.id))
        .set('Authorization', await bearerFor(clientId, 'CLIENT'))
        .send({});

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('refuse en 404 un rendez-vous inconnu', async () => {
      const response = await request(harness.server())
        .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, randomUUID()))
        .set('Authorization', await bearer('CLIENT'))
        .send({});

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    describe('la garde de la cliente — #1135', () => {
      it('refuse en 401 une annulation sans jeton, fût-elle sur le bon identifiant', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .send({});

        // La connaissance de l'identifiant ne suffit plus : c'est tout le
        // ticket. Un UUID v4 ne se devine pas, mais il se **lit** — un
        // praticien relève ceux de ses collègues dans le journal des envois.
        expect(response.status).toBe(401);
        expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
          'PENDING',
        );
      });

      it('refuse en 403 le jeton d’un praticien sur cette route', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', await bearer('STAFF'))
          .send({});

        // Le contournement relevé par #1135 : le back-office refusait à Sam
        // l'annulation du rendez-vous de Marc en 403 `OWN_SCOPE_ONLY`, et cette
        // route-ci la lui accordait en 200. Elle n'est pas la sienne : c'est
        // celle de la cliente, et `POST /appointments/:id/cancel` reste la porte
        // du salon.
        expect(response.status).toBe(403);
        expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
          'PENDING',
        );
      });

      it('refuse en 404 le rendez-vous d’une autre cliente du même salon', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', await bearer('CLIENT'))
          .send({});

        // 404 et non 403 : le rendez-vous d'autrui doit rester indiscernable
        // d'un identifiant qui n'existe pas (tenant-isolation §4). Un 403 aurait
        // confirmé que l'identifiant essayé désigne bien un rendez-vous.
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
        const stored = harness.appointments.appointments.find((row) => row.id === booked.id);
        expect(stored?.status).toBe('PENDING');
        // Et surtout : aucune trace au nom de la cliente. C'est la seconde
        // moitié du défaut — la trace accusait celle qui n'avait rien fait.
        expect(stored?.cancelledBy).toBeNull();
      });
    });

    describe('validation du corps et du chemin', () => {
      it('refuse en 400 un identifiant de rendez-vous mal formé', async () => {
        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, 'pas-un-uuid'))
          .set('Authorization', await bearer('CLIENT'))
          .send({});

        // `ParseUUIDPipe` : la requête ne descend jamais jusqu'au pilote
        // PostgreSQL pour en revenir en 500.
        expect(response.status).toBe(400);
      });

      it('refuse en 400 un motif plus long que la colonne', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({ reason: 'x'.repeat(REASON_MAX_LENGTH + 1) });

        // Une borne plus large que `VARCHAR(500)` ferait sortir un 500 du pilote
        // là où le contrat annonce un 400 qui nomme le champ.
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ code: expect.any(String), details: expect.any(Object) });
      });

      it('rejette un `cancelledBy` glissé dans le corps', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({ cancelledBy: 'STAFF' });

        // `forbidNonWhitelisted` : sans ce refus, une cliente inscrirait au
        // registre du salon que le salon l'avait annulée.
        expect(response.status).toBe(400);
        expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
          'PENDING',
        );
      });

      it('rejette un `cancelledAt` imposé par le client', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({ cancelledAt: '2020-01-01T00:00:00Z' });

        // Antidater une annulation permettrait de se ranger sous un délai de
        // franchise que #48 posera.
        expect(response.status).toBe(400);
      });

      it('rejette un `status` imposé par le client', async () => {
        const booked = await book();

        const response = await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({ status: 'COMPLETED' });

        expect(response.status).toBe(400);
      });
    });

    describe('événement de domaine', () => {
      it('émet `appointment.cancelled` avec le créneau facturé et l’auteur', async () => {
        const received: AppointmentCancelledEvent[] = [];
        const off = harness.events.onAppointmentCancelled((event) => received.push(event));
        const booked = await book();

        await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({ reason: 'hospitalisation' });
        off();

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
          name: 'appointment.cancelled',
          tenantId: harness.a.tenant.id,
          appointmentId: booked.id,
          clientId: booked.clientId,
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
          previousStatus: 'PENDING',
          cancelledBy: 'CLIENT',
        });
        // Le motif ne voyage pas : un événement circule, se journalise et se
        // rejoue (CDC §5.1).
        expect(JSON.stringify(received)).not.toContain('hospitalisation');
      });

      it('n’émet pas `appointment.created` sur une annulation', async () => {
        const booked = await book();
        // Après la réservation : c'est l'annulation seule qu'on observe.
        const created: AppointmentCreatedEvent[] = [];
        const off = harness.events.onAppointmentCreated((event) => created.push(event));

        await request(harness.server())
          .post(PUBLIC_CANCEL_PATH(harness.a.tenant.slug, booked.id))
          .set('Authorization', booked.authorization)
          .send({});
        off();

        expect(created).toHaveLength(0);
      });
    });
  });

  describe('POST /api/v1/appointments/:appointmentId/cancel', () => {
    it('annule au nom du salon et inscrit `STAFF`', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(booked.id))
        .set('Authorization', await bearer('MANAGER'))
        .send({ reason: 'Cliente injoignable' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: booked.id, status: 'CANCELLED', cancelledBy: 'STAFF' });
      const stored = harness.appointments.appointments.find((row) => row.id === booked.id);
      expect(stored?.cancelledBy).toBe('STAFF');
      expect(stored?.cancellationReason).toBe('Cliente injoignable');
      // La note du praticien ne repart pas vers l'appelant du parcours public,
      // et pas davantage ici : c'est la même vue.
      expect(JSON.stringify(response.body)).not.toContain('Cliente injoignable');
    });

    it('refuse en 401 sans jeton', async () => {
      const booked = await book();

      const response = await request(harness.server()).post(DESK_CANCEL_PATH(booked.id)).send({});

      // Contrairement au tunnel public, cette surface n'est pas ouverte :
      // l'établissement vient du jeton vérifié, et de lui seul.
      expect(response.status).toBe(401);
      expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
        'PENDING',
      );
    });

    it('refuse en 403 un jeton de rang `CLIENT`', async () => {
      const booked = await book();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(booked.id))
        .set('Authorization', await bearer('CLIENT'))
        .send({});

      // Le rang est établi, la ressource existe : 403 est ici la bonne réponse —
      // ce n'est pas une traversée de tenant.
      expect(response.status).toBe(403);
      expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
        'PENDING',
      );
    });

    it.each(['MANAGER', 'ADMIN'] as const)(
      'laisse le rang %s annuler n’importe quel rendez-vous — c’est de la tenue d’agenda',
      async (role) => {
        const booked = await book();

        const response = await request(harness.server())
          .post(DESK_CANCEL_PATH(booked.id))
          .set('Authorization', await bearer(role))
          .send({});

        // `cancelledBy` reste `STAFF` quel que soit le rang : la question est de
        // quel côté du comptoir la décision vient, pas quel droit avait l'auteur.
        expect(response.status).toBe(200);
        expect(response.body.cancelledBy).toBe('STAFF');
      },
    );

    it('refuse au praticien le créneau qui n’est pas le sien — 403 `OWN_SCOPE_ONLY`', async () => {
      // #812, troisième critère. Le rang `STAFF` porte bien
      // `appointment:write:own` : la garde le laisse entrer, et c'est le service
      // qui refuse — le rendez-vous semé ici est celui d'un praticien auquel ce
      // jeton n'est rattaché par aucune fiche.
      const booked = await book();

      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(booked.id))
        .set('Authorization', await bearer('STAFF'))
        .send({});

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('OWN_SCOPE_ONLY');
      // 403 et non 404 : la ressource est du **même** établissement, et
      // l'appelant en connaît déjà l'existence (ADR 0013).
      expect(response.body.details).toEqual({ scope: 'appointment:write:all' });
      expect(harness.appointments.appointments.find((row) => row.id === booked.id)?.status).toBe(
        'PENDING',
      );
    });

    it('refuse en 404 un rendez-vous inconnu de l’établissement du jeton', async () => {
      const response = await request(harness.server())
        .post(DESK_CANCEL_PATH(randomUUID()))
        .set('Authorization', await bearer('MANAGER'))
        .send({});

      expect(response.status).toBe(404);
    });

    it('rend au salon un créneau immédiatement revendable', async () => {
      const booked = await book();

      await request(harness.server())
        .post(DESK_CANCEL_PATH(booked.id))
        .set('Authorization', await bearer('MANAGER'))
        .send({ reason: 'Fermeture exceptionnelle' });

      const reprise = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send({
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
          client: { ...GUEST, email: 'autre@example.test' },
          dataConsent: true,
        });

      // C'est tout l'intérêt de libérer : le créneau redevient vendable.
      expect(reprise.status).toBe(201);
    });
  });
});
