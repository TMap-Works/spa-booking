import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type {
  AvailabilityRepository,
  StaffRecord,
  StaffScheduleRecord,
} from '../availability.repository';
import type { ScheduleRange } from '../availability.schedule';

/**
 * Doubles du module `availability`, partagés par ses suites unitaires et par les
 * suites d'isolation.
 *
 * Le dépôt en mémoire reproduit **cinq propriétés précises** du vrai, et chacune
 * porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent. C'est ce que l'extension Prisma
 *    fait en vrai. Un double qui ignorerait le tenant ferait passer les tests
 *    d'isolation pour de mauvaises raisons, ce qui est pire que de ne pas les
 *    écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération ;
 * 3. le **remplacement intégral** — `replaceStaffSchedule` retire puis réécrit,
 *    et ne touche jamais aux plages d'un autre praticien ni d'un autre
 *    établissement ;
 * 4. le **tri stable** — par jour puis par heure de début, comme l'`orderBy` du
 *    vrai. Sans lui, une assertion d'ordre passerait une fois sur deux ;
 * 5. la **lecture du fuseau de l'établissement courant**, et d'aucun autre : le
 *    modèle `Tenant` est scopé sur son `id` par l'extension.
 */

interface StoredSchedule {
  tenantId: string;
  staffId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}

interface StoredStaff {
  tenantId: string;
  id: string;
  isActive: boolean;
}

interface StoredTenant {
  id: string;
  timezone: string;
}

interface StoredClosingDay {
  tenantId: string;
  weekday: number;
}

export class FakeAvailabilityRepository {
  public readonly staff: StoredStaff[] = [];
  public readonly schedules: StoredSchedule[] = [];
  public readonly closingDays: StoredClosingDay[] = [];
  public readonly tenants: StoredTenant[] = [];

  /**
   * Déclare un établissement et son fuseau — l'équivalent d'une ligne `tenants`.
   *
   * Sans lui, `currentTimeZone` rend `null` et le service répond 404 : c'est le
   * comportement voulu pour un jeton signé sur une portée disparue, et il ne
   * doit pas être le comportement par défaut d'un test qui l'a oublié.
   */
  public seedTenant(input: { id: string; timezone?: string }): StoredTenant {
    const tenant: StoredTenant = { id: input.id, timezone: input.timezone ?? 'Europe/Paris' };
    this.tenants.push(tenant);
    return tenant;
  }

  /**
   * Insère un praticien **sans passer par la portée** — c'est l'équivalent d'un
   * jeu d'essai posé en base, pas d'un appel d'API. Le tenant est donc donné en
   * clair, ce qu'un test d'isolation doit pouvoir faire pour préparer les
   * données de l'établissement voisin.
   */
  public seedStaff(input: { tenantId: string; isActive?: boolean }): StoredStaff {
    const member: StoredStaff = {
      tenantId: input.tenantId,
      id: randomUUID(),
      isActive: input.isActive ?? true,
    };
    this.staff.push(member);
    return member;
  }

  public seedSchedule(input: {
    tenantId: string;
    staffId: string;
    weekday: number;
    startMinute: number;
    endMinute: number;
  }): StoredSchedule {
    const schedule: StoredSchedule = { ...input };
    this.schedules.push(schedule);
    return schedule;
  }

  public seedClosingDay(input: { tenantId: string; weekday: number }): StoredClosingDay {
    const day: StoredClosingDay = { ...input };
    this.closingDays.push(day);
    return day;
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Défaut fermé, comme l'extension : sans tenant, pas de données. Ne jamais
      // retomber sur « toutes les lignes » — c'est le mode ouvert qui fuit.
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }
    return tenantId;
  }

  public async currentTimeZone(): Promise<string | null> {
    const tenantId = this.requireTenant();

    return this.tenants.find((candidate) => candidate.id === tenantId)?.timezone ?? null;
  }

  public async findStaffById(id: string): Promise<StaffRecord | null> {
    const tenantId = this.requireTenant();
    const found = this.staff.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );

    return found === undefined ? null : { id: found.id, isActive: found.isActive };
  }

  public async listStaffSchedule(staffId: string): Promise<StaffScheduleRecord[]> {
    const tenantId = this.requireTenant();

    return this.schedules
      .filter((candidate) => candidate.tenantId === tenantId && candidate.staffId === staffId)
      .map((candidate) => ({
        weekday: candidate.weekday,
        startMinute: candidate.startMinute,
        endMinute: candidate.endMinute,
      }))
      .sort((left, right) =>
        left.weekday === right.weekday
          ? left.startMinute - right.startMinute
          : left.weekday - right.weekday,
      );
  }

  public async replaceStaffSchedule(
    staffId: string,
    ranges: readonly ScheduleRange[],
  ): Promise<StaffScheduleRecord[]> {
    const tenantId = this.requireTenant();

    // Retrait borné au couple (tenant, praticien) : le vrai `deleteMany` porte
    // le même `where`, l'extension y ajoutant `tenant_id`.
    for (let index = this.schedules.length - 1; index >= 0; index -= 1) {
      const candidate = this.schedules[index];
      if (candidate !== undefined && candidate.tenantId === tenantId && candidate.staffId === staffId) {
        this.schedules.splice(index, 1);
      }
    }

    for (const range of ranges) {
      this.schedules.push({
        tenantId,
        staffId,
        weekday: range.weekday,
        startMinute: range.startMinute,
        endMinute: range.endMinute,
      });
    }

    return this.listStaffSchedule(staffId);
  }

  public async listClosedWeekdays(): Promise<number[]> {
    const tenantId = this.requireTenant();

    return this.closingDays
      .filter((candidate) => candidate.tenantId === tenantId)
      .map((candidate) => candidate.weekday)
      .sort((left, right) => left - right);
  }

  public async replaceClosedWeekdays(weekdays: readonly number[]): Promise<number[]> {
    const tenantId = this.requireTenant();

    for (let index = this.closingDays.length - 1; index >= 0; index -= 1) {
      if (this.closingDays[index]?.tenantId === tenantId) {
        this.closingDays.splice(index, 1);
      }
    }

    for (const weekday of weekdays) {
      this.closingDays.push({ tenantId, weekday });
    }

    return this.listClosedWeekdays();
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asRepository(): AvailabilityRepository {
    return this as unknown as AvailabilityRepository;
  }
}
