import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import { AvailabilityRangeTooWideError } from '../availability.errors';
import { AvailabilityService } from '../availability.service';
import type { AvailabilityView } from '../availability.types';
import { StaffScheduleService } from '../staff-schedule.service';
import { StaffTimeOffService } from '../staff-time-off.service';
import { TenantClockService } from '../tenant-clock.service';
import { FakeAvailabilityRepository } from './availability.doubles';
import { FakeStaffTimeOffRepository, SpyAvailabilityCache } from './staff-time-off.doubles';

/**
 * Le calcul de créneaux, assemblé — sans HTTP et sans base (#34).
 *
 * Ce que cette suite exerce est ce que `availability.slots.spec.ts` ne peut pas
 * voir : **d'où viennent les entrées**. La résolution des candidats, la
 * composition « horaires − fermetures − congés − rendez-vous », les réglages de
 * l'établissement, et le regroupement dans les journées du salon.
 *
 * Le service est exercé **dans une portée de tenant**, celle que `JwtAuthGuard`
 * renseigne en vrai : les doubles refusent de lire sans elle, comme le fait
 * l'extension Prisma. L'horloge est le **vrai** `TenantClockService` — le simuler
 * reviendrait à prouver le calcul contre une conversion qui n'est pas celle qui
 * tournera.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const PARIS = 'Europe/Paris';

/** Lundi 24 août 2026 — jour ISO 1, en pleine heure d'été (`UTC+2`). */
const MONDAY = '2026-08-24';

/** Une heure bien avant l'ouverture : aucun créneau n'est écarté par le préavis. */
const BEFORE_OPENING = new Date('2026-08-24T00:00:00.000Z');

const SERVICE_ID = randomUUID();

/** Une prestation d'une demi-heure, sans tampon — le cas courant. */
function serviceView(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: SERVICE_ID,
    slug: 'massage-30',
    name: 'Massage 30 min',
    description: null,
    category: null,
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    occupiedMinutes: 30,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    ...overrides,
  };
}

/**
 * Le catalogue, réduit à la porte que le moteur emprunte.
 *
 * Un double et non le vrai `ServicesService` : celui-ci n'aurait apporté que son
 * `CatalogRepository`, c'est-à-dire une seconde base en mémoire à tenir à jour
 * pour une unique lecture. Ce qui compte ici est que la durée et les tampons
 * arrivent du catalogue, pas la façon dont il les lit — ses propres suites s'en
 * chargent.
 */
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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

/** Les heures de début d'une journée de la réponse, en `HH:MM` UTC. */
function startTimesOn(view: AvailabilityView, date: string): string[] {
  const day = view.days.find((candidate) => candidate.date === date);

  return (day?.slots ?? []).map((slot) => slot.startsAt.slice(11, 16));
}

