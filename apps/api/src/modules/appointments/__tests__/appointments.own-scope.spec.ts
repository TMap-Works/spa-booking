import { randomUUID } from 'node:crypto';

import { runWithTenant } from '../../../common/tenant';
import { OwnScopeOnlyError } from '../../identity/identity.errors';
import { AppointmentLifecycleService } from '../appointment-lifecycle.service';
import { AppointmentsService } from '../appointments.service';
import type { AppointmentActor } from '../appointments.types';
import { AppointmentEvents } from '../events/appointment-events';
import { TenantClockService } from '../../availability/tenant-clock.service';
import { SpyAvailabilityCache } from '../../availability/__tests__/staff-time-off.doubles';
import type { AvailabilityService } from '../../availability/availability.service';
import type { ServicesService } from '../../catalog/services.service';
import type { ServiceView } from '../../catalog/catalog.types';
import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { FakeAppointmentsRepository, FakeCacheLocks } from './appointments.doubles';

/**
 * **La portée du praticien** — troisième critère de #812.
 *
 * Ce que cette suite exerce n'est pas l'accès à la route : `PermissionsGuard` l'a
 * déjà tranché, et `identity/__tests__/route-permissions.spec.ts` le couvre rôle
 * par rôle. C'est ce qui se passe **après** la porte, quand le praticien qu'on a
 * laissé entrer vise le rendez-vous d'une collègue.
 *
 * Trois propriétés, et chacune corrige un des deux défauts possibles :
 *
 * 1. il agit sur **les siens** — sinon le ticket aurait supprimé un usage
 *    légitime plutôt qu'un droit de trop ;
 * 2. il reçoit **403 `OWN_SCOPE_ONLY`** sur ceux d'une collègue — pas 404 : la
 *    ressource est du même établissement, et il en connaît déjà l'existence ;
 * 3. le **404 du voisin l'emporte** sur le 403 de portée. C'est l'ordre des
 *    vérifications, et l'inverse aurait dit à un salon que le rendez-vous d'un
 *    autre existe (tenant-isolation §4).
 */

const TENANT = randomUUID();
const VOISIN = randomUUID();

const SERVICE_ID = randomUUID();

/** Claire, praticienne : un compte, une fiche praticien. */
const CLAIRE_USER = randomUUID();
const CLAIRE_STAFF = randomUUID();

/** Sa collègue, dont Claire ne doit rien pouvoir toucher. */
const COLLEGUE_STAFF = randomUUID();

/** La gérante : pas de fiche praticien, et tous les droits d'agenda. */
const GERANTE_USER = randomUUID();

const OCCUPIED_START = new Date('2026-09-01T10:00:00.000Z');
const OCCUPIED_END = new Date('2026-09-01T11:00:00.000Z');
const NOW = new Date('2026-08-31T08:00:00.000Z');

const PRATICIENNE: AppointmentActor = { userId: CLAIRE_USER, role: 'STAFF' };
const GERANTE: AppointmentActor = { userId: GERANTE_USER, role: 'MANAGER' };

function serviceView(): ServiceView {
  return {
    id: SERVICE_ID,
    slug: 'massage-60',
    name: 'Massage 60 min',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
  } as unknown as ServiceView;
}

interface Harness {
  readonly service: AppointmentsService;
  readonly repository: FakeAppointmentsRepository;
}

function createHarness(): Harness {
  const repository = new FakeAppointmentsRepository();
  const logger: StructuredLogger = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as StructuredLogger;

  const availability = {
    forService: async () => ({ slots: [] }),
  } as unknown as AvailabilityService;

  const catalog = {
    byId: async () => serviceView(),
  } as unknown as ServicesService;

  return {
    service: new AppointmentsService(
      repository.asRepository(),
      catalog,
      availability,
      new AppointmentEvents(logger),
      new AppointmentLifecycleService(),
      new SpyAvailabilityCache().asService(),
      new FakeCacheLocks().asService(),
      new TenantClockService(),
    ),
    repository,
  };
}

/**
 * Le décor commun : Claire a une fiche praticien dans le salon, et deux
 * rendez-vous existent — le sien et celui de sa collègue.
 */
function seed(repository: FakeAppointmentsRepository): {
  readonly mien: string;
  readonly deLaCollegue: string;
} {
  repository.seedStaffProfile({
    tenantId: TENANT,
    staffId: CLAIRE_STAFF,
    userId: CLAIRE_USER,
    displayName: 'Claire',
  });

  const mien = repository.seedAppointment({
    tenantId: TENANT,
    staffId: CLAIRE_STAFF,
    startsAt: OCCUPIED_START,
    endsAt: OCCUPIED_END,
    status: 'CONFIRMED',
    serviceId: SERVICE_ID,
  });

  const deLaCollegue = repository.seedAppointment({
    tenantId: TENANT,
    staffId: COLLEGUE_STAFF,
    startsAt: OCCUPIED_START,
    endsAt: OCCUPIED_END,
    status: 'CONFIRMED',
    serviceId: SERVICE_ID,
  });

  return { mien: mien.id, deLaCollegue: deLaCollegue.id };
}

