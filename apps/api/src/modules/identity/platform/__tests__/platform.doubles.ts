import { randomUUID } from 'node:crypto';

import type { Locale } from '@spa/shared';

import type { PlatformConsoleRepository } from '../platform-console.repository';
import type { PlatformRepository, ProvisioningRecord, TenantAdminRecord } from '../platform.repository';
import { TenantSlugTakenError } from '../platform.errors';
import type {
  OverviewCounts,
  PlatformOperatorRecord,
  ProvisionTenantInput,
  ProvisionedTenantRecord,
  TenantAccountRecord,
  TenantActivityRecord,
  TenantDetailRecord,
  TenantEventRecord,
  TenantSetupRecord,
  TenantSummary,
} from '../platform.types';

/**
 * Le dépôt de la console, en mémoire.
 *
 * Il rejoue les **invariants de la base**, et c'est tout ce qu'on lui demande :
 * l'unicité globale du slug, l'unicité de la clé d'idempotence, et le refus
 * d'un opérateur désactivé. Ce sont les trois contraintes sur lesquelles repose
 * le comportement du service — un double qui les ignorerait ferait passer au
 * vert un service qui ne tient rien.
 *
 * Il ne rejoue **pas** la transaction : les trois écritures sont faites à la
 * suite, et un double ne prouverait rien de leur atomicité. C'est
 * `test/platform-console.isolation-spec.ts`, contre l'application réellement
 * câblée, qui exerce le chemin HTTP de bout en bout.
 */
export class FakePlatformRepository {
  private readonly operators = new Map<string, PlatformOperatorRecord>();
  private readonly tenants = new Map<string, TenantSummary>();
  private readonly admins = new Map<string, TenantAdminRecord>();
  private readonly provisionings = new Map<string, ProvisioningRecord>();

  /** Les rejeux d'idempotence observés — ce que le service a demandé deux fois. */
  public lastLoginTouched: string | null = null;

  /**
   * La dernière charge d'ouverture reçue, telle que le service l'a composée.
   *
   * Retenue parce que `TenantSummary` ne porte pas tout ce que l'écriture pose :
   * `defaultLocale` (#844) se décide **dans le service** — un défaut résolu là
   * et nulle part ailleurs — et c'est cette résolution-là qu'un test doit voir,
   * pas la projection qu'en rend la console.
   */
  public lastProvisionInput: ProvisionTenantInput | null = null;

  public addOperator(input: {
    email: string;
    passwordHash: string;
    totpSecret: string;
    isActive?: boolean;
  }): PlatformOperatorRecord {
    const operator: PlatformOperatorRecord = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      totpSecret: input.totpSecret,
      firstName: 'Opé',
      lastName: 'Rateur',
      isActive: input.isActive ?? true,
    };
    this.operators.set(operator.id, operator);
    return operator;
  }

  public addTenant(input: { slug: string; name?: string; withAdmin?: boolean }): TenantSummary {
    const tenant: TenantSummary = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name ?? input.slug,
      timezone: 'Europe/Paris',
      defaultCurrency: 'EUR',
      isActive: true,
      billingStatus: 'managed',
      trialEndsAt: null,
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      origin: 'console',
    };
    this.tenants.set(tenant.id, tenant);
    if (input.withAdmin !== false) {
      this.admins.set(tenant.id, {
        id: randomUUID(),
        email: `admin@${input.slug}.test`,
        firstName: 'Alice',
        lastName: 'Durand',
      });
    }
    return tenant;
  }

  public async findActiveOperatorByEmail(email: string): Promise<PlatformOperatorRecord | null> {
    for (const operator of this.operators.values()) {
      if (operator.email === email && operator.isActive) {
        return operator;
      }
    }
    return null;
  }

  public async findActiveOperatorById(id: string): Promise<{ id: string; email: string } | null> {
    const operator = this.operators.get(id);
    return operator === undefined || !operator.isActive
      ? null
      : { id: operator.id, email: operator.email };
  }

  public async touchOperatorLastLogin(id: string): Promise<void> {
    this.lastLoginTouched = id;
  }

  public async findProvisioningByIdempotencyKey(key: string): Promise<ProvisioningRecord | null> {
    return this.provisionings.get(key) ?? null;
  }

  public async provisionTenant(input: ProvisionTenantInput): Promise<ProvisionedTenantRecord> {
    this.lastProvisionInput = input;
    for (const tenant of this.tenants.values()) {
      if (tenant.slug === input.slug) {
        throw new TenantSlugTakenError(input.slug);
      }
    }
    if (this.provisionings.has(input.idempotencyKey)) {
      throw new Error('clé d’idempotence déjà consommée');
    }

    const createdAt = new Date('2026-09-17T12:00:00.000Z');
    const tenant: TenantSummary = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      timezone: input.timezone,
      defaultCurrency: input.defaultCurrency,
      isActive: true,
      billingStatus: 'managed',
      trialEndsAt: null,
      createdAt,
      origin: 'console',
    };
    this.tenants.set(tenant.id, tenant);

    const admin: TenantAdminRecord = {
      id: randomUUID(),
      email: input.adminEmail,
      firstName: input.adminFirstName,
      lastName: input.adminLastName,
    };
    this.admins.set(tenant.id, admin);

    this.provisionings.set(input.idempotencyKey, {
      operatorId: input.operatorId,
      createdTenantId: tenant.id,
      createdAt,
    });

    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      timezone: tenant.timezone,
      defaultCurrency: tenant.defaultCurrency,
      adminUserId: admin.id,
      adminEmail: admin.email,
      createdAt,
    };
  }

  public async findTenantById(id: string): Promise<TenantSummary | null> {
    return this.tenants.get(id) ?? null;
  }

  public async listTenants(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: TenantSummary[]; totalItems: number }> {
    const all = [...this.tenants.values()].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
    const start = (input.page - 1) * input.pageSize;
    return { items: all.slice(start, start + input.pageSize), totalItems: all.length };
  }

  public async findTenantAdmin(tenantId: string): Promise<TenantAdminRecord | null> {
    return this.admins.get(tenantId) ?? null;
  }

  /** Pose l'état d'un salon — ce que la console fait par sa propre table. */
  public setActive(id: string, isActive: boolean): void {
    const tenant = this.tenants.get(id);
    if (tenant !== undefined) {
      this.tenants.set(id, { ...tenant, isActive });
    }
  }

  public asRepository(): PlatformRepository {
    return this as unknown as PlatformRepository;
  }
}

