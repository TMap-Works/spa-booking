import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  ANY_STAFF_KEY_SEGMENT,
  AVAILABILITY_CACHE_NAMESPACE,
  AVAILABILITY_CACHE_TTL_SECONDS,
  type AvailabilityCacheEntry,
  type AvailabilityCacheStore,
  AvailabilityCacheService,
  UnwiredAvailabilityCacheStore,
  availabilityDayKey,
  tenantAvailabilityKeyPrefix,
} from '../availability-cache';
import type { AvailabilityView } from '../availability.types';

/**
 * Clé, durée de vie et invalidation du cache de disponibilité (#33 puis #35).
 *
 * Trois propriétés se jouent ici, et aucune ne se voit dans une réponse HTTP :
 *
 * 1. **Le préfixe commence par l'établissement.** Une clé de cache sans tenant en
 *    tête est une collision entre établissements (tenant-isolation §5) — le genre
 *    de défaut qui ne se manifeste qu'en production, par intermittence.
 * 2. **Une réponse relue est celle qui avait été écrite.** Un cache qui rend
 *    autre chose que ce qu'il a reçu est pire qu'un cache absent.
 * 3. **Ce qu'on n'en comprend pas se recalcule.** Une entrée tronquée, d'une
 *    version antérieure, ou incomplète ne doit jamais atteindre le client.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const SERVICE_ID = randomUUID();
const STAFF_ID = randomUUID();

/** Un entrepôt en mémoire — l'espace de clés d'un Redis, sans Redis. */
class MemoryStore implements AvailabilityCacheStore {
  public readonly entries = new Map<string, string>();
  public readonly evictedPrefixes: string[] = [];
  public lastTtlSeconds: number | null = null;

  public evictByPrefix(prefix: string): Promise<void> {
    this.evictedPrefixes.push(prefix);

    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }

    return Promise.resolve();
  }

  public readMany(keys: readonly string[]): Promise<readonly (string | null)[]> {
    return Promise.resolve(keys.map((key) => this.entries.get(key) ?? null));
  }

  public writeMany(
    entries: readonly AvailabilityCacheEntry[],
    ttlSeconds: number,
  ): Promise<void> {
    this.lastTtlSeconds = ttlSeconds;

    for (const entry of entries) {
      this.entries.set(entry.key, entry.value);
    }

    return Promise.resolve();
  }
}

function viewOf(days: readonly { date: string; slots: readonly string[] }[]): AvailabilityView {
  return {
    serviceId: SERVICE_ID,
    timezone: 'Europe/Paris',
    days: days.map((day) => ({
      date: day.date,
      slots: day.slots.map((startsAt) => ({
        startsAt,
        endsAt: startsAt,
        staffId: STAFF_ID,
      })),
    })),
  };
}

describe('tenantAvailabilityKeyPrefix', () => {
  it('préfixe l’espace de clés par l’établissement', () => {
    expect(tenantAvailabilityKeyPrefix(TENANT_A)).toBe(
      `${AVAILABILITY_CACHE_NAMESPACE}:${TENANT_A}:`,
    );
  });

  it('termine par un séparateur — sans lui, « abc » couvrirait « abcd »', () => {
    // La collision serait silencieuse et intermittente : l'écriture d'un
    // établissement chasserait le cache d'un autre, sans que rien ne le dise.
    expect(tenantAvailabilityKeyPrefix('abc').startsWith(tenantAvailabilityKeyPrefix('abcd'))).toBe(
      false,
    );
    expect(tenantAvailabilityKeyPrefix('abcd').startsWith(tenantAvailabilityKeyPrefix('abc'))).toBe(
      false,
    );
  });
});