describe('changement de statut — « honoré », « non présenté »', () => {
  it('laisse la praticienne solder son propre rendez-vous', async () => {
    const { service, repository } = createHarness();
    const { mien } = seed(repository);

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: mien, status: 'COMPLETED', reason: null, actor: PRATICIENNE },
        NOW,
      ),
    );

    // Comparaison insensible à la casse : le double rend la casse de la colonne,
    // la frontière HTTP celle du contrat — et ce n'est pas ce que ce cas juge.
    expect(String(view.status).toUpperCase()).toBe('COMPLETED');
  });

  it('lui refuse celui d’une collègue en 403 OWN_SCOPE_ONLY', async () => {
    const { service, repository } = createHarness();
    const { deLaCollegue } = seed(repository);

    const refus = await runWithTenant(TENANT, () =>
      service
        .changeStatus(
          { appointmentId: deLaCollegue, status: 'COMPLETED', reason: null, actor: PRATICIENNE },
          NOW,
        )
        .catch((error: unknown) => error),
    );

    expect(refus).toBeInstanceOf(OwnScopeOnlyError);
    const erreur = refus as OwnScopeOnlyError;
    expect({ code: erreur.code, status: erreur.status }).toEqual({
      code: 'OWN_SCOPE_ONLY',
      status: 403,
    });
    // `details` dit ce qui aurait permis le geste, et rien de la ressource : ni
    // son identifiant, ni le nom de qui la détient.
    expect(erreur.details).toEqual({ scope: 'appointment:write:all' });
    expect(JSON.stringify(erreur.details)).not.toContain(deLaCollegue);
  });

  it('laisse la gérante solder n’importe quel rendez-vous du salon', async () => {
    const { service, repository } = createHarness();
    const { deLaCollegue } = seed(repository);

    const view = await runWithTenant(TENANT, () =>
      service.changeStatus(
        { appointmentId: deLaCollegue, status: 'COMPLETED', reason: null, actor: GERANTE },
        NOW,
      ),
    );

    // Comparaison insensible à la casse : le double rend la casse de la colonne,
    // la frontière HTTP celle du contrat — et ce n'est pas ce que ce cas juge.
    expect(String(view.status).toUpperCase()).toBe('COMPLETED');
  });

  it('refuse un compte sans fiche praticien plutôt que de lui ouvrir tout le salon', async () => {
    const { service, repository } = createHarness();
    const { mien } = seed(repository);
    // Un rang `STAFF` qui n'a pas de fiche praticien ne possède **aucun**
    // rendez-vous. Le traiter comme s'il les possédait tous aurait été le défaut
    // fail-open de la portée.
    const sansFiche: AppointmentActor = { userId: randomUUID(), role: 'STAFF' };

    await expect(
      runWithTenant(TENANT, () =>
        service.changeStatus(
          { appointmentId: mien, status: 'COMPLETED', reason: null, actor: sansFiche },
          NOW,
        ),
      ),
    ).rejects.toBeInstanceOf(OwnScopeOnlyError);
  });
});

describe('annulation', () => {
  it('laisse la praticienne libérer son propre créneau', async () => {
    const { service, repository } = createHarness();
    const { mien } = seed(repository);

    const view = await runWithTenant(TENANT, () =>
      service.cancel(
        { appointmentId: mien, cancelledBy: 'STAFF', reason: null, actor: PRATICIENNE },
        NOW,
      ),
    );

    expect(String(view.status).toUpperCase()).toBe('CANCELLED');
  });

  it('lui refuse le créneau d’une collègue', async () => {
    const { service, repository } = createHarness();
    const { deLaCollegue } = seed(repository);

    await expect(
      runWithTenant(TENANT, () =>
        service.cancel(
          { appointmentId: deLaCollegue, cancelledBy: 'STAFF', reason: null, actor: PRATICIENNE },
          NOW,
        ),
      ),
    ).rejects.toBeInstanceOf(OwnScopeOnlyError);
  });

  it('n’impose aucune portée au tunnel public, qui n’a pas d’acteur', async () => {
    const { service, repository } = createHarness();
    const { deLaCollegue } = seed(repository);

    // Sans `actor`, la portée n'est pas la question : c'est la porte qui en
    // décide, et la cliente qui annule son propre rendez-vous n'a pas de fiche
    // praticien à comparer.
    const view = await runWithTenant(TENANT, () =>
      service.cancel({ appointmentId: deLaCollegue, cancelledBy: 'CLIENT', reason: null }, NOW),
    );

    expect(String(view.status).toUpperCase()).toBe('CANCELLED');
  });
});

describe('l’ordre des refus — le 404 du voisin avant le 403 de portée', () => {
  it('rend « introuvable » sur le rendez-vous d’un autre établissement', async () => {
    const { service, repository } = createHarness();
    seed(repository);
    const chezLeVoisin = repository.seedAppointment({
      tenantId: VOISIN,
      staffId: randomUUID(),
      startsAt: OCCUPIED_START,
      endsAt: OCCUPIED_END,
      status: 'CONFIRMED',
      serviceId: SERVICE_ID,
    });

    const refus = await runWithTenant(TENANT, () =>
      service
        .changeStatus(
          {
            appointmentId: chezLeVoisin.id,
            status: 'COMPLETED',
            reason: null,
            actor: PRATICIENNE,
          },
          NOW,
        )
        .catch((error: unknown) => error),
    );

    // Et surtout **pas** `OwnScopeOnlyError` : « hors de votre périmètre »
    // confirmerait que la ligne existe ailleurs.
    expect(refus).not.toBeInstanceOf(OwnScopeOnlyError);
    expect((refus as Error).message).toMatch(/introuvable/i);
  });
});
