import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AvailabilityService } from '../../availability/availability.service';
import type { AvailabilityView } from '../../availability/availability.types';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import { SlotNoLongerAvailableError } from '../appointments.errors';
import { AppointmentsService } from '../appointments.service';
import type { BookAppointmentInput } from '../appointments.types';
import { APPOINTMENT_CREATED, type AppointmentCreatedEvent } from '../events/appointment-created.event';
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
function fakeAvailability(offered: readonly Date[]): {
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

      return Promise.resolve({
        serviceId: query.serviceId,
        timezone: 'Europe/Paris',
        days: [
          {
            date: '2026-09-01',
            slots: offered.map((startsAt) => ({
              startsAt: startsAt.toISOString(),
              endsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(),
              staffId: STAFF_ID,
            })),
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
  loggedErrors: string[];
}

function createHarness(
  options: { view?: ServiceView | null; offered?: readonly Date[] } = {},
): Harness {
  const repository = new FakeAppointmentsRepository();
  const journal = recordingLogger();
  const events = new AppointmentEvents(journal.logger);
  const availability = fakeAvailability(options.offered ?? [BILLED_START]);
  const view = options.view === undefined ? serviceView() : options.view;

  return {
    service: new AppointmentsService(
      repository.asRepository(),
      fakeCatalog(view),
      availability.service,
      events,
    ),
    repository,
    events,
    availabilityCalls: availability.calls,
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
