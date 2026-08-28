import { randomUUID } from 'node:crypto';

import { InvalidStateTransitionError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { SpyAvailabilityCache } from '../../availability/__tests__/staff-time-off.doubles';
import type { AvailabilityService } from '../../availability/availability.service';
import type { AvailabilityView } from '../../availability/availability.types';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import { AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import { AppointmentsService } from '../appointments.service';
import type { BookAppointmentInput } from '../appointments.types';
import {
  APPOINTMENT_CANCELLED,
  type AppointmentCancelledEvent,
} from '../events/appointment-cancelled.event';
import { APPOINTMENT_CREATED, type AppointmentCreatedEvent } from '../events/appointment-created.event';
import {
  APPOINTMENT_RESCHEDULED,
  type AppointmentRescheduledEvent,
} from '../events/appointment-rescheduled.event';
import { AppointmentEvents } from '../events/appointment-events';
import { FakeAppointmentsRepository } from './appointments.doubles';

/**
 * La prise de rendez-vous, assemblée — sans HTTP et sans base (#37).
 *
 * Ce que cette suite exerce est ce que ni `appointments.repository.spec.ts` ni la
 * suite d'exclusion contre PostgreSQL ne voient : **la décision**. Quel
 * intervalle part en base, quel intervalle revient à la cliente, d'où vient le
 * prix, ce qui se passe quand le créneau n'était pas proposé, et ce que
 * l'événement de domaine porte.
 *
 * Le service est exercé **dans une portée de tenant**, celle que
 * `TenantScopeMiddleware` renseigne en vrai depuis le slug d'URL : le double
 * refuse de lire sans elle, comme le fait l'extension Prisma.
 */

const TENANT = randomUUID();
const SERVICE_ID = randomUUID();
const STAFF_ID = randomUUID();

/** Le créneau que le calendrier affiche : le soin commence à 10:00 UTC. */
const BILLED_START = new Date('2026-09-01T10:00:00.000Z');

/** Une heure bien avant, pour que rien ne soit écarté par le préavis. */
const NOW = new Date('2026-08-31T08:00:00.000Z');

/** Une prestation d'une heure, encadrée de deux tampons de dix minutes. */
function serviceView(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: SERVICE_ID,
    slug: 'massage-60',
    name: 'Massage 60 min',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 10,
    bufferAfterMinutes: 10,
    occupiedMinutes: 80,
    price: { amountMinor: 7500, currency: 'EUR' },
    isActive: true,
    ...overrides,
  };
}

/** Le catalogue, réduit à la porte que la réservation emprunte. */
function fakeCatalog(view: ServiceView | null): ServicesService {
  return {
    byId: (id: string): Promise<ServiceView> => {
      if (view === null || id !== view.id) {
        return Promise.reject(new NotFoundError('Prestation introuvable.'));
      }
      return Promise.resolve(view);
    },
  } as unknown as ServicesService;
}

/**
 * Le moteur de disponibilité, réduit aux créneaux qu'il propose.
 *
 * Un double et non le vrai : celui-ci aurait exigé des horaires, des fermetures,
 * des congés et un fuseau, c'est-à-dire de reconstruire son harnais pour prouver
 * une chose qu'il prouve déjà lui-même. Ce qui compte ici est **ce que la
 * réservation fait du verdict**, pas la façon dont le verdict est calculé.
 *
 * `calls` retient les requêtes pour vérifier que la fenêtre interrogée encadre
 * bien l'instant demandé — c'est la seule partie du contrôle que ce service
 * décide lui-même.
 */
function fakeAvailability(
  offered: readonly Date[],
  candidates: readonly string[] = [STAFF_ID],
): {
  service: AvailabilityService;
  calls: { from: string; to: string; staffId?: string }[];
} {
  const calls: { from: string; to: string; staffId?: string }[] = [];

  const service = {
    slotsFor: (query: {
      serviceId: string;
      staffId?: string;
      from: string;
      to: string;
    }): Promise<AvailabilityView> => {
      calls.push({
        from: query.from,
        to: query.to,
        ...(query.staffId === undefined ? {} : { staffId: query.staffId }),
      });

      // Le praticien demandé, et non une constante : le vrai moteur filtre sur
      // `staffId`, et un double qui rendrait toujours le même ferait passer pour
      // proposé le créneau d'un praticien qui n'a jamais été interrogé —
      // exactement ce que le report vérifie quand il change de praticien en
      // chemin. Sans `staffId`, il rend **tous** les candidats de la prestation,
      // dans l'ordre du moteur : c'est la matière de l'option « premier
      // disponible » (#36), et l'ordre `(instant, praticien)` est garanti — et
      // testé — par `availability.slots.ts`, pas ici.
      const staff = query.staffId === undefined ? candidates : [query.staffId];

      return Promise.resolve({
        serviceId: query.serviceId,
        timezone: 'Europe/Paris',
        days: [
          {
            date: '2026-09-01',
            slots: offered.flatMap((startsAt) =>
              staff.map((staffId) => ({
                startsAt: startsAt.toISOString(),
                endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
                staffId,
              })),
            ),
          },
        ],
      });
    },
  } as unknown as AvailabilityService;

  return { service, calls };
}

/**
 * Logger muet, sauf pour les erreurs : ce que la publication journalise à
 * l'`info` n'est pas l'objet de la suite, mais l'échec d'un abonné est la seule
 * trace qu'il en reste — c'est donc par elle qu'on vérifie qu'il a été rattrapé.
 */
function recordingLogger(): { logger: StructuredLogger; errors: string[] } {
  const errors: string[] = [];
  const logger = {
    log: () => undefined,
    error: (message: unknown) => errors.push(String(message)),
  } as unknown as StructuredLogger;

  return { logger, errors };
}

interface Harness {
  service: AppointmentsService;
  repository: FakeAppointmentsRepository;
  events: AppointmentEvents;
  availabilityCalls: { from: string; to: string; staffId?: string }[];
  /** Compteur d'invalidations du cache de disponibilité — #35, critère 3. */
  cache: SpyAvailabilityCache;
  loggedErrors: string[];
}

function createHarness(
  options: {
    view?: ServiceView | null;
    offered?: readonly Date[];
    /** Les praticiens que le moteur propose quand la cliente n'en désigne aucun. */
    candidates?: readonly string[];
  } = {},
): Harness {
  const repository = new FakeAppointmentsRepository();
  const journal = recordingLogger();
  const events = new AppointmentEvents(journal.logger);
  const availability = fakeAvailability(options.offered ?? [BILLED_START], options.candidates);
  const view = options.view === undefined ? serviceView() : options.view;
  const cache = new SpyAvailabilityCache();

  return {
    service: new AppointmentsService(
      repository.asRepository(),
      fakeCatalog(view),
      availability.service,
      events,
      // Le **vrai** service de cycle de vie, et non un double : c'est une règle
      // pure, sans collaborateur, et la substituer ferait passer au vert un
      // service qui refuserait les mauvaises transitions (#40).
      new AppointmentLifecycleService(),
      cache.asService(),
    ),
    repository,
    events,
    availabilityCalls: availability.calls,
    cache,
    loggedErrors: journal.errors,
  };
}

function bookingInput(overrides: Partial<BookAppointmentInput> = {}): BookAppointmentInput {
  return {
    serviceId: SERVICE_ID,
    staffId: STAFF_ID,
    startsAt: BILLED_START,
    client: {
      firstName: 'Camille',
      lastName: 'Rakoto',
      email: 'camille@example.test',
      phone: '+261 34 12 345 67',
    },
    clientNote: null,
    ...overrides,
  };
}

describe('AppointmentsService.book', () => {
  it('pose un rendez-vous PENDING et rend l’intervalle facturé', async () => {
    const { service } = createHarness();

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(view.status).toBe('PENDING');
    expect(view.startsAt).toBe('2026-09-01T10:00:00.000Z');
    // 60 minutes de soin, et rien d'autre : les tampons ne sont pas facturés.
    expect(view.endsAt).toBe('2026-09-01T11:00:00.000Z');
  });

  it('enregistre une durée qui inclut les deux tampons du service', async () => {
    const { service, repository } = createHarness();

    await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    const stored = repository.appointments[0];
    // 09:50 → 11:10 : dix minutes de préparation avant, dix de remise en état
    // après. C'est cet intervalle-là que la contrainte d'exclusion compare.
    expect(stored?.startsAt.toISOString()).toBe('2026-09-01T09:50:00.000Z');
    expect(stored?.endsAt.toISOString()).toBe('2026-09-01T11:10:00.000Z');
  });

  it('fige le prix du catalogue au moment de la réservation', async () => {
    const { service, repository } = createHarness();

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(view.price).toEqual({ amountMinor: 7500, currency: 'EUR' });
    expect(repository.appointments[0]?.priceAmountMinor).toBe(7500);
  });

  it('réserve sans compte : la fiche cliente est créée depuis les seules coordonnées', async () => {
    const { service, repository } = createHarness();

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(repository.clients).toHaveLength(1);
    const client = repository.clients[0];
    expect(client?.id).toBe(view.clientId);
    expect(client?.email).toBe('camille@example.test');
    expect(client?.tenantId).toBe(TENANT);
  });

  it('réutilise la fiche d’une cliente déjà connue, sans l’écraser', async () => {
    const { service, repository } = createHarness();
    const known = repository.seedClient({
      tenantId: TENANT,
      email: 'camille@example.test',
      firstName: 'Camille',
      lastName: 'Rakotoarisoa',
      phone: '+261 33 00 000 00',
    });

    const view = await runWithTenant(TENANT, () =>
      service.book(bookingInput({ client: { ...bookingInput().client, lastName: 'Usurpé' } }), NOW),
    );

    expect(view.clientId).toBe(known.id);
    expect(repository.clients).toHaveLength(1);
    // Un appel public ne réécrit pas la fiche d'une cliente existante.
    expect(repository.clients[0]?.lastName).toBe('Rakotoarisoa');
    expect(repository.clients[0]?.phone).toBe('+261 33 00 000 00');
  });

  it('refuse en 409 le créneau qu’un autre rendez-vous occupe déjà', async () => {
    const { service, repository } = createHarness();
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: new Date('2026-09-01T10:00:00.000Z'),
      endsAt: new Date('2026-09-01T11:00:00.000Z'),
    });

    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      SlotNoLongerAvailableError,
    );
  });

  it('rend dans le 409 l’heure que l’appelant a envoyée, pas l’heure occupée', async () => {
    const { service, repository } = createHarness();
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: new Date('2026-09-01T10:00:00.000Z'),
      endsAt: new Date('2026-09-01T11:00:00.000Z'),
    });

    const rejected = runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    // 10:00 — le créneau affiché — et non 09:50, l'heure à laquelle la cabine
    // aurait commencé à être préparée. Le front doit retrouver le créneau qu'il
    // vient de soumettre pour le retirer de sa liste.
    await expect(rejected).rejects.toMatchObject({
      details: { staffId: STAFF_ID, startsAt: '2026-09-01T10:00:00.000Z' },
    });
  });

  it('refuse en 409 un instant que le calendrier ne proposait pas', async () => {
    // Le moteur propose 10:00 ; la demande vise 10:07, hors grille.
    const { service, repository } = createHarness();

    const rejected = runWithTenant(TENANT, () =>
      service.book(bookingInput({ startsAt: new Date('2026-09-01T10:07:00.000Z') }), NOW),
    );

    await expect(rejected).rejects.toThrow(SlotNoLongerAvailableError);
    // Rien n'a été écrit — ni rendez-vous, ni fiche cliente : le contrôle a lieu
    // avant la résolution du client, faute de quoi un tir sur des créneaux
    // impossibles remplirait le fichier clients du salon.
    expect(repository.appointments).toHaveLength(0);
    expect(repository.clients).toHaveLength(0);
  });

  it('interroge le calendrier sur les trois journées UTC qui encadrent l’instant', async () => {
    const { service, availabilityCalls } = createHarness();

    await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    // Quel que soit le fuseau du salon — au plus ±14 h —, sa journée civile est
    // l'une de ces trois-là.
    expect(availabilityCalls).toEqual([
      { from: '2026-08-31', to: '2026-09-02', staffId: STAFF_ID },
    ]);
  });

  it('refuse en 404 une prestation inconnue de l’établissement', async () => {
    const { service } = createHarness({ view: null });

    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('refuse en 404 une prestation retirée du catalogue', async () => {
    const { service } = createHarness({ view: serviceView({ isActive: false }) });

    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      NotFoundError,
    );
  });

  it('émet appointment.created avec le tenant et l’intervalle facturé', async () => {
    const { service, events } = createHarness();
    const received: AppointmentCreatedEvent[] = [];
    events.onAppointmentCreated((event) => received.push(event));

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.name).toBe(APPOINTMENT_CREATED);
    expect(event?.tenantId).toBe(TENANT);
    expect(event?.appointmentId).toBe(view.id);
    expect(event?.clientId).toBe(view.clientId);
    expect(event?.staffId).toBe(STAFF_ID);
    expect(event?.serviceId).toBe(SERVICE_ID);
    // L'heure du soin, pas celle de la cabine : c'est ce qu'un e-mail de
    // confirmation annonce.
    expect(event?.startsAt).toBe('2026-09-01T10:00:00.000Z');
    expect(event?.endsAt).toBe('2026-09-01T11:00:00.000Z');
    expect(event?.occurredAt).toMatch(/Z$/);
  });

  it('n’émet rien quand la réservation échoue', async () => {
    const { service, events, repository } = createHarness();
    const received: AppointmentCreatedEvent[] = [];
    events.onAppointmentCreated((event) => received.push(event));
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: new Date('2026-09-01T09:00:00.000Z'),
      endsAt: new Date('2026-09-01T12:00:00.000Z'),
    });

    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      SlotNoLongerAvailableError,
    );
    expect(received).toHaveLength(0);
  });

  it('ne laisse pas un abonné fautif faire échouer une réservation déjà écrite', async () => {
    const { service, events, repository } = createHarness();
    events.onAppointmentCreated(() => {
      throw new Error('le module de notifications est tombé');
    });

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(view.id).toBeDefined();
    expect(repository.appointments).toHaveLength(1);
  });

  it('livre l’événement aux abonnés suivants même quand le premier lève', async () => {
    const { service, events } = createHarness();
    const received: AppointmentCreatedEvent[] = [];
    events.onAppointmentCreated(() => {
      throw new Error('le module de notifications est tombé');
    });
    events.onAppointmentCreated((event) => received.push(event));

    await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    // `EventEmitter.emit` appelle ses écouteurs en boucle : sans enveloppe, la
    // levée du premier interromprait la boucle et le second n'apprendrait jamais
    // qu'un rendez-vous a été pris.
    expect(received).toHaveLength(1);
  });

  it('rattrape le rejet d’un abonné asynchrone plutôt que de le laisser filer', async () => {
    const { service, events, loggedErrors } = createHarness();
    // La signature annonce `void`, et TypeScript accepte pourtant un abonné
    // `async` — ce que `notifications` sera. Son rejet survient après le retour
    // d'`emit` : non rattrapé, il abat le processus.
    events.onAppointmentCreated(async () => {
      await Promise.resolve();
      throw new Error('SES indisponible');
    });

    const view = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));
    // Le rejet est asynchrone : laisser la micro-file s'écouler avant d'observer.
    await Promise.resolve();

    expect(view.id).toBeDefined();
    expect(loggedErrors).toContain('domain event listener failed');
  });

  it('refuse d’écrire hors de toute portée de tenant', async () => {
    const { service } = createHarness();

    await expect(service.book(bookingInput(), NOW)).rejects.toThrow(/tenant/i);
  });
});

