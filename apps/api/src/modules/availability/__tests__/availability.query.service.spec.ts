import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  type AvailabilityCacheEntry,
  type AvailabilityCacheStore,
  AvailabilityCacheService,
} from '../availability-cache';
import { AvailabilityRangeTooWideError } from '../availability.errors';
import { AvailabilityQueryService } from '../availability.query.service';
import type { AvailabilityService } from '../availability.service';
import type { AvailabilityView } from '../availability.types';

/**
 * Le chemin de lecture caché — #35, critères 2, 4 et 5.
 *
 * Ce qui se prouve ici tient en trois phrases :
 *
 * - **un défaut coûte un calcul, un succès n'en coûte aucun.** C'est la forme
 *   testable du quatrième critère (« sous 300 ms sur un mois de données ») :
 *   mesurer un temps de réponse en test le rendrait dépendant de la machine, là
 *   où « le moteur n'a pas été appelé » est vrai partout et pour toujours ;
 * - **le refus précède le cache.** Une plage inversée ou trop large sort en 422
 *   sans qu'aucune clé ne soit fabriquée — sans quoi un `from` en 1970 ferait
 *   construire soixante-treize mille clés pour une requête qui sera refusée ;
 * - **le service de rendez-vous ne passe pas par ici.** Cette propriété-là ne se
 *   teste pas dans ce fichier, elle se lit dans `availability.module.ts` : ce
 *   service n'est pas exporté, donc `appointments` ne peut pas l'injecter. Le
 *   témoin est `availability.module.spec.ts`.
 */

const TENANT = randomUUID();
const SERVICE_ID = randomUUID();
const STAFF_ID = randomUUID();

const RANGE = { serviceId: SERVICE_ID, from: '2026-09-01', to: '2026-09-02' } as const;

class MemoryStore implements AvailabilityCacheStore {
  public readonly entries = new Map<string, string>();
  public readCalls = 0;

  public evictByPrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }

    return Promise.resolve();
  }

  public readMany(keys: readonly string[]): Promise<readonly (string | null)[]> {
    this.readCalls += 1;

    return Promise.resolve(keys.map((key) => this.entries.get(key) ?? null));
  }

  public writeMany(entries: readonly AvailabilityCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.key, entry.value);
    }

    return Promise.resolve();
  }
}

/** Le moteur, réduit à ce que ce service en attend : un calcul, et son compte. */
function fakeEngine(view: AvailabilityView): {
  engine: AvailabilityService;
  calls: { from: string; to: string }[];
} {
  const calls: { from: string; to: string }[] = [];

  const engine = {
    slotsFor: (query: { from: string; to: string }): Promise<AvailabilityView> => {
      calls.push({ from: query.from, to: query.to });

      return Promise.resolve(view);
    },
  } as unknown as AvailabilityService;

  return { engine, calls };
}

function viewOf(): AvailabilityView {
  return {
    serviceId: SERVICE_ID,
    timezone: 'Europe/Paris',
    days: [
      {
        date: '2026-09-01',
        slots: [
          {
            startsAt: '2026-09-01T08:00:00.000Z',
            endsAt: '2026-09-01T09:00:00.000Z',
            staffId: STAFF_ID,
          },
        ],
      },
      { date: '2026-09-02', slots: [] },
    ],
  };
}

describe('AvailabilityQueryService', () => {
  let store: MemoryStore;
  let tenants: TenantContextService;
  let cache: AvailabilityCacheService;

  beforeEach(() => {
    store = new MemoryStore();
    tenants = new TenantContextService();
    cache = new AvailabilityCacheService(store, tenants);
  });

  const inTenant = async <T>(fn: () => Promise<T>): Promise<T> => tenants.runWithTenant(TENANT, fn);

  it('calcule au premier appel et sert le cache au second', async () => {
    const { engine, calls } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    const first = await inTenant(async () => service.slotsFor({ ...RANGE }));
    const second = await inTenant(async () => service.slotsFor({ ...RANGE }));

    expect(first).toEqual(viewOf());
    expect(second).toEqual(viewOf());
    // Un seul calcul pour deux réponses : c'est tout ce que ce cache promet.
    expect(calls).toHaveLength(1);
  });

  it('recalcule après une invalidation', async () => {
    const { engine, calls } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    await inTenant(async () => service.slotsFor({ ...RANGE }));
    await inTenant(async () => cache.invalidateCurrentTenant());
    await inTenant(async () => service.slotsFor({ ...RANGE }));

    // C'est le lien entre le troisième critère et le cinquième : une écriture
    // d'agenda fait repartir le calcul, elle n'attend pas le TTL.
    expect(calls).toHaveLength(2);
  });

  it('sépare les praticiens : un cache ciblé ne sert pas la requête générale', async () => {
    const { engine, calls } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    await inTenant(async () => service.slotsFor({ ...RANGE, staffId: STAFF_ID }));
    await inTenant(async () => service.slotsFor({ ...RANGE }));

    expect(calls).toHaveLength(2);
  });

  it('refuse une plage trop large avant de toucher au cache', async () => {
    const { engine, calls } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    await expect(
      inTenant(async () => service.slotsFor({ ...RANGE, to: '2026-12-31' })),
    ).rejects.toBeInstanceOf(AvailabilityRangeTooWideError);

    expect(store.readCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuse une plage inversée, pour la même raison et au même endroit', async () => {
    const { engine } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    await expect(
      inTenant(async () => service.slotsFor({ ...RANGE, from: '2026-09-02', to: '2026-09-01' })),
    ).rejects.toBeInstanceOf(AvailabilityRangeTooWideError);

    expect(store.readCalls).toBe(0);
  });

  it('réutilise les journées déjà connues quand la plage recouvre les mêmes dates', async () => {
    const { engine, calls } = fakeEngine(viewOf());
    const service = new AvailabilityQueryService(engine, cache);

    await inTenant(async () => service.slotsFor({ ...RANGE }));
    // Une plage strictement incluse : toutes ses journées sont en cache.
    const narrowed = await inTenant(async () =>
      service.slotsFor({ ...RANGE, to: '2026-09-01' }),
    );

    expect(calls).toHaveLength(1);
    expect(narrowed.days).toHaveLength(1);
    expect(narrowed.timezone).toBe('Europe/Paris');
  });

  it('ne met pas en cache le refus du moteur', async () => {
    // Un 404 caché survivrait à la réactivation de la prestation, et le salon
    // verrait sa page publique rester vide sans savoir pourquoi.
    const failing = {
      slotsFor: (): Promise<AvailabilityView> => Promise.reject(new Error('prestation retirée')),
    } as unknown as AvailabilityService;
    const service = new AvailabilityQueryService(failing, cache);

    await expect(inTenant(async () => service.slotsFor({ ...RANGE }))).rejects.toThrow();

    expect(store.entries.size).toBe(0);
  });
});
