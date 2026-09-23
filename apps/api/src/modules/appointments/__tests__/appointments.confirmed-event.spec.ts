import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { TenantClockService } from '../../availability/tenant-clock.service';
import { SpyAvailabilityCache } from '../../availability/__tests__/staff-time-off.doubles';
import type { AvailabilityService } from '../../availability/availability.service';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import { AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { AppointmentsService } from '../appointments.service';
import type { AppointmentActor } from '../appointments.types';
import type { AppointmentConfirmedEvent } from '../events/appointment-confirmed.event';
import { AppointmentEvents } from '../events/appointment-events';
import type { AppointmentStatusChangedEvent } from '../events/appointment-status-changed.event';
import { FakeAppointmentsRepository, FakeCacheLocks } from './appointments.doubles';

/**
 * `appointment.confirmed` — #800.
 *
 * C'est le salon qui confirme un rendez-vous (arbitrage du PO du 19/09), et cet
 * événement est ce qui permet à `notifications` de le faire savoir à la cliente.
 * Ce que cette suite fixe tient en trois propriétés :
 *
 * 1. `PENDING → CONFIRMED` l'émet, **une** fois, avec de quoi joindre la
 *    cliente et rouvrir la portée de tenant ;
 * 2. aucune autre transition ne l'émet — « honoré » n'est pas « confirmé » ;
 * 3. une confirmation qui perd une course ne l'émet pas : elle n'a rien
 *    confirmé, et la cliente ne doit pas recevoir deux fois le message.
 */

const TENANT = randomUUID();
const SERVICE_ID = randomUUID();
const CLIENT = randomUUID();

const CLAIRE_USER = randomUUID();
const CLAIRE_STAFF = randomUUID();

const STARTS = new Date('2026-09-01T10:00:00.000Z');
const ENDS = new Date('2026-09-01T11:00:00.000Z');
const NOW = new Date('2026-08-31T08:00:00.000Z');

/**
 * Le soin a commencé. « Honoré » et « non présenté » constatent ce qui s'est
 * passé, et le cycle de vie les refuse avant l'heure du rendez-vous (#1137) :
 * les cas qui les exercent ont donc besoin d'une horloge qui l'a dépassée.
 * La confirmation, elle, garde `NOW` — elle précède toujours le soin.
 */
const PENDANT_LE_SOIN = new Date('2026-09-01T10:30:00.000Z');

const GERANTE: AppointmentActor = { userId: randomUUID(), role: 'MANAGER' };
const PRATICIENNE: AppointmentActor = { userId: CLAIRE_USER, role: 'STAFF' };

function createHarness() {
  const repository = new FakeAppointmentsRepository();
  const logger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as StructuredLogger;
  const events = new AppointmentEvents(logger);
  const received: AppointmentConfirmedEvent[] = [];
  events.onAppointmentConfirmed((event) => received.push(event));

  const service = new AppointmentsService(
    repository.asRepository(),
    // Les deux tampons et la durée, et non le seul identifiant : le début du
    // soin s'en déduit (`billed-interval.ts`), et c'est lui que la règle
    // d'horloge de #1137 compare à l'instant du geste.
    {
      byId: async () =>
        ({
          id: SERVICE_ID,
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
        }) as unknown as ServiceView,
    } as unknown as ServicesService,
    { forService: async () => ({ slots: [] }) } as unknown as AvailabilityService,
    events,
    new AppointmentLifecycleService(),
    new SpyAvailabilityCache().asService(),
    new FakeCacheLocks().asService(),
    new TenantClockService(),
  );

  repository.seedStaffProfile({
    tenantId: TENANT,
    staffId: CLAIRE_STAFF,
    userId: CLAIRE_USER,
    displayName: 'Claire',
  });

  const seed = (status: 'PENDING' | 'CONFIRMED'): string =>
    repository.seedAppointment({
      tenantId: TENANT,
      staffId: CLAIRE_STAFF,
      clientId: CLIENT,
      serviceId: SERVICE_ID,
      startsAt: STARTS,
      endsAt: ENDS,
      status,
    }).id;

  return { service, received, seed, events };
}

describe('appointment.confirmed — la confirmation du salon est annoncée', () => {
  it('est émis quand la gérante confirme un rendez-vous à confirmer', async () => {
    const { service, received, seed } = createHarness();
    const id = seed('PENDING');

    await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: id, status: 'CONFIRMED', reason: null, actor: GERANTE },
        NOW,
      ),
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      name: 'appointment.confirmed',
      tenantId: TENANT,
      appointmentId: id,
      clientId: CLIENT,
      staffId: CLAIRE_STAFF,
    });
  });

  it('l’est aussi quand la praticienne confirme le sien — le geste lui est laissé', async () => {
    const { service, received, seed } = createHarness();
    const id = seed('PENDING');

    await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: id, status: 'CONFIRMED', reason: null, actor: PRATICIENNE },
        NOW,
      ),
    );

    expect(received.map((event) => event.appointmentId)).toEqual([id]);
  });

  it('ne l’est pas pour « honoré » : ce n’est pas une confirmation', async () => {
    const { service, received, seed } = createHarness();
    const id = seed('CONFIRMED');

    await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: id, status: 'COMPLETED', reason: null, actor: GERANTE },
        PENDANT_LE_SOIN,
      ),
    );

    expect(received).toEqual([]);
  });

  it('ne l’est qu’une fois quand deux confirmations se croisent', async () => {
    // Deux onglets du comptoir, ou la gérante et la praticienne au même
    // instant : les deux lisent `PENDING`, une seule écriture passe, l'autre
    // sort en 409. Celle-là n'a rien confirmé et ne doit rien annoncer.
    const { service, received, seed } = createHarness();
    const id = seed('PENDING');

    const outcomes = await runWithTenant(TENANT, () =>
      Promise.allSettled([
        service.changeStatus(
          { appointmentId: id, status: 'CONFIRMED', reason: null, actor: GERANTE },
          NOW,
        ),
        service.changeStatus(
          { appointmentId: id, status: 'CONFIRMED', reason: null, actor: GERANTE },
          NOW,
        ),
      ]),
    );

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(received).toHaveLength(1);
  });
});