/**
 * L'option « premier disponible » — la **règle d'affectation** (#36).
 *
 * Ce que cette suite exerce est la seule partie du ticket qui soit une décision :
 * quel praticien reçoit le rendez-vous quand la cliente n'en désigne aucun, et ce
 * qui se passe quand la base refuse celui qu'on avait retenu.
 *
 * Ce qu'elle n'exerce **pas**, et qui est prouvé ailleurs :
 *
 * - l'agrégation des praticiens et l'ordre `(instant, praticien)` du moteur —
 *   `availability.slots.spec.ts` et `availability.service.spec.ts` ;
 * - qu'un praticien qui ne pratique pas la prestation n'apparaisse jamais dans
 *   les candidats — `availability.service.spec.ts`, sur le vrai calcul ;
 * - que le refus vienne réellement de la contrainte d'exclusion —
 *   `test/appointments-exclusion.integration-spec.ts`, contre un vrai PostgreSQL.
 */
describe('AppointmentsService.book — option « premier disponible » (#36)', () => {
  /** Les deux praticiens de la prestation, dans l'ordre où le moteur les rend. */
  const FIRST_STAFF = '11111111-1111-4111-8111-111111111111';
  const SECOND_STAFF = '22222222-2222-4222-8222-222222222222';
  const THIRD_STAFF = '33333333-3333-4333-8333-333333333333';

  /** Une réservation sans préférence de praticien. */
  function withoutPreference(): BookAppointmentInput {
    return bookingInput({ staffId: null });
  }

  /** L'intervalle **occupé** du créneau de 10:00 — celui que la base compare. */
  const OCCUPIED = {
    startsAt: new Date('2026-09-01T09:50:00.000Z'),
    endsAt: new Date('2026-09-01T11:10:00.000Z'),
  };

  it('interroge le calendrier sans praticien quand la cliente n’en désigne aucun', async () => {
    const { service, availabilityCalls } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });

    await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    // Pas de `staffId` dans la requête : c'est son absence qui fait rendre au
    // moteur **tous** les candidats de la prestation. Le poser à `undefined`
    // explicitement, ou à une valeur par défaut, amputerait la liste.
    expect(availabilityCalls).toEqual([{ from: '2026-08-31', to: '2026-09-02' }]);
  });

  it('affecte le premier praticien de l’ordre du moteur', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF, THIRD_STAFF],
    });

    const view = await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    expect(view.staffId).toBe(FIRST_STAFF);
    expect(repository.appointments).toHaveLength(1);
  });

  // « À agenda constant », et le double harnais est ce qui le dit : chacun part
  // d'un agenda vierge. Ce n'est **pas** de l'idempotence — deux envois sur le
  // *même* agenda donnent deux rendez-vous, ce que le cas de repli ci-dessous
  // montre, et ce que le front désarme (#45).
  it('est déterministe à agenda constant : deux demandes identiques désignent le même praticien', async () => {
    const first = createHarness({ candidates: [FIRST_STAFF, SECOND_STAFF] });
    const second = createHarness({ candidates: [FIRST_STAFF, SECOND_STAFF] });

    const one = await runWithTenant(TENANT, () => first.service.book(withoutPreference(), NOW));
    const two = await runWithTenant(TENANT, () => second.service.book(withoutPreference(), NOW));

    expect(one.staffId).toBe(two.staffId);
  });

  it('tente le praticien suivant quand la base refuse le créneau du premier', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    // Le créneau du premier praticien vient d'être pris — après le calcul du
    // calendrier, avant l'insertion. C'est exactement la course que le quatrième
    // critère du ticket décrit.
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });

    const view = await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    expect(view.staffId).toBe(SECOND_STAFF);
  });

  it('descend la liste jusqu’au premier praticien que la base accepte', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF, THIRD_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });
    repository.seedAppointment({ tenantId: TENANT, staffId: SECOND_STAFF, ...OCCUPIED });

    const view = await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    expect(view.staffId).toBe(THIRD_STAFF);
  });

  it('ne renvoie 409 qu’une fois tous les praticiens tentés', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });
    repository.seedAppointment({ tenantId: TENANT, staffId: SECOND_STAFF, ...OCCUPIED });

    const rejected = runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    await expect(rejected).rejects.toThrow(SlotNoLongerAvailableError);
    // Aucun rendez-vous de plus que les deux semés : le repli tente, il ne force
    // rien. La contrainte reste le seul arbitre.
    expect(repository.appointments).toHaveLength(2);
  });

  it('ne nomme aucun praticien dans le 409 d’une demande sans préférence', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });
    repository.seedAppointment({ tenantId: TENANT, staffId: SECOND_STAFF, ...OCCUPIED });

    const rejected = runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    // `null`, et non le dernier praticien tenté : rendre un identifiant que
    // l'appelant n'a jamais soumis ferait de ce 409 une sonde d'agenda.
    await expect(rejected).rejects.toMatchObject({
      details: { staffId: null, startsAt: '2026-09-01T10:00:00.000Z' },
    });
  });

  it('refuse en 409 un instant qu’aucun praticien ne proposait, sans rien écrire', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });

    const rejected = runWithTenant(TENANT, () =>
      service.book(
        bookingInput({ staffId: null, startsAt: new Date('2026-09-01T10:07:00.000Z') }),
        NOW,
      ),
    );

    await expect(rejected).rejects.toThrow(SlotNoLongerAvailableError);
    expect(repository.appointments).toHaveLength(0);
    // Le contrôle a lieu avant la résolution du client : un tir sur des créneaux
    // impossibles ne remplit pas le fichier clients du salon.
    expect(repository.clients).toHaveLength(0);
  });

  it('annonce dans l’événement de domaine le praticien réellement affecté', async () => {
    const { service, events, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });
    const received: AppointmentCreatedEvent[] = [];
    events.onAppointmentCreated((event) => received.push(event));

    await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    // Le second, pas le premier : la confirmation annonce à la cliente le
    // praticien qui l'attend, pas celui qu'on avait d'abord retenu.
    expect(received[0]?.staffId).toBe(SECOND_STAFF);
  });

  it('n’essaie personne d’autre quand la cliente a désigné un praticien', async () => {
    const { service, repository } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });

    const rejected = runWithTenant(TENANT, () =>
      service.book(bookingInput({ staffId: FIRST_STAFF }), NOW),
    );

    // Désigner quelqu'un, c'est refuser les autres : basculer sur le second
    // enverrait la cliente chez un praticien qu'elle n'a pas choisi.
    await expect(rejected).rejects.toMatchObject({ details: { staffId: FIRST_STAFF } });
    expect(repository.appointments).toHaveLength(1);
  });

  it('invalide le cache de disponibilité après un repli, comme après une réservation directe', async () => {
    const { service, repository, cache } = createHarness({
      candidates: [FIRST_STAFF, SECOND_STAFF],
    });
    repository.seedAppointment({ tenantId: TENANT, staffId: FIRST_STAFF, ...OCCUPIED });

    await runWithTenant(TENANT, () => service.book(withoutPreference(), NOW));

    expect(cache.calls).toBe(1);
  });
});

