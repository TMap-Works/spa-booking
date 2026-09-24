import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { runWithTenant } from '../../../common/tenant';
import type { AvailabilityService } from '../../availability/availability.service';
import { TenantClockService } from '../../availability/tenant-clock.service';
import { SpyAvailabilityCache } from '../../availability/__tests__/staff-time-off.doubles';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import { AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { OUTCOME_STATUSES } from '../appointment-status';
import { AppointmentNotStartedError } from '../appointments.errors';
import { AppointmentsService } from '../appointments.service';
import type { AppointmentActor } from '../appointments.types';
import { AppointmentEvents } from '../events/appointment-events';
import type { AppointmentStatusChangedEvent } from '../events/appointment-status-changed.event';
import { FakeAppointmentsRepository, FakeCacheLocks } from './appointments.doubles';

/**
 * « Honoré » et « non présenté » ne s'écrivent pas d'avance — #1137, bout en
 * bout.
 *
 * `appointment-lifecycle.spec.ts` prouve la **règle** ; cette suite-ci prouve
 * que le chemin d'écriture la respecte, et surtout qu'il ne laisse **rien**
 * derrière lui quand elle refuse. C'est ce qui compte : les deux statuts sont
 * terminaux et libèrent le créneau, si bien qu'un clic prématuré ne se reprend
 * pas — la campagne QA du 22/09 lisait un taux de no-show de 66,7 % sur un mois
 * d'octobre dont aucun rendez-vous n'avait encore eu lieu, et une « dernière
 * visite » datée du futur sur la fiche de la cliente.
 *
 * Quatre traces, donc, et aucune ne doit exister après le refus : la ligne, le
 * cache de disponibilité, l'événement de domaine, et le compte des écritures.
 */

const TENANT = randomUUID();
const SERVICE_ID = randomUUID();
const CLIENT = randomUUID();
const STAFF = randomUUID();

/** Le rendez-vous d'octobre de la campagne — dans le futur au moment du clic. */
const STARTS_AT = new Date('2026-10-14T08:00:00.000Z');
const ENDS_AT = new Date('2026-10-14T09:00:00.000Z');

/** L'instant du clic : trois jours avant le soin. */
const AVANT = new Date('2026-10-11T08:00:00.000Z');

/** Le même geste, une fois le soin commencé. */
const PENDANT = new Date('2026-10-14T08:30:00.000Z');

const GERANTE: AppointmentActor = { userId: randomUUID(), role: 'MANAGER' };

/**
 * La prestation, **complète** : l'annulation compose sa réponse à partir des
 * tampons du catalogue, et un double réduit à son identifiant produirait un
 * intervalle facturé invalide — un `Invalid time value` qui n'apprendrait rien
 * sur la règle jugée ici.
 */
function serviceView(bufferBeforeMinutes = 0): ServiceView {
  return {
    id: SERVICE_ID,
    slug: 'massage-60',
    name: 'Massage 60 min',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes,
    bufferAfterMinutes: 0,
    price: { amountMinor: 7500, currency: 'EUR' },
    isActive: true,
  } as unknown as ServiceView;
}

interface Harness {
  readonly service: AppointmentsService;
  readonly repository: FakeAppointmentsRepository;
  readonly cache: SpyAvailabilityCache;
  readonly annonces: AppointmentStatusChangedEvent[];
  readonly appointmentId: string;
}

/**
 * `bufferBeforeMinutes` est un **paramètre** parce que la règle se mesure sur le
 * début du soin et non sur la colonne : `STARTS_AT` est l'intervalle occupé, et
 * l'heure annoncée à la cliente est ce début-là plus le tampon de préparation
 * (`billed-interval.ts`). À zéro, les deux se confondent et le cas ne verrait pas
 * la différence.
 */
function createHarness(bufferBeforeMinutes = 0): Harness {
  const repository = new FakeAppointmentsRepository();
  const logger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as StructuredLogger;

  const events = new AppointmentEvents(logger);
  const annonces: AppointmentStatusChangedEvent[] = [];
  events.onAppointmentStatusChanged((event) => annonces.push(event));

  const cache = new SpyAvailabilityCache();

  const service = new AppointmentsService(
    repository.asRepository(),
    { byId: async () => serviceView(bufferBeforeMinutes) } as unknown as ServicesService,
    { forService: async () => ({ slots: [] }) } as unknown as AvailabilityService,
    events,
    new AppointmentLifecycleService(),
    cache.asService(),
    new FakeCacheLocks().asService(),
    new TenantClockService(),
  );

  const { id } = repository.seedAppointment({
    tenantId: TENANT,
    staffId: STAFF,
    clientId: CLIENT,
    serviceId: SERVICE_ID,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    status: 'CONFIRMED',
  });

  return { service, repository, cache, annonces, appointmentId: id };
}

describe('changeStatus — le constat d’un rendez-vous qui n’a pas commencé', () => {
  it.each(OUTCOME_STATUSES)('refuse %s en 422, sans rien écrire', async (status) => {
    const { service, repository, appointmentId } = createHarness();

    const refus = await runWithTenant(TENANT, () =>
      service
        .changeStatus({ appointmentId, status, reason: null, actor: GERANTE }, AVANT)
        .catch((error: unknown) => error),
    );

    expect(refus).toBeInstanceOf(AppointmentNotStartedError);
    const erreur = refus as AppointmentNotStartedError;
    expect({ code: erreur.code, status: erreur.status }).toEqual({
      code: 'INVALID_STATE_TRANSITION',
      status: 422,
    });
    expect(erreur.details).toMatchObject({ notStarted: true, to: status });

    // La ligne n'a pas bougé — et c'est tout l'enjeu : `COMPLETED` et `NO_SHOW`
    // sont terminaux, une écriture prématurée aurait été définitive.
    const ligne = repository.appointments.find((row) => row.id === appointmentId);
    expect(ligne?.status).toBe('CONFIRMED');
  });

  it('ne libère pas le créneau et n’annonce rien quand il refuse', async () => {
    const { service, cache, annonces, appointmentId } = createHarness();

    await runWithTenant(TENANT, () =>
      service
        .changeStatus({ appointmentId, status: 'NO_SHOW', reason: null, actor: GERANTE }, AVANT)
        .catch(() => undefined),
    );

    // Le créneau reste occupé : une invalidation de cache aurait annoncé aux
    // parcours de réservation un créneau que la contrainte d'exclusion refuse
    // toujours, et l'événement aurait fait basculer « à venir » en « passé » sur
    // l'écran de la cliente (#800).
    expect(cache.calls).toBe(0);
    expect(annonces).toEqual([]);
  });

  it.each(OUTCOME_STATUSES)('accepte %s dès que le soin a commencé', async (status) => {
    const { service, repository, cache, annonces, appointmentId } = createHarness();

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus({ appointmentId, status, reason: null, actor: GERANTE }, PENDANT),
    );

    expect(String(view.status).toUpperCase()).toBe(status);
    expect(repository.appointments.find((row) => row.id === appointmentId)?.status).toBe(status);
    // Le créneau quitte le filtre partiel de `appointments_no_overlap` : il
    // redevient vendable, et le cache doit le savoir tout de suite (#35).
    expect(cache.calls).toBe(1);
    expect(annonces.map((event) => event.status)).toEqual([status]);
  });

  it('mesure le début du soin, et non la colonne occupée', async () => {
    // `appointments.starts_at` est l'intervalle **occupé** : il commence au
    // tampon de préparation, donc *avant* l'heure annoncée à la cliente
    // (`billed-interval.ts`, #750). Avec dix minutes de cabine, la ligne semée à
    // 08 h 00 est un rendez-vous de 08 h 10 : comparer l'horloge à la colonne
    // aurait laissé marquer « non présenté » à 08 h 05, dix minutes avant que la
    // cliente soit attendue — et le geste est terminal.
    const { service, repository, cache, annonces, appointmentId } = createHarness(10);

    const refus = await runWithTenant(TENANT, () =>
      service
        .changeStatus(
          { appointmentId, status: 'NO_SHOW', reason: null, actor: GERANTE },
          new Date('2026-10-14T08:05:00.000Z'),
        )
        .catch((error: unknown) => error),
    );

    expect(refus).toBeInstanceOf(AppointmentNotStartedError);
    // Et l'heure rendue au comptoir est celle qu'il a sous les yeux — l'heure du
    // soin —, jamais la cadence interne du salon.
    expect((refus as AppointmentNotStartedError).details).toMatchObject({
      startsAt: '2026-10-14T08:10:00.000Z',
      notStarted: true,
    });
    expect(repository.appointments.find((row) => row.id === appointmentId)?.status).toBe(
      'CONFIRMED',
    );
    expect(cache.calls).toBe(0);
    expect(annonces).toEqual([]);
  });

  it('accepte dès le début du soin, le tampon de préparation écoulé', async () => {
    const { service, appointmentId } = createHarness(10);

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId, status: 'NO_SHOW', reason: null, actor: GERANTE },
        new Date('2026-10-14T08:10:00.000Z'),
      ),
    );

    expect(String(view.status).toUpperCase()).toBe('NO_SHOW');
  });

  it('laisse annuler un rendez-vous à venir — annuler est une décision, pas un constat', async () => {
    // La garantie inverse, et elle compte autant : étendre la règle à
    // `CANCELLED` aurait supprimé l'annulation, qui se prend par définition
    // avant l'heure du soin.
    const { service, appointmentId } = createHarness();

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId, status: 'CANCELLED', reason: 'Cliente injoignable', actor: GERANTE },
        AVANT,
      ),
    );

    expect(String(view.status).toUpperCase()).toBe('CANCELLED');
  });

  it('laisse confirmer un rendez-vous à venir', async () => {
    const { service, repository } = createHarness();
    const { id } = repository.seedAppointment({
      tenantId: TENANT,
      staffId: STAFF,
      clientId: CLIENT,
      serviceId: SERVICE_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      status: 'PENDING',
    });

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus({ appointmentId: id, status: 'CONFIRMED', reason: null, actor: GERANTE }, AVANT),
    );

    expect(String(view.status).toUpperCase()).toBe('CONFIRMED');
  });
});
