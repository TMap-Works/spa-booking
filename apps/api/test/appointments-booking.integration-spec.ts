import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { AppointmentCreatedEvent } from '../src/modules/appointments/events/appointment-created.event';
import { TenantBillingGate } from '../src/modules/identity/tenant-billing.gate';
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
 * 5. réserver **exige le jeton d'une cliente** (#1136) — 401 sans jeton, 403 sur
 *    un jeton de personnel, 401 sur celui du salon voisin, 404 sur un compte qui
 *    n'est pas une cliente de ce salon — et le rendez-vous se rattache toujours
 *    au compte du jeton, jamais à ce que l'adresse e-mail du corps désignerait ;
 * 6. l'événement `appointment.created` part réellement ;
 * 7. le corps rendu porte **exactement** les champs de `bookedAppointmentSchema`
 *    — le contrat partagé décrit ce que cette route sert, et le doublon des deux
 *    descriptions ne dérive pas en silence (#314).
 *
 * L'isolation inter-tenant a sa suite propre — `appointments-tenant.isolation-spec.ts`.
 */

const BOOKING_PATH = (slug: string): string => `/api/v1/public/${slug}/appointments`;

const MINUTE_MS = 60_000;

/**
 * Des coordonnées bien formées — ce que le corps ne porte **plus** (#1222).
 *
 * Elles ne servent qu'au cas qui prouve le refus : le contrat a perdu le champ
 * `client`, et le seul appel de cette suite qui l'envoie doit sortir en 400.
 * Bien formées à dessein — ce n'est pas leur contenu qui est refusé, c'est leur
 * présence.
 */
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
  /**
   * Le porteur de la cliente du salon — exigé depuis #1136.
   *
   * Signé une fois par cas plutôt qu'à chaque appel : la chaîne de `supertest`
   * se construit de façon synchrone, et attendre la signature au milieu aurait
   * imposé de casser chacun de ces appels en deux. Ce que la garde refuse a ses
   * propres cas, plus bas.
   */
  let auth: string;

  beforeEach(async () => {
    harness = await createAppointmentsHarness();
    slot = bookableSlot();
    auth = await harness.bearer(harness.a);
  });

  afterEach(async () => {
    await harness.close();
  });

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    serviceId: harness.a.serviceId,
    staffId: harness.a.staffId,
    startsAt: slot.startsAt.toISOString(),
    // L'accord au traitement des données, obligatoire depuis #790 : le corps
    // par défaut est celui d'un tunnel qui a fait cocher la case. Les cas qui
    // l'omettent ou le refusent le disent par `overrides`.
    dataConsent: true,
    ...overrides,
  });

  it('réserve un créneau proposé et rend 201 avec l’intervalle facturé', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
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
      .set('Authorization', auth)
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
      // La référence citable (#796) : elle sort **à dessein** — c'est la preuve
      // de réservation que l'écran de confirmation affiche, et celle que
      // l'e-mail reprend. Ce que le contrat continue de retenir ici, ce sont les
      // champs de back-office : `staffNote`, `cancellationReason`, `tenantId`.
      'reference',
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
    await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body());

    const stored = harness.appointments.appointments[0];
    expect(stored?.startsAt.getTime()).toBe(
      slot.startsAt.getTime() - BUFFER_BEFORE_MINUTES * MINUTE_MS,
    );
    expect(stored?.endsAt.getTime()).toBe(slot.endsAt.getTime() + BUFFER_AFTER_MINUTES * MINUTE_MS);
    expect(stored?.status).toBe('PENDING');
    expect(stored?.tenantId).toBe(harness.a.tenant.id);
  });

  it('rattache le rendez-vous au compte du jeton, et n’écrit aucune fiche', async () => {
    // Le premier critère de #1136. La fiche n'est plus créée au passage : la
    // cliente en a une, c'est son compte, et c'est le jeton qui la nomme. Le
    // fichier du salon compte donc exactement ce qu'il comptait avant l'appel.
    const avant = harness.appointments.clients.length;

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body());

    expect(response.status).toBe(201);
    expect(response.body.clientId).toBe(harness.a.clientId);
    expect(harness.appointments.clients).toHaveLength(avant);
    expect(harness.appointments.appointments[0]?.clientId).toBe(harness.a.clientId);
  });

  it('refuse en 400 des coordonnées dans le corps — le champ n’existe plus', async () => {
    // Le cœur du défaut relevé le 22/09/2026 : avec `client.email` = l'adresse
    // d'une cliente existante, le rendez-vous se posait dans **son** compte et
    // la réponse livrait son `clientId`. #1136 a rendu le champ sans effet ;
    // #1222 l'a retiré du contrat, une fois le tunnel passé à un corps qui ne
    // l'émet plus. Le `.strict()` en fait un champ inconnu, donc un 400 — et
    // c'est le refus qu'on veut : l'appelant qui l'envoie croit désigner
    // quelqu'un.
    const autre = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'clara@example.test',
    });

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body({ client: guest({ email: 'clara@example.test' }) }));

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(harness.appointments.appointments).toHaveLength(0);
    expect(
      harness.appointments.appointments.filter((row) => row.clientId === autre.id),
    ).toHaveLength(0);
  });

  /**
   * La porte, depuis #1136 — ce que le contrat d'API refuse désormais.
   *
   * L'interface exigeait déjà un compte (#1119) ; la route, non. Le portail se
   * contournait d'un `curl`, et c'est ce que ces quatre cas tiennent.
   */
  describe('la garde de la réservation', () => {
    it('refuse en 401 un appel sans jeton', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .send(body());

      expect(response.status).toBe(401);
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('refuse en 403 un jeton qui n’est pas celui d’une cliente', async () => {
      // Un praticien ne réserve pas par le tunnel public : sa surface est le
      // comptoir (#50), gardée, et qui inscrit la réservation au nom d'une fiche
      // désignée plutôt qu'à son propre nom.
      for (const role of ['STAFF', 'MANAGER', 'ADMIN'] as const) {
        const response = await request(harness.server())
          .post(BOOKING_PATH(harness.a.tenant.slug))
          .set('Authorization', await harness.bearer(harness.a, role, harness.a.staffId))
          .send(body());

        expect(response.status).toBe(403);
      }

      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('refuse en 401 le jeton du salon voisin présenté sous ce slug', async () => {
      // Le jeton est vérifié, mais son établissement n'est pas celui du slug :
      // `JwtAuthGuard` refuse avant tout code métier, et rien du salon A n'a été
      // lu au passage (tenant-isolation §2).
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', await harness.bearer(harness.b))
        .send(body());

      expect(response.status).toBe(401);
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('refuse en 404 un jeton dont le compte n’est pas au fichier du salon', async () => {
      // Le jeton est bien celui de cet établissement, mais il désigne un compte
      // qui n'existe pas — ou qui n'est pas une cliente. Le refus est le même 404
      // que pour une fiche inconnue, jamais un 403 qui confirmerait quoi que ce
      // soit (tenant-isolation §4).
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', await harness.bearer(harness.a, 'CLIENT', randomUUID()))
        .send(body());

      expect(response.status).toBe(404);
      expect(harness.appointments.appointments).toHaveLength(0);
    });

    it('garde le 409 du salon fermé, là où la garde aurait pu rendre 402', async () => {
      // La garde ajoutée par #1136 monte `TenantBillingGuard`, dont le 402
      // `SUBSCRIPTION_REQUIRED` s'adresse au back-office. Sans
      // `@AllowUnpaidTenant()`, poser l'authentification aurait donc
      // silencieusement changé le code d'erreur d'un salon sans abonnement — et
      // le tunnel aurait cessé d'expliquer pourquoi il ne prend plus de
      // rendez-vous. C'est `BookableSalonGuard` qui doit parler ici (ADR 0016).
      jest.spyOn(harness.app.get(TenantBillingGate), 'isOpen').mockResolvedValue(false);

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send(body());

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'SALON_BOOKING_CLOSED' });
      expect(harness.appointments.appointments).toHaveLength(0);
    });
  });

  /**
   * La langue du tunnel sur la fiche cliente (#844) a quitté cette route avec
   * #1136, et c'est une conséquence assumée plutôt qu'un oubli.
   *
   * Elle **comblait** l'absence de préférence sur la fiche qu'une réservation
   * publique résolvait depuis des coordonnées. Il n'y a plus de résolution : la
   * cliente a un compte, et sa préférence de langue s'y écrit par
   * `/auth/register` puis `PATCH /users/me`. Le seul chemin qui reste à couvrir
   * est celui-là, et il a ses suites dans `identity`.
   */

  it('pose deux rendez-vous pour la même cliente sans toucher au fichier', async () => {
    const second = bookableSlot();
    // Le créneau suivant sur la grille : quinze minutes plus loin, donc sans
    // chevauchement avec l'intervalle occupé du premier (80 min à partir de
    // 10:00 occupé) — on décale d'une heure et demie pour être net.
    const later = new Date(second.startsAt.getTime() + 90 * MINUTE_MS).toISOString();
    const avant = harness.appointments.clients.length;

    await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body());
    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body({ startsAt: later }));

    expect(response.status).toBe(201);
    expect(harness.appointments.clients).toHaveLength(avant);
    expect(harness.appointments.appointments).toHaveLength(2);
  });

  it('émet appointment.created', async () => {
    const received: AppointmentCreatedEvent[] = [];
    const off = harness.events.onAppointmentCreated((event) => received.push(event));

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
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
      .set('Authorization', auth)
      .send(body());
    expect(first.status).toBe(201);

    // Une **autre** cliente du même salon : c'est bien la contrainte de créneau
    // qui tranche, et non la porte.
    const autre = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'autre@example.test',
    });
    const avant = harness.appointments.clients.length;
    const second = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', await harness.bearer(harness.a, 'CLIENT', autre.id))
      .send(body());

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
    // Le fichier client n'a pas bougé d'un iota — ni avant, ni après. C'est ce
    // que #313 obtenait par l'ordre des écritures dans la transaction, et que
    // #1136 obtient plus simplement : la réservation n'écrit plus dans `users`.
    expect(harness.appointments.clients).toHaveLength(avant);
  });

  it('n’accroche pas un rendez-vous à un compte du personnel', async () => {
    // La décision produit de #313, telle qu'elle subsiste depuis #1136 : la
    // réservation du tunnel ne s'accroche jamais à un compte `STAFF`,
    // `MANAGER` ou `ADMIN`. Le refus a changé de nature — ce n'est plus un 409
    // `CLIENT_EMAIL_NOT_BOOKABLE` sur une adresse saisie, mais le 403 de la
    // porte pour un jeton de personnel, et le 404 de `crm` pour un jeton
    // `CLIENT` qui désignerait un compte qui n'en est pas un (#465). Les deux
    // sont exercés par `la garde de la réservation` ci-dessus ; ce cas-ci tient
    // l'invariant qu'ils protègent.
    const gerante = harness.appointments.seedClient({
      tenantId: harness.a.tenant.id,
      email: 'gerante@example.test',
      role: 'MANAGER',
    });

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', await harness.bearer(harness.a, 'CLIENT', gerante.id))
      .send(body());

    expect(response.status).toBe(404);
    // Le corps d'erreur ne renvoie pas l'adresse : c'est une donnée personnelle,
    // et celui qui vient de la saisir la connaît déjà (CDC §5.1).
    expect(JSON.stringify(response.body)).not.toContain('gerante@example.test');
    expect(harness.appointments.appointments).toHaveLength(0);
  });

  it('refuse en 409 un instant que le calendrier ne propose pas', async () => {
    const offGrid = new Date(slot.startsAt.getTime() + 7 * MINUTE_MS).toISOString();

    const response = await request(harness.server())
      .post(BOOKING_PATH(harness.a.tenant.slug))
      .set('Authorization', auth)
      .send(body({ startsAt: offGrid }));

    expect(response.status).toBe(409);
    expect(harness.appointments.appointments).toHaveLength(0);
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
      .set('Authorization', auth)
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
      last = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send(body());
    }

    expect(last?.status).toBe(429);
    expect(harness.appointments.appointments).toHaveLength(1);
  });

  it('refuse en 404 un slug d’établissement inconnu, avant tout code métier', async () => {
    const response = await request(harness.server())
      .post(BOOKING_PATH('salon-qui-n-existe-pas'))
      .set('Authorization', auth)
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
        .set('Authorization', auth)
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
        .set('Authorization', auth)
        .send(body({ staffId: first }));
      expect(taken.status).toBe(201);

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send(withoutStaff());

      expect(response.status).toBe(201);
      expect(response.body.staffId).toBe(second);
      expect(harness.appointments.appointments).toHaveLength(2);
    });

    it('refuse en 409 sans nommer de praticien quand tous sont pris', async () => {
      const [first, second] = bothStaff();

      for (const staffId of [first, second]) {
        const taken = await request(harness.server())
          .post(BOOKING_PATH(harness.a.tenant.slug))
          .set('Authorization', auth)
          .send(body({ staffId }));
        expect(taken.status).toBe(201);
      }

      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send(withoutStaff());

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
        .set('Authorization', auth)
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
        .set('Authorization', auth)
        .send(body({ startsAt: '2026-09-01T10:00:00' }));

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: expect.any(String),
        message: expect.any(String),
      });
      expect(response.body).toHaveProperty('details');
    });

    it('refuse un corps sans consentement plutôt que de tomber en 500', async () => {
      // Les coordonnées, elles, sont facultatives depuis #1136 — c'est
      // `dataConsent` qui manque ici, et lui seul (#790). Le cas « corps sans
      // coordonnées » est plus haut, et il rend 201.
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send({
          serviceId: harness.a.serviceId,
          staffId: harness.a.staffId,
          startsAt: slot.startsAt.toISOString(),
        });

      expect(response.status).toBe(400);
    });

    it('rejette un `tenantId` glissé dans le corps', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
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
        .set('Authorization', auth)
        .send(body({ price: { amountMinor: 1, currency: 'EUR' } }));

      expect(response.status).toBe(400);
    });

    it('rejette un `endsAt` imposé par le client', async () => {
      const response = await request(harness.server())
        .post(BOOKING_PATH(harness.a.tenant.slug))
        .set('Authorization', auth)
        .send(body({ endsAt: slot.endsAt.toISOString() }));

      expect(response.status).toBe(400);
    });

    /*
     * `pays de l'établissement et numéro national` a disparu avec #1222 : ces
     * cas exerçaient le trajet du pays jusqu'à `client.phone`, et la demande ne
     * porte plus de coordonnées. La règle E.164 et son pays par défaut vivent
     * toujours, chez leur seul appelant — le formulaire de coordonnées du
     * tunnel, monté sur `guestContactSchemaFor`, dont
     * `packages/shared/src/__tests__/phone.spec.ts` tient la règle.
     */

    /*
     * `canonise l'adresse e-mail avant de chercher la fiche` a disparu avec
     * #1136 : il n'y a plus de fiche à chercher depuis une adresse, donc plus
     * d'unicité `(tenant_id, email)` que la canonisation puisse protéger sur ce
     * chemin. La règle elle-même n'a pas bougé — `emailSchema` canonise
     * toujours, et `guest-booking-frontier.spec.ts` le tient.
     */
  });
});
