import type { INestApplication } from '@nestjs/common';

import { FakeStaffTimeOffRepository } from '../src/modules/availability/__tests__/staff-time-off.doubles';
import { FakeAvailabilityRepository } from '../src/modules/availability/__tests__/availability.doubles';
import {
  AVAILABILITY_CACHE_STORE,
  type AvailabilityCacheEntry,
  type AvailabilityCacheStore,
} from '../src/modules/availability/availability-cache';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { StaffTimeOffRepository } from '../src/modules/availability/staff-time-off.repository';
import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import type { UserRole } from '../src/modules/identity/roles';
import { createTenantHarness, type TenantFixture, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage de l'endpoint de disponibilité pour ses suites d'intégration et
 * d'isolation (#35).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`), comme
 * `availability.harness.ts` et `appointments.harness.ts` : deux établissements,
 * l'application réellement câblée par `configureApp`, des jetons signés par le
 * vrai `TokenService`, et les slugs par lesquels l'espace public les désigne.
 *
 * ## Pourquoi un harnais de plus
 *
 * `availability.harness.ts` ne substitue que `AvailabilityRepository` : il sert
 * les quatre routes de back-office du module, qui ne touchent pas au catalogue.
 * L'endpoint de créneaux, lui, traverse trois modules — il lui faut la durée et
 * les tampons d'une prestation, l'affectation d'un praticien, ses horaires, et
 * ses absences. C'est la même matière que `appointments.harness.ts` prépare pour
 * réserver, mais ce harnais-là n'expose ni jeton ni entrepôt de cache, dont les
 * deux surfaces de #35 ont besoin.
 *
 * ## L'entrepôt de cache est en mémoire, et c'est nécessaire
 *
 * `AVAILABILITY_CACHE_STORE` est branché sur Redis en production. Le laisser tel
 * quel ici ferait dépendre le verdict d'un serveur joignable — et, quand il l'est,
 * d'un espace de clés partagé avec les autres suites. L'entrepôt en mémoire rend
 * la suite déterministe **et** permet de lire ce que le cache contient, ce qu'un
 * Redis réel ne donnerait qu'au prix d'une seconde connexion dans le test.
 *
 * Ce que cela ne prouve pas : que `RedisAvailabilityCacheStore` parle
 * correctement à Redis. Ce n'est pas ce qu'un test d'intégration d'API a à
 * établir — ioredis est testé par ses auteurs, et le contrat que ce module lui
 * demande de tenir est celui de `AvailabilityCacheStore`, que l'entrepôt en
 * mémoire honore à l'identique.
 *
 * ## Le fuseau est `UTC`, et l'horaire est calculé depuis « maintenant »
 *
 * Même arbitrage que `appointments.harness.ts` : la conversion heure murale ↔
 * instant a ses propres suites (#41), et une date en dur ferait de celle-ci une
 * bombe à retardement — le préavis minimum écarte tout créneau passé, et la
 * suite deviendrait rouge le jour où la date choisie serait derrière nous.
 */

/** Fuseau des deux établissements — voir l'en-tête. */
export const TENANT_TIMEZONE = 'UTC';

const SLOT_INTERVAL_MINUTES = 15;
const SERVICE_DURATION_MINUTES = 60;
const BUFFER_MINUTES = 10;
const SERVICE_PRICE_MINOR = 7500;

const WORKDAY_START_MINUTE = 9 * 60;
const WORKDAY_END_MINUTE = 18 * 60;

const DAY_MS = 86_400_000;

/** Entrepôt de cache en mémoire — l'espace de clés d'un Redis, sans Redis. */
export class MemoryAvailabilityCacheStore implements AvailabilityCacheStore {
  public readonly entries = new Map<string, string>();

  public evictByPrefix(prefix: string): Promise<void> {
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

  public writeMany(entries: readonly AvailabilityCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.key, entry.value);
    }

    return Promise.resolve();
  }

  /** Les clés posées pour cet établissement — l'assertion d'étanchéité. */
  public keysOf(tenantId: string): string[] {
    return [...this.entries.keys()].filter((key) => key.startsWith(`avail:${tenantId}:`));
  }
}

/** Ce qu'un établissement du harnais expose comme matière à interroger. */
export interface ServedTenant {
  readonly tenant: TenantFixture;
  readonly serviceId: string;
  readonly staffId: string;
}

export interface AvailabilityEndpointHarness {
  app: INestApplication;
  catalog: FakeCatalogRepository;
  availability: FakeAvailabilityRepository;
  cache: MemoryAvailabilityCacheStore;
  /** L'établissement de l'appelant. */
  a: ServedTenant;
  /** L'établissement voisin, pour les scénarios de traversée. */
  b: ServedTenant;
  bearer(role: UserRole, tenant?: TenantFixture): Promise<string>;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

/**
 * La journée ouvrée du harnais, quatorze jours plus tard, en date civile.
 *
 * Le fuseau étant `UTC`, la date civile de l'établissement est la date UTC —
 * c'est ce qui permet d'écrire l'assertion sans rejouer une conversion.
 */
export function servedDay(): string {
  return new Date(Date.now() + 14 * DAY_MS).toISOString().slice(0, 10);
}

/** Le jour ISO de la semaine (1 = lundi) de la journée servie. */
function servedWeekday(): number {
  return ((new Date(`${servedDay()}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

export async function createAvailabilityEndpointHarness(): Promise<AvailabilityEndpointHarness> {
  const catalog = new FakeCatalogRepository();
  const availability = new FakeAvailabilityRepository();
  const timeOff = new FakeStaffTimeOffRepository();
  const cache = new MemoryAvailabilityCacheStore();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: CatalogRepository, useValue: catalog },
      { provide: AvailabilityRepository, useValue: availability },
      { provide: StaffTimeOffRepository, useValue: timeOff },
      { provide: AVAILABILITY_CACHE_STORE, useValue: cache },
    ],
  });

  const weekday = servedWeekday();

  const equip = (tenant: TenantFixture): ServedTenant => {
    availability.seedTenant({
      id: tenant.id,
      timezone: TENANT_TIMEZONE,
      slotIntervalMinutes: SLOT_INTERVAL_MINUTES,
    });

    const service = catalog.seedService({
      tenantId: tenant.id,
      durationMinutes: SERVICE_DURATION_MINUTES,
      bufferBeforeMinutes: BUFFER_MINUTES,
      bufferAfterMinutes: BUFFER_MINUTES,
      priceAmountMinor: SERVICE_PRICE_MINOR,
    });

    const staff = availability.seedStaff({ tenantId: tenant.id });
    availability.seedServiceStaff({ tenantId: tenant.id, serviceId: service.id, staffId: staff.id });
    availability.seedSchedule({
      tenantId: tenant.id,
      staffId: staff.id,
      weekday,
      startMinute: WORKDAY_START_MINUTE,
      endMinute: WORKDAY_END_MINUTE,
    });
    timeOff.registerStaff(tenant.id, staff.id);

    return { tenant, serviceId: service.id, staffId: staff.id };
  };

  return {
    app: harness.app,
    catalog,
    availability,
    cache,
    a: equip(harness.a),
    b: equip(harness.b),
    bearer: (role, tenant) => harness.bearer(role, tenant),
    server: () => harness.server(),
    close: () => harness.close(),
  };
}
