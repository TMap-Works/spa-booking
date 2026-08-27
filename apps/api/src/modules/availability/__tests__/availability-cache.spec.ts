import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  AVAILABILITY_CACHE_NAMESPACE,
  type AvailabilityCacheStore,
  AvailabilityCacheService,
  UnwiredAvailabilityCacheStore,
  tenantAvailabilityKeyPrefix,
} from '../availability-cache';

/**
 * Invalidation du cache de disponibilité (#33, critère 4).
 *
 * Ce qui se vérifie ici n'est pas qu'un cache est vidé — il n'y en a pas encore,
 * c'est #34 qui l'écrira — mais que **le préfixe visé est le bon** et qu'il
 * commence par l'établissement courant. Une clé de cache sans tenant en tête est
 * une collision entre établissements (tenant-isolation §5), et c'est le genre de
 * défaut qui ne se manifeste qu'en production, par intermittence.
 */

const TENANT_A = randomUUID();

class RecordingStore implements AvailabilityCacheStore {
  public readonly prefixes: string[] = [];

  public evictByPrefix(prefix: string): Promise<void> {
    this.prefixes.push(prefix);

    return Promise.resolve();
  }
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

describe('AvailabilityCacheService', () => {
  let store: RecordingStore;
  let tenants: TenantContextService;
  let cache: AvailabilityCacheService;

  beforeEach(() => {
    store = new RecordingStore();
    tenants = new TenantContextService();
    cache = new AvailabilityCacheService(store, tenants);
  });

  it('chasse l’espace de clés de l’établissement courant', async () => {
    await tenants.runWithTenant(TENANT_A, async () => cache.invalidateCurrentTenant());

    expect(store.prefixes).toEqual([`${AVAILABILITY_CACHE_NAMESPACE}:${TENANT_A}:`]);
  });

  it('refuse d’invalider hors de toute portée de tenant', async () => {
    // Le mode ouvert par défaut est ce qui produit les fuites : sans tenant
    // résolu, l'invalidation ne doit pas retomber sur « tout le cache ».
    await expect(cache.invalidateCurrentTenant()).rejects.toThrow();
    expect(store.prefixes).toEqual([]);
  });
});

describe('UnwiredAvailabilityCacheStore', () => {
  it('journalise l’appel plutôt que de le taire', async () => {
    // C'est ce qui rend le chemin d'écriture observable tant qu'aucun entrepôt
    // Redis n'est branché — la substitution par #34 ne change rien à l'appelant.
    const debug = jest.fn();
    const store = new UnwiredAvailabilityCacheStore({ debug } as unknown as StructuredLogger);

    await store.evictByPrefix('avail:tenant:');

    expect(debug).toHaveBeenCalledTimes(1);
  });
});