describe('availabilityDayKey', () => {
  it('suit la forme de booking-engine §3', () => {
    expect(availabilityDayKey(TENANT_A, SERVICE_ID, STAFF_ID, '2026-09-01')).toBe(
      `avail:${TENANT_A}:${SERVICE_ID}:${STAFF_ID}:2026-09-01`,
    );
  });

  it('commence par le préfixe du tenant — c’est ce qui rend l’invalidation possible', () => {
    expect(
      availabilityDayKey(TENANT_A, SERVICE_ID, STAFF_ID, '2026-09-01').startsWith(
        tenantAvailabilityKeyPrefix(TENANT_A),
      ),
    ).toBe(true);
  });

  it('distingue « tous praticiens » d’un praticien nommé', () => {
    // Les confondre servirait à la requête sans praticien les créneaux du seul
    // praticien nommé : une réponse amputée, donc des créneaux libres masqués.
    const anyone = availabilityDayKey(TENANT_A, SERVICE_ID, undefined, '2026-09-01');

    expect(anyone).toContain(`:${ANY_STAFF_KEY_SEGMENT}:`);
    expect(anyone).not.toBe(availabilityDayKey(TENANT_A, SERVICE_ID, STAFF_ID, '2026-09-01'));
  });
});

describe('AvailabilityCacheService', () => {
  let store: MemoryStore;
  let tenants: TenantContextService;
  let cache: AvailabilityCacheService;

  beforeEach(() => {
    store = new MemoryStore();
    tenants = new TenantContextService();
    cache = new AvailabilityCacheService(store, tenants);
  });

  const inTenant = async <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    tenants.runWithTenant(tenantId, fn);

  describe('invalidation', () => {
    it('chasse l’espace de clés de l’établissement courant', async () => {
      await inTenant(TENANT_A, async () => cache.invalidateCurrentTenant());

      expect(store.evictedPrefixes).toEqual([`${AVAILABILITY_CACHE_NAMESPACE}:${TENANT_A}:`]);
    });

    it('refuse d’invalider hors de toute portée de tenant', async () => {
      // Le mode ouvert par défaut est ce qui produit les fuites : sans tenant
      // résolu, l'invalidation ne doit pas retomber sur « tout le cache ».
      await expect(cache.invalidateCurrentTenant()).rejects.toThrow();
      expect(store.evictedPrefixes).toEqual([]);
    });

    it('ne touche pas au cache d’un autre établissement', async () => {
      const view = viewOf([{ date: '2026-09-01', slots: ['2026-09-01T08:00:00.000Z'] }]);

      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, view));
      await inTenant(TENANT_B, async () => cache.writeRange({ serviceId: SERVICE_ID }, view));

      await inTenant(TENANT_B, async () => cache.invalidateCurrentTenant());

      // L'écriture d'un salon ne doit pas faire recalculer le calendrier du
      // voisin, et surtout pas lui rendre autre chose que le sien.
      expect(
        await inTenant(TENANT_A, async () =>
          cache.readRange({ serviceId: SERVICE_ID }, ['2026-09-01']),
        ),
      ).not.toBeNull();
      expect(
        await inTenant(TENANT_B, async () =>
          cache.readRange({ serviceId: SERVICE_ID }, ['2026-09-01']),
        ),
      ).toBeNull();
    });
  });

  describe('lecture et écriture', () => {
    const DATES = ['2026-09-01', '2026-09-02'] as const;
    const VIEW = viewOf([
      { date: '2026-09-01', slots: ['2026-09-01T08:00:00.000Z'] },
      { date: '2026-09-02', slots: [] },
    ]);

    it('rend exactement la réponse qui avait été écrite', async () => {
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));

      expect(
        await inTenant(TENANT_A, async () => cache.readRange({ serviceId: SERVICE_ID }, [...DATES])),
      ).toEqual(VIEW);
    });

    it('écrit les journées vides comme les autres', async () => {
      // Omettre une journée sans créneau ferait manquer le cache à chaque
      // interrogation d'un salon fermé ce jour-là — le pire cas, pas le meilleur.
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));

      expect(store.entries.size).toBe(2);
    });

    it('pose la durée de vie courte du CDC', async () => {
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));

      expect(store.lastTtlSeconds).toBe(AVAILABILITY_CACHE_TTL_SECONDS);
      expect(AVAILABILITY_CACHE_TTL_SECONDS).toBe(60);
    });

    it('rend un défaut dès qu’une seule journée manque', async () => {
      // Tout ou rien : servir un mélange demanderait de recalculer une
      // sous-plage, donc de découper la requête pour économiser un calcul qui
      // tient déjà en six lectures.
      await inTenant(TENANT_A, async () =>
        cache.writeRange(
          { serviceId: SERVICE_ID },
          viewOf([{ date: '2026-09-01', slots: [] }]),
        ),
      );

      expect(
        await inTenant(TENANT_A, async () => cache.readRange({ serviceId: SERVICE_ID }, [...DATES])),
      ).toBeNull();
    });

    it('ne sert pas le cache « tous praticiens » à une requête ciblée', async () => {
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));

      expect(
        await inTenant(TENANT_A, async () =>
          cache.readRange({ serviceId: SERVICE_ID, staffId: STAFF_ID }, [...DATES]),
        ),
      ).toBeNull();
    });

    it('recalcule plutôt que de servir une entrée illisible', async () => {
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));
      store.entries.set(
        availabilityDayKey(TENANT_A, SERVICE_ID, undefined, '2026-09-01'),
        '{"timezone":"Europe/Paris","slots":[{"startsAt":',
      );

      expect(
        await inTenant(TENANT_A, async () => cache.readRange({ serviceId: SERVICE_ID }, [...DATES])),
      ).toBeNull();
    });

    it('recalcule plutôt que de servir un créneau d’une forme inconnue', async () => {
      // Un déploiement qui change la forme d'un créneau croise, quelques
      // secondes durant, des entrées de l'ancienne forme. Les rendre au client
      // servirait des créneaux qu'aucun schéma ne décrit.
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));
      store.entries.set(
        availabilityDayKey(TENANT_A, SERVICE_ID, undefined, '2026-09-01'),
        JSON.stringify({ timezone: 'Europe/Paris', slots: [{ startsAt: '2026-09-01T08:00:00Z' }] }),
      );

      expect(
        await inTenant(TENANT_A, async () => cache.readRange({ serviceId: SERVICE_ID }, [...DATES])),
      ).toBeNull();
    });

    it('recalcule quand le fuseau a changé en cours de plage', async () => {
      await inTenant(TENANT_A, async () => cache.writeRange({ serviceId: SERVICE_ID }, VIEW));
      store.entries.set(
        availabilityDayKey(TENANT_A, SERVICE_ID, undefined, '2026-09-02'),
        JSON.stringify({ timezone: 'Indian/Antananarivo', slots: [] }),
      );

      // Mélanger deux fuseaux rendrait un découpage en journées qui n'est celui
      // d'aucun calendrier.
      expect(
        await inTenant(TENANT_A, async () => cache.readRange({ serviceId: SERVICE_ID }, [...DATES])),
      ).toBeNull();
    });

    it('refuse de lire hors de toute portée de tenant', async () => {
      await expect(cache.readRange({ serviceId: SERVICE_ID }, [...DATES])).rejects.toThrow();
    });

    it('n’écrit rien pour une réponse sans journée', async () => {
      await inTenant(TENANT_A, async () =>
        cache.writeRange({ serviceId: SERVICE_ID }, viewOf([])),
      );

      expect(store.entries.size).toBe(0);
    });
  });
});

describe('UnwiredAvailabilityCacheStore', () => {
  const storeOf = (debug = jest.fn()): UnwiredAvailabilityCacheStore =>
    new UnwiredAvailabilityCacheStore({ debug } as unknown as StructuredLogger);

  it('journalise l’appel plutôt que de le taire', async () => {
    // C'est ce qui rend le chemin d'écriture observable quand aucun entrepôt
    // n'est branché — le mode dégradé, et celui des harnais de test.
    const debug = jest.fn();

    await storeOf(debug).evictByPrefix('avail:tenant:');

    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('rend un défaut pour chaque clé demandée', async () => {
    expect(await storeOf().readMany(['a', 'b'])).toEqual([null, null]);
  });

  it('accepte une écriture et la perd, sans échouer', async () => {
    await expect(storeOf().writeMany()).resolves.toBeUndefined();
  });
});