/**
 * Le report — la décision, sans HTTP et sans base (#39).
 *
 * Ce que cette suite exerce, et qu'aucune autre ne voit : que le report est bien
 * **une annulation suivie d'une création liée**, que ce qui ne se reporte pas est
 * refusé sans que rien ne bouge, et qu'un créneau d'arrivée refusé laisse la
 * cliente avec son rendez-vous d'origine plutôt qu'avec rien.
 *
 * L'atomicité elle-même appartient à PostgreSQL, et c'est
 * `test/appointments-exclusion.integration-spec.ts` qui l'exerce contre un vrai
 * moteur. Le double reproduit son **effet observable** — un refus ne laisse
 * aucune trace — et rien de plus.
 */
describe('AppointmentsService.reschedule', () => {
  /** Le nouveau créneau : le soin passerait de 10:00 à 14:00 UTC. */
  const MOVED_START = new Date('2026-09-01T14:00:00.000Z');

  /** L'intervalle **occupé** correspondant, tampons compris. */
  const MOVED_OCCUPIED = {
    startsAt: new Date('2026-09-01T13:50:00.000Z'),
    endsAt: new Date('2026-09-01T15:10:00.000Z'),
  } as const;

  /** Un harnais où le calendrier propose l'ancien créneau **et** le nouveau. */
  function movableHarness(): Harness {
    return createHarness({ offered: [BILLED_START, MOVED_START] });
  }

  /**
   * Un rendez-vous déjà pris à 10:00 chez `STAFF_ID`, dans son intervalle
   * occupé — la forme que la base porte réellement.
   */
  function seedBooked(
    repository: FakeAppointmentsRepository,
    overrides: { status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' } = {},
  ): { id: string } {
    return repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      serviceId: SERVICE_ID,
      startsAt: new Date('2026-09-01T09:50:00.000Z'),
      endsAt: new Date('2026-09-01T11:10:00.000Z'),
      ...overrides,
    });
  }

  it('annule l’ancien rendez-vous et en crée un nouveau qui le référence', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);

    const view = await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    // Deux lignes, pas une : l'historique montre les deux rendez-vous et leur
    // lien, ce qu'un `UPDATE` des dates aurait effacé.
    expect(repository.appointments).toHaveLength(2);
    expect(repository.appointments[0]?.status).toBe('CANCELLED');
    expect(view.id).not.toBe(previous.id);
    expect(view.rescheduledFromId).toBe(previous.id);
    expect(view.startsAt).toBe('2026-09-01T14:00:00.000Z');
    expect(view.endsAt).toBe('2026-09-01T15:00:00.000Z');
  });

  it('enregistre pour le nouveau créneau une durée qui inclut les deux tampons', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    const created = repository.appointments[1];
    expect(created?.startsAt.toISOString()).toBe(MOVED_OCCUPIED.startsAt.toISOString());
    expect(created?.endsAt.toISOString()).toBe(MOVED_OCCUPIED.endsAt.toISOString());
  });

  it('reprend la cliente, la prestation et le prix figé du rendez-vous remplacé', async () => {
    const { service, repository } = movableHarness();
    // Réserver d'abord plutôt que semer : c'est la réservation qui fige le prix,
    // et c'est ce prix-là que le report doit reconduire.
    const booked = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    const view = await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: booked.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    expect(view.clientId).toBe(booked.clientId);
    expect(view.serviceId).toBe(booked.serviceId);
    expect(view.price).toEqual({ amountMinor: 7500, currency: 'EUR' });
    // Reporter ne crée pas une seconde fiche cliente.
    expect(repository.clients).toHaveLength(1);
  });

  it('reprend le statut du rendez-vous remplacé : un confirmé le reste', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository, { status: 'CONFIRMED' });

    const view = await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    // Déplacer un créneau n'annule pas une confirmation déjà obtenue.
    expect(view.status).toBe('CONFIRMED');
  });

  it('change de praticien quand la demande en désigne un autre', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);
    const other = randomUUID();

    const view = await runWithTenant(TENANT, () =>
      service.reschedule(
        { appointmentId: previous.id, startsAt: MOVED_START, staffId: other },
        NOW,
      ),
    );

    expect(view.staffId).toBe(other);
    expect(repository.appointments[1]?.staffId).toBe(other);
  });

  it('laisse l’ancien rendez-vous intact quand le créneau d’arrivée est pris', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: MOVED_OCCUPIED.startsAt,
      endsAt: MOVED_OCCUPIED.endsAt,
    });

    const rejected = runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    await expect(rejected).rejects.toThrow(SlotNoLongerAvailableError);
    // Le troisième critère de #39 : un échec ne laisse jamais une cliente sans
    // rendez-vous du tout.
    const kept = repository.appointments.find((candidate) => candidate.id === previous.id);
    expect(kept?.status).toBe('PENDING');
    expect(repository.appointments).toHaveLength(2);
  });

  it('rend dans le 409 l’heure du soin demandée, pas l’heure occupée', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: MOVED_OCCUPIED.startsAt,
      endsAt: MOVED_OCCUPIED.endsAt,
    });

    const rejected = runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    await expect(rejected).rejects.toMatchObject({
      details: { staffId: STAFF_ID, startsAt: '2026-09-01T14:00:00.000Z' },
    });
  });

  it('refuse en 409 un instant que le calendrier ne proposait pas', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository);

    const rejected = runWithTenant(TENANT, () =>
      service.reschedule(
        { appointmentId: previous.id, startsAt: new Date('2026-09-01T14:07:00.000Z'), staffId: null },
        NOW,
      ),
    );

    await expect(rejected).rejects.toThrow(SlotNoLongerAvailableError);
    expect(repository.appointments).toHaveLength(1);
    expect(repository.appointments[0]?.status).toBe('PENDING');
  });

  it('refuse en 404 un rendez-vous inconnu de l’établissement', async () => {
    const { service, repository } = movableHarness();

    const rejected = runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: randomUUID(), startsAt: MOVED_START, staffId: null }, NOW),
    );

    await expect(rejected).rejects.toThrow(NotFoundError);
    expect(repository.appointments).toHaveLength(0);
  });

  it('refuse en 422 un rendez-vous qui n’occupe plus son créneau', async () => {
    const { service, repository } = movableHarness();
    const previous = seedBooked(repository, { status: 'CANCELLED' });

    const rejected = runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    // Terminé, annulé ou no-show : il n'y a plus de créneau à déplacer, et en
    // créer un à cette occasion serait une réservation déguisée.
    await expect(rejected).rejects.toThrow(InvalidStateTransitionError);
    expect(repository.appointments).toHaveLength(1);
  });

  it('émet appointment.rescheduled avec les deux créneaux facturés', async () => {
    const { service, events, repository } = movableHarness();
    const received: AppointmentRescheduledEvent[] = [];
    events.onAppointmentRescheduled((event) => received.push(event));
    const previous = seedBooked(repository);

    const view = await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.name).toBe(APPOINTMENT_RESCHEDULED);
    expect(event?.tenantId).toBe(TENANT);
    expect(event?.appointmentId).toBe(view.id);
    expect(event?.previousAppointmentId).toBe(previous.id);
    expect(event?.serviceId).toBe(SERVICE_ID);
    expect(event?.staffId).toBe(STAFF_ID);
    expect(event?.previousStaffId).toBe(STAFF_ID);
    // Les heures du soin des deux côtés : c'est ce qu'un avis de déplacement
    // annonce — l'ancienne et la nouvelle, jamais les heures de cabine.
    expect(event?.startsAt).toBe('2026-09-01T14:00:00.000Z');
    expect(event?.endsAt).toBe('2026-09-01T15:00:00.000Z');
    expect(event?.previousStartsAt).toBe('2026-09-01T10:00:00.000Z');
    expect(event?.previousEndsAt).toBe('2026-09-01T11:00:00.000Z');
    expect(event?.occurredAt).toMatch(/Z$/);
  });

  it('n’émet aucun `appointment.created` sur un report', async () => {
    const { service, events, repository } = movableHarness();
    const created: AppointmentCreatedEvent[] = [];
    events.onAppointmentCreated((event) => created.push(event));
    const previous = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    // L'aval n'enverrait pas la même chose : une création demande une
    // confirmation, un report demande un avis de déplacement et l'annulation du
    // rappel J-1 déjà planifié.
    expect(created).toHaveLength(0);
  });

  it('n’émet rien quand le report échoue', async () => {
    const { service, events, repository } = movableHarness();
    const received: AppointmentRescheduledEvent[] = [];
    events.onAppointmentRescheduled((event) => received.push(event));
    const previous = seedBooked(repository);
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      startsAt: MOVED_OCCUPIED.startsAt,
      endsAt: MOVED_OCCUPIED.endsAt,
    });

    await expect(
      runWithTenant(TENANT, () =>
        service.reschedule(
          { appointmentId: previous.id, startsAt: MOVED_START, staffId: null },
          NOW,
        ),
      ),
    ).rejects.toThrow(SlotNoLongerAvailableError);

    expect(received).toHaveLength(0);
  });

  it('refuse de reporter hors de toute portée de tenant', async () => {
    const { service } = movableHarness();

    await expect(
      service.reschedule({ appointmentId: randomUUID(), startsAt: MOVED_START, staffId: null }, NOW),
    ).rejects.toThrow(/tenant/i);
  });
});

