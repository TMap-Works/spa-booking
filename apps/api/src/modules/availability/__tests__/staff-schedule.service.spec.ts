import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { OverlappingScheduleRangesError } from '../availability.errors';
import { StaffScheduleService } from '../staff-schedule.service';
import { TenantClockService } from '../tenant-clock.service';
import { FakeAvailabilityRepository } from './availability.doubles';

/**
 * Règles métier des horaires récurrents — sans HTTP, sans base.
 *
 * Le service est exercé **dans une portée de tenant**, celle que `JwtAuthGuard`
 * renseigne en vrai : c'est ce qui rend les cas de traversée sincères. Un test
 * qui appellerait le service hors portée verrait le double refuser, ce qui est
 * le comportement de l'extension Prisma et non un artefact.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

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

describe('StaffScheduleService', () => {
  let repository: FakeAvailabilityRepository;
  let schedules: StaffScheduleService;
  let staffId: string;

  beforeEach(() => {
    repository = new FakeAvailabilityRepository();
    repository.seedTenant({ id: TENANT_A, timezone: 'Europe/Paris' });
    repository.seedTenant({ id: TENANT_B, timezone: 'Indian/Antananarivo' });
    staffId = repository.seedStaff({ tenantId: TENANT_A }).id;
    schedules = new StaffScheduleService(repository.asRepository(), new TenantClockService());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  describe('lecture', () => {
    it('rend une semaine vide et le fuseau de l’établissement', async () => {
      const schedule = await inTenantA(async () => schedules.forStaff(staffId));

      expect(schedule).toEqual({ staffId, timezone: 'Europe/Paris', entries: [] });
    });

    it('rend les plages triées par jour puis par heure', async () => {
      repository.seedSchedule({ tenantId: TENANT_A, staffId, weekday: 3, startMinute: 540, endMinute: 720 });
      repository.seedSchedule({ tenantId: TENANT_A, staffId, weekday: 1, startMinute: 840, endMinute: 1080 });
      repository.seedSchedule({ tenantId: TENANT_A, staffId, weekday: 1, startMinute: 540, endMinute: 720 });

      const schedule = await inTenantA(async () => schedules.forStaff(staffId));

      expect(schedule.entries).toEqual([
        { weekday: 1, startsAt: '09:00', endsAt: '12:00' },
        { weekday: 1, startsAt: '14:00', endsAt: '18:00' },
        { weekday: 3, startsAt: '09:00', endsAt: '12:00' },
      ]);
    });

    it('répond 404 pour un praticien inconnu', async () => {
      const error = await inTenantA(async () => rejectionOf(schedules.forStaff(randomUUID())));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('répond 404 pour le praticien d’un autre établissement', async () => {
      // Le 404 couvre indistinctement « n'existe nulle part » et « existe
      // ailleurs » : la différence est précisément ce qu'on ne dit pas.
      const error = await inTenantB(async () => rejectionOf(schedules.forStaff(staffId)));

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe('remplacement', () => {
    it('écrit une journée à coupure méridienne', async () => {
      const schedule = await inTenantA(async () =>
        schedules.replace(staffId, [
          { weekday: 2, startsAt: '09:00', endsAt: '12:00' },
          { weekday: 2, startsAt: '14:00', endsAt: '18:00' },
        ]),
      );

      expect(schedule.entries).toHaveLength(2);
      expect(repository.schedules).toHaveLength(2);
    });

    it('accepte minuit comme borne de fin', async () => {
      const schedule = await inTenantA(async () =>
        schedules.replace(staffId, [{ weekday: 5, startsAt: '18:00', endsAt: '24:00' }]),
      );

      expect(schedule.entries[0]).toEqual({ weekday: 5, startsAt: '18:00', endsAt: '24:00' });
      expect(repository.schedules[0]?.endMinute).toBe(1440);
    });

    it('remplace la semaine entière, et vide sur un tableau vide', async () => {
      await inTenantA(async () =>
        schedules.replace(staffId, [{ weekday: 2, startsAt: '09:00', endsAt: '12:00' }]),
      );

      const emptied = await inTenantA(async () => schedules.replace(staffId, []));

      // Un praticien cesse d'être proposable sans être désactivé.
      expect(emptied.entries).toEqual([]);
      expect(repository.schedules).toEqual([]);
    });

    it('refuse en 422 deux plages du même jour qui se recouvrent', async () => {
      const error = await inTenantA(async () =>
        rejectionOf(
          schedules.replace(staffId, [
            { weekday: 2, startsAt: '09:00', endsAt: '13:00' },
            { weekday: 2, startsAt: '12:00', endsAt: '18:00' },
          ]),
        ),
      );

      expect(error).toBeInstanceOf(OverlappingScheduleRangesError);
      // Le message nomme les deux plages fautives, pas la semaine entière.
      expect((error as OverlappingScheduleRangesError).details).toEqual({
        weekday: 2,
        ranges: ['09:00–13:00', '12:00–18:00'],
      });
      // Rien n'a été écrit : le contrôle précède l'écriture.
      expect(repository.schedules).toEqual([]);
    });

    it('accepte deux plages adjacentes — la borne haute est exclue', async () => {
      const schedule = await inTenantA(async () =>
        schedules.replace(staffId, [
          { weekday: 2, startsAt: '09:00', endsAt: '12:00' },
          { weekday: 2, startsAt: '12:00', endsAt: '18:00' },
        ]),
      );

      expect(schedule.entries).toHaveLength(2);
    });

    it('n’écrit rien pour le praticien d’un autre établissement', async () => {
      const error = await inTenantB(async () =>
        rejectionOf(schedules.replace(staffId, [{ weekday: 2, startsAt: '09:00', endsAt: '12:00' }])),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.schedules).toEqual([]);
    });

    it('ne touche pas aux plages d’un autre praticien', async () => {
      const other = repository.seedStaff({ tenantId: TENANT_A });
      repository.seedSchedule({
        tenantId: TENANT_A,
        staffId: other.id,
        weekday: 4,
        startMinute: 600,
        endMinute: 660,
      });

      await inTenantA(async () => schedules.replace(staffId, []));

      expect(repository.schedules).toHaveLength(1);
      expect(repository.schedules[0]?.staffId).toBe(other.id);
    });
  });

  describe('fenêtres de travail', () => {
    it('convertit à la volée et retire les jours de fermeture', async () => {
      // Lundi et dimanche travaillés, mais le salon ferme le dimanche.
      repository.seedSchedule({ tenantId: TENANT_A, staffId, weekday: 1, startMinute: 540, endMinute: 720 });
      repository.seedSchedule({ tenantId: TENANT_A, staffId, weekday: 7, startMinute: 540, endMinute: 720 });
      repository.seedClosingDay({ tenantId: TENANT_A, weekday: 7 });

      const windows = await inTenantA(async () =>
        schedules.windowsFor(staffId, '2026-08-24', '2026-08-30'),
      );

      expect(windows).toHaveLength(1);
      expect(windows[0]?.startsAt.toISOString()).toBe('2026-08-24T07:00:00.000Z');
    });

    it('n’emprunte pas les jours de fermeture du voisin', async () => {
      const neighbour = repository.seedStaff({ tenantId: TENANT_B });
      repository.seedSchedule({
        tenantId: TENANT_B,
        staffId: neighbour.id,
        weekday: 1,
        startMinute: 540,
        endMinute: 720,
      });
      // A ferme le lundi ; B, non.
      repository.seedClosingDay({ tenantId: TENANT_A, weekday: 1 });

      const windows = await inTenantB(async () =>
        schedules.windowsFor(neighbour.id, '2026-08-24', '2026-08-24'),
      );

      // Antananarivo est à UTC+3 toute l'année : 09:00 local vaut 06:00Z.
      expect(windows).toHaveLength(1);
      expect(windows[0]?.startsAt.toISOString()).toBe('2026-08-24T06:00:00.000Z');
    });

    it('répond 404 pour le praticien d’un autre établissement', async () => {
      const error = await inTenantB(async () =>
        rejectionOf(schedules.windowsFor(staffId, '2026-08-24', '2026-08-24')),
      );

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe('établissement disparu', () => {
    it('répond 404 plutôt que de deviner un fuseau', async () => {
      // Un jeton signé sur une portée qui n'existe plus. Retomber sur un fuseau
      // par défaut décalerait tout un agenda sans que rien ne le signale.
      const orphan = randomUUID();
      const orphanStaff = repository.seedStaff({ tenantId: orphan });

      const error = await runWithTenant(orphan, async () =>
        rejectionOf(schedules.forStaff(orphanStaff.id)),
      );

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });
});