/**
 * `appointment.status_changed` — les deux issues d'un rendez-vous.
 *
 * Aucun message ne part pour elles, mais le planning temps réel en a besoin :
 * « honoré » posé sur un téléphone doit se voir sur l'écran du comptoir et dans
 * l'espace de la cliente.
 */
describe('appointment.status_changed — honoré et non présenté sont annoncés', () => {
  it.each([['COMPLETED'], ['NO_SHOW']] as const)(
    'est émis quand le rendez-vous passe %s, sans confirmation annoncée',
    async (status) => {
      const { service, received, seed, events } = createHarness();
      const changed: AppointmentStatusChangedEvent[] = [];
      events.onAppointmentStatusChanged((event) => changed.push(event));
      const id = seed('CONFIRMED');

      await runWithTenant(TENANT, () =>
        service.changeStatus(
          { appointmentId: id, status, reason: null, actor: GERANTE },
          PENDANT_LE_SOIN,
        ),
      );

      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({
        name: 'appointment.status_changed',
        tenantId: TENANT,
        appointmentId: id,
        clientId: CLIENT,
        staffId: CLAIRE_STAFF,
        status,
      });
      expect(received).toEqual([]);
    },
  );

  it('ne l’est pas pour une confirmation, qui a son propre événement', async () => {
    const { service, seed, events } = createHarness();
    const changed: AppointmentStatusChangedEvent[] = [];
    events.onAppointmentStatusChanged((event) => changed.push(event));
    const id = seed('PENDING');

    await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: id, status: 'CONFIRMED', reason: null, actor: GERANTE },
        NOW,
      ),
    );

    expect(changed).toEqual([]);
  });
});