/**
 * L'annulation — la décision, sans HTTP et sans base (#40).
 *
 * Ce que cette suite exerce, et qu'aucune autre ne voit :
 *
 * 1. la **trace** est écrite d'un seul geste — statut, horodatage, auteur,
 *    motif —, et l'horodatage est celui de l'horloge passée, jamais celui de la
 *    machine ;
 * 2. `cancelledBy` vient de l'appelant du service — donc de la **porte** — et
 *    rien du corps de la requête ne peut le contredire ;
 * 3. le créneau libéré est **immédiatement** reréservable, sans que la porte
 *    s'ouvre pour autant à une double réservation ;
 * 4. un rendez-vous qui n'occupe plus est refusé en 422 par le service dédié, et
 *    rien n'est écrit ;
 * 5. le motif **n'est rendu par aucune vue** et ne part dans **aucun** événement.
 */
describe('AppointmentsService.cancel', () => {
  /** L'instant où l'annulation est demandée — l'horloge de l'appelant. */
  const CANCELLED_AT = new Date('2026-08-31T09:15:00.000Z');

  /**
   * Un rendez-vous déjà pris à 10:00 chez `STAFF_ID`, dans son intervalle
   * occupé — la forme que la base porte réellement.
   */
  function seedBooked(
    repository: FakeAppointmentsRepository,
    overrides: { status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' } = {},
  ): { id: string } {
    return repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      serviceId: SERVICE_ID,
      startsAt: new Date('2026-09-01T09:50:00.000Z'),
      endsAt: new Date('2026-09-01T11:10:00.000Z'),
      ...overrides,
    });
  }

  it('consigne le statut, l’horodatage, l’auteur et le motif', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository);

    const view = await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'CLIENT', reason: 'Empêchement' },
        CANCELLED_AT,
      ),
    );

    expect(view.status).toBe('CANCELLED');
    const stored = repository.appointments[0];
    expect(stored?.status).toBe('CANCELLED');
    // L'horloge de l'appelant, et non celle de la machine : c'est ce qui rend
    // l'horodatage observable sans avoir à décaler celle du système.
    expect(stored?.cancelledAt?.toISOString()).toBe('2026-08-31T09:15:00.000Z');
    expect(stored?.cancelledBy).toBe('CLIENT');
    expect(stored?.cancellationReason).toBe('Empêchement');
  });

  it('accepte une annulation sans motif — `null`, jamais une chaîne vide', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.cancel({ appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null }, CANCELLED_AT),
    );

    // Le CDC n'exige de motif d'aucun côté : l'imposer ferait abandonner des
    // annulations, donc laisserait des créneaux fantômes bloqués.
    expect(repository.appointments[0]?.cancellationReason).toBeNull();
  });

  it('inscrit `STAFF` quand c’est le salon qui annule', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository, { status: 'CONFIRMED' });

    const view = await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'STAFF', reason: 'Praticien souffrant' },
        CANCELLED_AT,
      ),
    );

    // C'est le seul chiffre que cette colonne existe pour établir (CDC §1.4) :
    // une cliente qui se décommande et un salon qui ferme sa journée ne se
    // lisent pas de la même façon dans un taux d'annulation.
    expect(view.cancelledBy).toBe('STAFF');
    expect(repository.appointments[0]?.cancelledBy).toBe('STAFF');
  });

  it('rend la trace structurelle mais **jamais** le motif', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository);

    const view = await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'STAFF', reason: 'Cliente injoignable' },
        CANCELLED_AT,
      ),
    );

    expect(view.cancelledAt).toBe('2026-08-31T09:15:00.000Z');
    expect(view.cancelledBy).toBe('STAFF');
    // La vue est la sortie unique du module, servie au comptoir comme au
    // parcours public : un motif écrit par un praticien est une note interne.
    expect(JSON.stringify(view)).not.toContain('Cliente injoignable');
  });

  it('libère le créneau : il redevient réservable immédiatement', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository);

    // Tant qu'il occupe, le créneau est refusé…
    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      SlotNoLongerAvailableError,
    );

    await runWithTenant(TENANT, () =>
      service.cancel({ appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null }, CANCELLED_AT),
    );

    // …et dès qu'il n'occupe plus, il l'est. Troisième critère de #40 — tenu par
    // le filtre partiel de la contrainte, pas par une purge applicative.
    const rebooked = await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));
    expect(rebooked.status).toBe('PENDING');
    expect(rebooked.startsAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('n’ouvre pas la porte à une double réservation sur le créneau libéré', async () => {
    const { service, repository } = createHarness();
    const booked = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.cancel({ appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null }, CANCELLED_AT),
    );
    await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    // Le créneau a été **rendu**, il n'a pas été ouvert : la seconde réservation
    // se heurte à la première exactement comme avant l'annulation.
    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      SlotNoLongerAvailableError,
    );
  });

  it('refuse en 404 un rendez-vous inconnu de l’établissement', async () => {
    const { service, repository } = createHarness();

    await expect(
      runWithTenant(TENANT, () =>
        service.cancel(
          { appointmentId: randomUUID(), cancelledBy: 'CLIENT', reason: null },
          CANCELLED_AT,
        ),
      ),
    ).rejects.toThrow(NotFoundError);
    expect(repository.appointments).toHaveLength(0);
  });

  it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'] as const)(
    'refuse en 422 un rendez-vous %s, sans rien écrire',
    async (status) => {
      const { service, repository } = createHarness();
      const booked = seedBooked(repository, { status });

      await expect(
        runWithTenant(TENANT, () =>
          service.cancel(
            { appointmentId: booked.id, cancelledBy: 'STAFF', reason: 'trop tard' },
            CANCELLED_AT,
          ),
        ),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Le refus vient du service de cycle de vie, **avant** toute écriture :
      // rien n'est horodaté, aucun auteur ni motif n'est inscrit.
      const stored = repository.appointments[0];
      expect(stored?.status).toBe(status);
      expect(stored?.cancelledAt).toBeNull();
      expect(stored?.cancelledBy).toBeNull();
      expect(stored?.cancellationReason).toBeNull();
    },
  );

  it('émet `appointment.cancelled` avec le créneau facturé et le statut d’avant', async () => {
    const { service, events, repository } = createHarness();
    const received: AppointmentCancelledEvent[] = [];
    events.onAppointmentCancelled((event) => received.push(event));
    const booked = seedBooked(repository, { status: 'CONFIRMED' });

    const view = await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'CLIENT', reason: 'Grippe' },
        CANCELLED_AT,
      ),
    );

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.name).toBe(APPOINTMENT_CANCELLED);
    expect(event?.tenantId).toBe(TENANT);
    expect(event?.appointmentId).toBe(view.id);
    expect(event?.serviceId).toBe(SERVICE_ID);
    expect(event?.staffId).toBe(STAFF_ID);
    // Les heures du **soin**, tampons exclus : c'est l'heure que la cliente
    // avait notée, et celle que l'avis d'annulation doit rappeler.
    expect(event?.startsAt).toBe('2026-09-01T10:00:00.000Z');
    expect(event?.endsAt).toBe('2026-09-01T11:00:00.000Z');
    // Le statut d'**avant** : c'est lui qui dit à l'aval s'il y avait un rappel
    // J-1 à déprogrammer. Un `PENDING` n'en a jamais eu.
    expect(event?.previousStatus).toBe('CONFIRMED');
    expect(event?.cancelledBy).toBe('CLIENT');
    expect(event?.cancelledAt).toBe('2026-08-31T09:15:00.000Z');
    expect(event?.occurredAt).toMatch(/Z$/);
  });

  it('ne fait voyager le motif dans aucun événement', async () => {
    const { service, events, repository } = createHarness();
    const received: AppointmentCancelledEvent[] = [];
    events.onAppointmentCancelled((event) => received.push(event));
    const booked = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'STAFF', reason: 'hospitalisation de la cliente' },
        CANCELLED_AT,
      ),
    );

    // Un événement circule, se journalise et se rejoue. Un texte libre écrit par
    // un humain peut contenir n'importe quoi — un état de santé, le nom d'un
    // tiers : il reste sur la ligne (CDC §5.1).
    expect(JSON.stringify(received)).not.toContain('hospitalisation');
  });

  it('n’émet rien quand l’annulation est refusée', async () => {
    const { service, events, repository } = createHarness();
    const received: AppointmentCancelledEvent[] = [];
    events.onAppointmentCancelled((event) => received.push(event));
    const booked = seedBooked(repository, { status: 'COMPLETED' });

    await expect(
      runWithTenant(TENANT, () =>
        service.cancel(
          { appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null },
          CANCELLED_AT,
        ),
      ),
    ).rejects.toThrow(InvalidStateTransitionError);

    expect(received).toHaveLength(0);
  });

  it('n’émet ni `appointment.created` ni `appointment.rescheduled` sur une annulation', async () => {
    const { service, events, repository } = createHarness();
    const created: AppointmentCreatedEvent[] = [];
    const rescheduled: AppointmentRescheduledEvent[] = [];
    events.onAppointmentCreated((event) => created.push(event));
    events.onAppointmentRescheduled((event) => rescheduled.push(event));
    const booked = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.cancel({ appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null }, CANCELLED_AT),
    );

    // L'aval n'enverrait pas la même chose : une annulation demande un avis
    // d'annulation **et** la déprogrammation du rappel J-1.
    expect(created).toHaveLength(0);
    expect(rescheduled).toHaveLength(0);
  });

  it('refuse d’annuler hors de toute portée de tenant', async () => {
    const { service } = createHarness();

    await expect(
      service.cancel(
        { appointmentId: randomUUID(), cancelledBy: 'CLIENT', reason: null },
        CANCELLED_AT,
      ),
    ).rejects.toThrow(/tenant/i);
  });
});

