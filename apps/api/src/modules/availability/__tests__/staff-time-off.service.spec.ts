import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { InvalidTimeOffRangeError, TIME_OFF_RULES } from '../availability.errors';
import { StaffTimeOffService } from '../staff-time-off.service';
import { FakeStaffTimeOffRepository, SpyAvailabilityCache } from './staff-time-off.doubles';

/**
 * Règles des plages bloquées et congés — sans HTTP, sans base (#33).
 *
 * Le service est exercé **dans une portée de tenant**, celle que `JwtAuthGuard`
 * renseigne en vrai : c'est ce qui rend les assertions d'isolation
 * représentatives plutôt que décoratives.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

const AOUT = {
  from: new Date('2026-08-01T00:00:00Z'),
  to: new Date('2026-09-01T00:00:00Z'),
};

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

describe('StaffTimeOffService', () => {
  let repository: FakeStaffTimeOffRepository;
  let cache: SpyAvailabilityCache;
  let timeOff: StaffTimeOffService;
  let staffA: string;
  let staffB: string;

  beforeEach(() => {
    repository = new FakeStaffTimeOffRepository();
    cache = new SpyAvailabilityCache();
    timeOff = new StaffTimeOffService(repository.asRepository(), cache.asService());
    staffA = repository.registerStaff(TENANT_A);
    staffB = repository.registerStaff(TENANT_B);
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  const poseLunch = async (): Promise<{ id: string }> =>
    inTenantA(async () =>
      timeOff.create({
        staffId: staffA,
        startsAt: new Date('2026-08-03T12:00:00Z'),
        endsAt: new Date('2026-08-03T13:00:00Z'),
        reason: 'Déjeuner',
      }),
    );

  describe('création', () => {
    it('pose une plage bloquée ponctuelle avec son motif', async () => {
      const created = await poseLunch();

      expect(created).toEqual({
        id: expect.any(String) as unknown as string,
        staffId: staffA,
        startsAt: '2026-08-03T12:00:00.000Z',
        endsAt: '2026-08-03T13:00:00.000Z',
        reason: 'Déjeuner',
      });
    });

    it('pose un congé sur plusieurs jours — la même forme, une autre durée', async () => {
      const created = await inTenantA(async () =>
        timeOff.create({
          staffId: staffA,
          startsAt: new Date('2026-08-03T00:00:00Z'),
          endsAt: new Date('2026-08-24T00:00:00Z'),
        }),
      );

      expect(created.startsAt).toBe('2026-08-03T00:00:00.000Z');
      expect(created.endsAt).toBe('2026-08-24T00:00:00.000Z');
    });

    it('accepte une absence sans motif — une absence n’a pas à se justifier', async () => {
      const created = await inTenantA(async () =>
        timeOff.create({
          staffId: staffA,
          startsAt: new Date('2026-08-03T12:00:00Z'),
          endsAt: new Date('2026-08-03T13:00:00Z'),
        }),
      );

      expect(created.reason).toBeNull();
    });

    it('invalide le cache de disponibilité', async () => {
      await poseLunch();

      expect(cache.calls).toBe(1);
    });

    it('refuse un intervalle vide, sans rien écrire ni invalider', async () => {
      const error = await inTenantA(async () =>
        rejectionOf(
          timeOff.create({
            staffId: staffA,
            startsAt: new Date('2026-08-03T12:00:00Z'),
            endsAt: new Date('2026-08-03T12:00:00Z'),
          }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidTimeOffRangeError);
      expect((error as InvalidTimeOffRangeError).details).toMatchObject({
        rule: TIME_OFF_RULES.ENDS_BEFORE_STARTS,
      });
      expect(repository.snapshot()).toEqual([]);
      expect(cache.calls).toBe(0);
    });

    it('refuse une absence de plus d’un an — la borne de faute de frappe', async () => {
      const error = await inTenantA(async () =>
        rejectionOf(
          timeOff.create({
            staffId: staffA,
            startsAt: new Date('2026-08-03T00:00:00Z'),
            // « 2226 » au lieu de « 2026 » : l'agenda serait blanchi deux
            // siècles sans qu'aucune erreur ne le signale.
            endsAt: new Date('2226-08-03T00:00:00Z'),
          }),
        ),
      );

      expect((error as InvalidTimeOffRangeError).details).toMatchObject({
        rule: TIME_OFF_RULES.RANGE_TOO_WIDE,
      });
      expect(repository.snapshot()).toEqual([]);
    });

    it('rend 404 pour un praticien d’un autre établissement — jamais 403', async () => {
      // La clé étrangère composite `(tenant_id, staff_id)` refuse la ligne ; un
      // 403 aurait confirmé l'existence du praticien voisin.
      const error = await inTenantA(async () =>
        rejectionOf(
          timeOff.create({
            staffId: staffB,
            startsAt: new Date('2026-08-03T12:00:00Z'),
            endsAt: new Date('2026-08-03T13:00:00Z'),
          }),
        ),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.snapshot()).toEqual([]);
      expect(cache.calls).toBe(0);
    });
  });

  describe('lecture', () => {
    it('rend 404 sur l’absence d’un autre établissement', async () => {
      const created = await poseLunch();

      const error = await inTenantB(async () => rejectionOf(timeOff.byId(created.id)));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('ne fait apparaître dans le planning d’un tenant aucune absence de l’autre', async () => {
      await poseLunch();

      const planning = await inTenantB(async () => timeOff.list(AOUT));

      expect(planning).toEqual([]);
    });

    it('retient une absence qui recoupe la fenêtre sans y être incluse', async () => {
      // Un congé commencé en juillet et courant jusqu'en septembre doit
      // apparaître au planning d'août : le retenir sur son seul début le ferait
      // disparaître de tous les mois qu'il traverse sauf le premier.
      await inTenantA(async () =>
        timeOff.create({
          staffId: staffA,
          startsAt: new Date('2026-07-20T00:00:00Z'),
          endsAt: new Date('2026-09-10T00:00:00Z'),
        }),
      );

      const planning = await inTenantA(async () => timeOff.list(AOUT));

      expect(planning).toHaveLength(1);
    });

    it('exclut une absence qui finit exactement au début de la fenêtre', async () => {
      await inTenantA(async () =>
        timeOff.create({
          staffId: staffA,
          startsAt: new Date('2026-07-20T00:00:00Z'),
          endsAt: AOUT.from,
        }),
      );

      expect(await inTenantA(async () => timeOff.list(AOUT))).toEqual([]);
    });

    it('refuse une fenêtre de planning déraisonnable', async () => {
      const error = await inTenantA(async () =>
        rejectionOf(
          timeOff.list({ from: new Date('2026-01-01T00:00:00Z'), to: new Date('2126-01-01T00:00:00Z') }),
        ),
      );

      expect(error).toBeInstanceOf(InvalidTimeOffRangeError);
    });

    it('restreint le planning à un praticien quand on le demande', async () => {
      const other = repository.registerStaff(TENANT_A);
      await poseLunch();
      await inTenantA(async () =>
        timeOff.create({
          staffId: other,
          startsAt: new Date('2026-08-04T12:00:00Z'),
          endsAt: new Date('2026-08-04T13:00:00Z'),
        }),
      );

      const planning = await inTenantA(async () => timeOff.list(AOUT, other));

      expect(planning.map((one) => one.staffId)).toEqual([other]);
    });
  });

  describe('modification', () => {
    it('juge les bornes fusionnées avec l’état en base', async () => {
      // Seule la fin est déplacée, et elle passe avant le début déjà stocké :
      // un décorateur de champ n'aurait rien vu.
      const created = await poseLunch();

      const error = await inTenantA(async () =>
        rejectionOf(timeOff.update(created.id, { endsAt: new Date('2026-08-03T11:00:00Z') })),
      );

      expect((error as InvalidTimeOffRangeError).details).toMatchObject({
        rule: TIME_OFF_RULES.ENDS_BEFORE_STARTS,
      });
    });

    it('déplace l’absence et invalide le cache', async () => {
      const created = await poseLunch();
      cache.calls = 0;

      const updated = await inTenantA(async () =>
        timeOff.update(created.id, {
          startsAt: new Date('2026-08-03T14:00:00Z'),
          endsAt: new Date('2026-08-03T15:00:00Z'),
        }),
      );

      expect(updated.startsAt).toBe('2026-08-03T14:00:00.000Z');
      expect(cache.calls).toBe(1);
    });

    it('efface le motif sur un `null` explicite', async () => {
      const created = await poseLunch();

      const updated = await inTenantA(async () => timeOff.update(created.id, { reason: null }));

      expect(updated.reason).toBeNull();
    });

    it('rend 404 sur l’absence d’un autre établissement, sans rien invalider', async () => {
      const created = await poseLunch();
      cache.calls = 0;

      const error = await inTenantB(async () =>
        rejectionOf(timeOff.update(created.id, { reason: 'Curiosité' })),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(cache.calls).toBe(0);
      expect(repository.snapshot()[0]?.reason).toBe('Déjeuner');
    });
  });

  describe('retrait', () => {
    it('retire l’absence et invalide le cache', async () => {
      const created = await poseLunch();
      cache.calls = 0;

      await inTenantA(async () => timeOff.remove(created.id));

      expect(repository.snapshot()).toEqual([]);
      expect(cache.calls).toBe(1);
    });

    it('rend 404 sur l’absence d’un autre établissement, qui reste intacte', async () => {
      const created = await poseLunch();
      cache.calls = 0;

      const error = await inTenantB(async () => rejectionOf(timeOff.remove(created.id)));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.snapshot()).toHaveLength(1);
      expect(cache.calls).toBe(0);
    });

    it('rend 404 sur un identifiant inconnu', async () => {
      const error = await inTenantA(async () => rejectionOf(timeOff.remove(randomUUID())));

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe('intervalles consommés par le calcul de créneaux', () => {
    it('ne transporte aucun motif — visible du back-office uniquement', async () => {
      await poseLunch();

      const busy = await inTenantA(async () => timeOff.busyRanges([staffA], AOUT));

      expect(busy).toEqual([
        {
          staffId: staffA,
          startsAt: new Date('2026-08-03T12:00:00Z'),
          endsAt: new Date('2026-08-03T13:00:00Z'),
        },
      ]);
      expect(busy.every((one) => !('reason' in one))).toBe(true);
    });

    it('ne rend aucun intervalle d’un autre établissement', async () => {
      await poseLunch();

      const busy = await inTenantB(async () => timeOff.busyRanges([staffA, staffB], AOUT));

      expect(busy).toEqual([]);
    });

    it('rend une liste vide sans praticien candidat', async () => {
      await poseLunch();

      expect(await inTenantA(async () => timeOff.busyRanges([], AOUT))).toEqual([]);
    });
  });
});