/**
 * Le double du dépôt de la console — une mémoire, et de quoi régler ce que la
 * fiche d'un salon rapporte.
 *
 * Il s'appuie sur le double de `PlatformRepository` pour savoir quels salons
 * existent : c'est la même base, lue par deux dépôts.
 */
export class FakePlatformConsoleRepository {
  public readonly events: (TenantEventRecord & { tenantId: string })[] = [];
  public counts: OverviewCounts = {
    total: 0,
    suspended: 0,
    byBillingStatus: { managed: 0, pending: 0, trialing: 0, active: 0, past_due: 0, canceled: 0 },
    trialsEndingSoon: [],
    recentOpenings: [],
    activation: { opened: 0, configured: 0, booked: 0, activeLast30Days: 0 },
    recent: [],
  };
  public lastOverviewWindow: { now: Date; trialHorizon: Date; openingsSince: Date } | null = null;
  public accounts: TenantAccountRecord[] = [];
  public setupRecord: TenantSetupRecord = {
    openingHours: false,
    activeServices: 0,
    activeStaff: 0,
    staffWithSchedule: 0,
    firstAppointmentAt: null,
  };
  /**
   * La langue que la fiche rapporte (#1189).
   *
   * `fr` et non `DEFAULT_LOCALE` — qui vaut `en` : une assertion sur la langue
   * par défaut du système passerait au vert même si la valeur ne venait pas du
   * dépôt.
   */
  public tenantLocale: Locale = 'fr';
  public activityRecord: TenantActivityRecord = {
    createdLast30Days: 0,
    upcoming: 0,
    completedLast30Days: 0,
    noShowLast30Days: 0,
    cancelledLast30Days: 0,
    lastBookingAt: null,
  };
  public revokedSessions = 0;

  public constructor(private readonly tenants: FakePlatformRepository) {}

  public async overviewCounts(input: {
    now: Date;
    trialHorizon: Date;
    openingsSince: Date;
    activitySince: Date;
  }): Promise<OverviewCounts> {
    this.lastOverviewWindow = input;
    return this.counts;
  }

  public async findTenantDetail(id: string): Promise<TenantDetailRecord | null> {
    const summary = await this.tenants.findTenantById(id);
    if (summary === null) {
      return null;
    }
    return {
      summary,
      contactEmail: 'contact@salon.test',
      contactPhone: '+33142000000',
      address: { line1: '12 rue des Lilas', line2: null, postalCode: '75011', city: 'Paris', country: 'FR' },
      legalName: null,
      hasLegalId: false,
      defaultLocale: this.tenantLocale,
      currentPeriodEndsAt: null,
      stripeCustomerId: null,
    };
  }

  public async listInternalAccounts(): Promise<TenantAccountRecord[]> {
    return this.accounts;
  }

  public async countClients(): Promise<number> {
    return 7;
  }

  public async setup(): Promise<TenantSetupRecord> {
    return this.setupRecord;
  }

  public async activity(): Promise<TenantActivityRecord> {
    return this.activityRecord;
  }

  public async listEvents(tenantId: string): Promise<TenantEventRecord[]> {
    return this.events
      .filter((event) => event.tenantId === tenantId)
      .map(({ tenantId: _tenantId, ...event }) => event)
      .reverse();
  }

  public async recordEvent(input: {
    tenantId: string;
    operatorId: string;
    kind: 'NOTE' | 'INVITATION_REISSUED';
    body: string | null;
  }): Promise<TenantEventRecord> {
    const event = {
      id: randomUUID(),
      tenantId: input.tenantId,
      kind: input.kind.toLowerCase() as TenantEventRecord['kind'],
      body: input.body,
      operatorName: 'Opé R.',
      createdAt: new Date('2026-09-18T12:00:00.000Z'),
    };
    this.events.push(event);
    const { tenantId: _tenantId, ...record } = event;
    return record;
  }

  public async setTenantActive(input: {
    tenantId: string;
    operatorId: string;
    isActive: boolean;
    reason: string;
    now: Date;
  }): Promise<{ changed: boolean; revokedSessions: number } | null> {
    const tenant = await this.tenants.findTenantById(input.tenantId);
    if (tenant === null) {
      return null;
    }
    if (tenant.isActive === input.isActive) {
      return { changed: false, revokedSessions: 0 };
    }
    this.tenants.setActive(input.tenantId, input.isActive);
    this.events.push({
      id: randomUUID(),
      tenantId: input.tenantId,
      kind: input.isActive ? 'reactivated' : 'suspended',
      body: input.reason,
      operatorName: 'Opé R.',
      createdAt: input.now,
    });
    return { changed: true, revokedSessions: input.isActive ? 0 : this.revokedSessions };
  }

  public asRepository(): PlatformConsoleRepository {
    return this as unknown as PlatformConsoleRepository;
  }
}