describe('AvailabilityService', () => {
  let repository: FakeAvailabilityRepository;
  let timeOffRepository: FakeStaffTimeOffRepository;
  let availability: AvailabilityService;
  let staffId: string;

  /** Reconstruit le service autour d'un catalogue donné. */
  const wire = (view: ServiceView | null = serviceView()): AvailabilityService => {
    const clock = new TenantClockService();

    return new AvailabilityService(
      repository.asRepository(),
      new StaffScheduleService(
        repository.asRepository(),
        clock,
        new SpyAvailabilityCache().asService(),
      ),
      new StaffTimeOffService(timeOffRepository.asRepository(), new SpyAvailabilityCache().asService()),
      fakeCatalog(view),
      clock,
    );
  };

  beforeEach(() => {
    repository = new FakeAvailabilityRepository();
    timeOffRepository = new FakeStaffTimeOffRepository();

    repository.seedTenant({ id: TENANT_A, timezone: PARIS });
    repository.seedTenant({ id: TENANT_B, timezone: 'Indian/Antananarivo' });

    staffId = repository.seedStaff({ tenantId: TENANT_A }).id;
    timeOffRepository.registerStaff(TENANT_A, staffId);
    repository.seedServiceStaff({ tenantId: TENANT_A, serviceId: SERVICE_ID, staffId });
    // Lundi 09:00–12:00, heure murale du salon — soit 07:00Z–10:00Z en août.
    repository.seedSchedule({
      tenantId: TENANT_A,
      staffId,
      weekday: 1,
      startMinute: 9 * 60,
      endMinute: 12 * 60,
    });

    availability = wire();
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  const slotsFor = async (
    query: Partial<{ serviceId: string; staffId: string; from: string; to: string }> = {},
    now: Date = BEFORE_OPENING,
  ): Promise<AvailabilityView> =>
    inTenantA(async () =>
      availability.slotsFor(
        { serviceId: SERVICE_ID, from: MONDAY, to: MONDAY, ...query },
        now,
      ),
    );

  describe('résolution des praticiens candidats', () => {
    it('propose les créneaux du praticien affecté à la prestation', async () => {
      const view = await slotsFor();

      // 09:00–12:00 à Paris en août vaut 07:00Z–10:00Z ; dernier départ 09:30Z.
      expect(startTimesOn(view, MONDAY)).toEqual([
        '07:00',
        '07:15',
        '07:30',
        '07:45',
        '08:00',
        '08:15',
        '08:30',
        '08:45',
        '09:00',
        '09:15',
        '09:30',
      ]);
      expect(view.days[0]?.slots[0]?.staffId).toBe(staffId);
    });

    it('ne propose jamais un praticien qui ne pratique pas la prestation', async () => {
      const other = repository.seedStaff({ tenantId: TENANT_A }).id;
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId: other,
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 12 * 60,
      });

      const view = await slotsFor();

      expect(view.days[0]?.slots.every((slot) => slot.staffId === staffId)).toBe(true);
    });

    it('écarte un praticien désactivé, même s’il garde ses horaires', async () => {
      const retired = repository.seedStaff({ tenantId: TENANT_A, isActive: false }).id;
      repository.seedServiceStaff({ tenantId: TENANT_A, serviceId: SERVICE_ID, staffId: retired });
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId: retired,
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 12 * 60,
      });

      const view = await slotsFor();

      expect(view.days[0]?.slots.some((slot) => slot.staffId === retired)).toBe(false);
    });

    it('agrège les créneaux de tous les praticiens quand aucun n’est demandé', async () => {
      const second = repository.seedStaff({ tenantId: TENANT_A }).id;
      repository.seedServiceStaff({ tenantId: TENANT_A, serviceId: SERVICE_ID, staffId: second });
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId: second,
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      });

      const view = await slotsFor();
      const holders = new Set(view.days[0]?.slots.map((slot) => slot.staffId));

      expect(holders).toEqual(new Set([staffId, second]));
    });

    it('restreint au praticien demandé', async () => {
      const second = repository.seedStaff({ tenantId: TENANT_A }).id;
      repository.seedServiceStaff({ tenantId: TENANT_A, serviceId: SERVICE_ID, staffId: second });
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId: second,
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
      });

      const view = await slotsFor({ staffId: second });

      expect(view.days[0]?.slots.every((slot) => slot.staffId === second)).toBe(true);
    });

    it('rend un calendrier vide — jamais une erreur — pour un praticien qui ne pratique pas le soin', async () => {
      const stranger = repository.seedStaff({ tenantId: TENANT_A }).id;

      const view = await slotsFor({ staffId: stranger });

      // Inconnu, désactivé, d'ailleurs, ou simplement non affecté : les quatre
      // doivent être indiscernables, sans quoi la page publique devient une
      // sonde d'existence (tenant-isolation §4).
      expect(view.days).toEqual([{ date: MONDAY, slots: [] }]);
    });

    it('rend le même calendrier vide pour un praticien de l’établissement voisin', async () => {
      const neighbour = repository.seedStaff({ tenantId: TENANT_B }).id;
      repository.seedServiceStaff({
        tenantId: TENANT_B,
        serviceId: SERVICE_ID,
        staffId: neighbour,
      });

      const view = await slotsFor({ staffId: neighbour });

      expect(view.days).toEqual([{ date: MONDAY, slots: [] }]);
    });

    it('ne laisse voir aucun praticien du voisin quand aucun n’est demandé', async () => {
      const neighbour = repository.seedStaff({ tenantId: TENANT_B }).id;
      repository.seedServiceStaff({
        tenantId: TENANT_B,
        serviceId: SERVICE_ID,
        staffId: neighbour,
      });
      repository.seedSchedule({
        tenantId: TENANT_B,
        staffId: neighbour,
        weekday: 1,
        startMinute: 9 * 60,
        endMinute: 12 * 60,
      });

      const view = await slotsFor();

      expect(view.days[0]?.slots.some((slot) => slot.staffId === neighbour)).toBe(false);
    });
  });

  describe('composition des fenêtres de travail', () => {
    it('n’ouvre rien un jour de fermeture de l’établissement', async () => {
      repository.seedClosingDay({ tenantId: TENANT_A, weekday: 1 });

      expect(await slotsFor()).toEqual({
        serviceId: SERVICE_ID,
        timezone: PARIS,
        days: [{ date: MONDAY, slots: [] }],
      });
    });

    it('retire les congés et plages bloquées du praticien', async () => {
      await runWithTenant(TENANT_A, async () =>
        timeOffRepository.create({
          staffId,
          startsAt: new Date('2026-08-24T08:00:00.000Z'),
          endsAt: new Date('2026-08-24T09:00:00.000Z'),
          reason: 'déjeuner',
        }),
      );

      const slots = startTimesOn(await slotsFor(), MONDAY);

      expect(slots).not.toContain('08:00');
      expect(slots).not.toContain('08:30');
      expect(slots).toContain('09:00');
    });

    it('retire les rendez-vous en attente et confirmés', async () => {
      repository.seedAppointment({
        tenantId: TENANT_A,
        staffId,
        startsAt: new Date('2026-08-24T07:00:00.000Z'),
        endsAt: new Date('2026-08-24T08:00:00.000Z'),
        status: 'CONFIRMED',
      });

      const slots = startTimesOn(await slotsFor(), MONDAY);

      expect(slots[0]).toBe('08:00');
    });

    it('ne retire pas un rendez-vous annulé, honoré ou non honoré', async () => {
      for (const status of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
        repository.seedAppointment({
          tenantId: TENANT_A,
          staffId,
          startsAt: new Date('2026-08-24T07:00:00.000Z'),
          endsAt: new Date('2026-08-24T08:00:00.000Z'),
          status,
        });
      }

      // Un créneau annulé redevient réservable (booking-engine §6).
      expect(startTimesOn(await slotsFor(), MONDAY)[0]).toBe('07:00');
    });

    it('retire un rendez-vous commencé la veille et courant toujours', async () => {
      repository.seedAppointment({
        tenantId: TENANT_A,
        staffId,
        startsAt: new Date('2026-08-23T20:00:00.000Z'),
        endsAt: new Date('2026-08-24T08:00:00.000Z'),
      });

      expect(startTimesOn(await slotsFor(), MONDAY)[0]).toBe('08:00');
    });

    it('ignore le rendez-vous d’un autre praticien', async () => {
      const second = repository.seedStaff({ tenantId: TENANT_A }).id;
      repository.seedAppointment({
        tenantId: TENANT_A,
        staffId: second,
        startsAt: new Date('2026-08-24T07:00:00.000Z'),
        endsAt: new Date('2026-08-24T10:00:00.000Z'),
      });

      expect(startTimesOn(await slotsFor(), MONDAY)[0]).toBe('07:00');
    });
  });

  describe('réglages de l’établissement', () => {
    it('découpe au pas configuré plutôt qu’au défaut', async () => {
      repository.tenants.length = 0;
      repository.seedTenant({ id: TENANT_A, timezone: PARIS, slotIntervalMinutes: 60 });

      expect(startTimesOn(await slotsFor(), MONDAY)).toEqual(['07:00', '08:00', '09:00']);
    });

    it('écarte les créneaux qui violent le délai minimum de réservation', async () => {
      repository.tenants.length = 0;
      repository.seedTenant({ id: TENANT_A, timezone: PARIS, minBookingNoticeMinutes: 120 });

      // Il est 06:30Z ; avec deux heures de préavis, rien avant 08:30Z.
      const slots = startTimesOn(
        await slotsFor({}, new Date('2026-08-24T06:30:00.000Z')),
        MONDAY,
      );

      expect(slots).toEqual(['08:30', '08:45', '09:00', '09:15', '09:30']);
    });

    it('écarte les créneaux passés même sans préavis', async () => {
      repository.tenants.length = 0;
      repository.seedTenant({ id: TENANT_A, timezone: PARIS, minBookingNoticeMinutes: 0 });

      const slots = startTimesOn(
        await slotsFor({}, new Date('2026-08-24T08:20:00.000Z')),
        MONDAY,
      );

      expect(slots).toEqual(['08:30', '08:45', '09:00', '09:15', '09:30']);
    });

    it('occupe l’agenda tampons compris, sans les facturer à la cliente', async () => {
      availability = wire(
        serviceView({
          durationMinutes: 30,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 5,
          occupiedMinutes: 45,
        }),
      );

      const day = (await slotsFor()).days[0];
      const first = day?.slots[0];

      // La cliente est reçue dix minutes après l'ouverture, et son créneau ne
      // dure que le soin — les quarante-cinq minutes occupées ne se voient pas.
      expect(first?.startsAt).toBe('2026-08-24T07:10:00.000Z');
      expect(first?.endsAt).toBe('2026-08-24T07:40:00.000Z');
    });
  });

  describe('regroupement par journée du salon', () => {
    it('rend toutes les journées demandées, y compris celles sans créneau', async () => {
      const view = await slotsFor({ from: '2026-08-24', to: '2026-08-26' });

      expect(view.days.map((day) => day.date)).toEqual(['2026-08-24', '2026-08-25', '2026-08-26']);
      expect(view.days[1]?.slots).toEqual([]);
      expect(view.days[2]?.slots).toEqual([]);
    });

    it('range un créneau dans la journée du salon, pas dans celle du serveur', async () => {
      // Antananarivo est à UTC+3 sans heure d'été : une plage 00:30–02:00 locale
      // du mardi tombe le lundi en UTC, et doit rester rangée au mardi.
      repository.tenants.length = 0;
      repository.seedTenant({ id: TENANT_A, timezone: 'Indian/Antananarivo' });
      repository.schedules.length = 0;
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId,
        weekday: 2,
        startMinute: 30,
        endMinute: 2 * 60,
      });

      const view = await slotsFor({ from: '2026-08-24', to: '2026-08-25' });

      expect(view.timezone).toBe('Indian/Antananarivo');
      expect(view.days[0]?.slots).toEqual([]);
      // 00:30 locale le mardi = 21:30Z le lundi — rangé au mardi du salon.
      expect(view.days[1]?.slots[0]?.startsAt).toBe('2026-08-24T21:30:00.000Z');
    });

    it('rend le fuseau qui a servi au découpage', async () => {
      expect((await slotsFor()).timezone).toBe(PARIS);
    });
  });

  describe('refus', () => {
    it('refuse une plage inversée', async () => {
      const error = await rejectionOf(slotsFor({ from: '2026-08-26', to: '2026-08-24' }));

      expect(error).toBeInstanceOf(AvailabilityRangeTooWideError);
    });

    it('refuse une plage de plus de trente et un jours', async () => {
      const error = await rejectionOf(slotsFor({ from: '2026-08-01', to: '2026-09-02' }));

      expect(error).toBeInstanceOf(AvailabilityRangeTooWideError);
    });

    it('accepte exactement trente et un jours', async () => {
      const view = await slotsFor({ from: '2026-08-01', to: '2026-08-31' });

      expect(view.days).toHaveLength(31);
    });

    it('répond 404 sur une prestation retirée du catalogue', async () => {
      availability = wire(serviceView({ isActive: false }));

      expect(await rejectionOf(slotsFor())).toBeInstanceOf(NotFoundError);
    });

    it('répond 404 sur une prestation inconnue ou d’un autre établissement', async () => {
      expect(await rejectionOf(slotsFor({ serviceId: randomUUID() }))).toBeInstanceOf(NotFoundError);
    });

    it('répond 404 quand l’établissement n’existe plus', async () => {
      repository.tenants.length = 0;

      expect(await rejectionOf(slotsFor())).toBeInstanceOf(NotFoundError);
    });
  });

  describe('changement d’heure', () => {
    it('garde l’heure murale d’ouverture de part et d’autre du passage à l’heure d’hiver', async () => {
      // Paris recule d'une heure le 25 octobre 2026. Une plage 09:00–12:00 le
      // lundi vaut 07:00Z en été et 08:00Z en hiver : c'est l'offset recalculé
      // pour chaque date, jamais un décalage mémorisé, qui le garantit.
      const summer = await slotsFor({ from: '2026-10-19', to: '2026-10-19' });
      const winter = await slotsFor({ from: '2026-10-26', to: '2026-10-26' });

      expect(startTimesOn(summer, '2026-10-19')[0]).toBe('07:00');
      expect(startTimesOn(winter, '2026-10-26')[0]).toBe('08:00');
    });
  });
});