/**
 * Invalidation du cache de disponibilité — #35, troisième critère.
 *
 * Ce qui se vérifie ici n'est pas qu'un cache est vide : le comportement de
 * l'entrepôt a ses propres suites. C'est que **les trois écritures d'agenda de
 * ce service appellent l'invalidation**. C'est la propriété qui s'oublie, parce
 * qu'elle ne se manifeste nulle part dans la réponse : elle se voit une minute
 * plus tard, sur un calendrier public qui propose encore un créneau pris — ou,
 * ce qui coûte plus cher, qui masque encore un créneau qu'une annulation vient
 * de libérer.
 *
 * Les trois autres écritures d'agenda ont la même vérification chez elles :
 * absences (#33), horaires et jours de fermeture (#35).
 */
describe('AppointmentsService — invalidation du cache de disponibilité', () => {
  const MOVED_START = new Date('2026-09-01T14:00:00.000Z');
  const CANCELLED_AT = new Date('2026-08-31T09:15:00.000Z');

  function seedBooked(repository: FakeAppointmentsRepository): { id: string } {
    return repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF_ID,
      serviceId: SERVICE_ID,
      startsAt: new Date('2026-09-01T09:50:00.000Z'),
      endsAt: new Date('2026-09-01T11:10:00.000Z'),
    });
  }

  it('chasse le cache après une réservation', async () => {
    const { service, cache } = createHarness();

    await runWithTenant(TENANT, () => service.book(bookingInput(), NOW));

    expect(cache.calls).toBe(1);
  });

  it('chasse le cache après un report', async () => {
    // Un report change deux créneaux d'un coup : celui qu'il libère et celui
    // qu'il occupe. Une seule invalidation suffit — elle porte sur le tenant.
    const { service, repository, cache } = createHarness({
      offered: [BILLED_START, MOVED_START],
    });
    const previous = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.reschedule({ appointmentId: previous.id, startsAt: MOVED_START, staffId: null }, NOW),
    );

    expect(cache.calls).toBe(1);
  });

  it('chasse le cache après une annulation', async () => {
    // Le cas où l'invalidation rapporte le plus : le créneau est réservable dès
    // le `COMMIT`, mais invisible tant que le cache ne l'a pas appris.
    const { service, repository, cache } = createHarness();
    const booked = seedBooked(repository);

    await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: booked.id, cancelledBy: 'CLIENT', reason: null },
        CANCELLED_AT,
      ),
    );

    expect(cache.calls).toBe(1);
  });

  it('n’invalide rien quand le créneau est refusé', async () => {
    // Rien n'a été écrit : chasser le cache ferait payer un recalcul complet à
    // tout l'établissement pour une réservation qui n'a pas eu lieu.
    const { service, cache } = createHarness({ offered: [] });

    await expect(runWithTenant(TENANT, () => service.book(bookingInput(), NOW))).rejects.toThrow(
      SlotNoLongerAvailableError,
    );

    expect(cache.calls).toBe(0);
  });
});
