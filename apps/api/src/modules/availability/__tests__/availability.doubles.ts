import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import { OCCUPYING_STATUSES } from '../../appointments/appointment-status';
import type {
  AvailabilityRepository,
  StaffRecord,
  StaffScheduleRangeRecord,
  StaffScheduleRecord,
  TenantBookingSettingsRecord,
} from '../availability.repository';
import type { ScheduleRange } from '../availability.schedule';
import type { StaffBusyRange, TimeOffWindow } from '../staff-time-off.types';

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
 *
 * #34 en ajoute trois, sur les tables que le module lit sans les posséder :
 *
 * 6. `service_staff` ne rend que les praticiens **actifs** — le filtre porte sur
 *    la fiche jointe, pas sur l'affectation, qui lui survit ;
 * 7. `appointments` ne rend que les statuts **occupants** (`PENDING`,
 *    `CONFIRMED`). Un double complaisant sur ce point ferait passer au vert un
 *    moteur qui masque les créneaux d'un rendez-vous annulé ;
 * 8. le **recoupement** de fenêtre, `startsAt < to AND endsAt > from`, et non
 *    l'inclusion : un rendez-vous commencé avant la fenêtre et courant encore
 *    occupe bien le praticien pendant celle-ci.
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
  slotIntervalMinutes: number;
  minBookingNoticeMinutes: number;
}

interface StoredClosingDay {
  tenantId: string;
  weekday: number;
}

/** Une affectation `service_staff`, telle que le catalogue l'écrit (#24). */
interface StoredServiceStaff {
  tenantId: string;
  serviceId: string;
  staffId: string;
}

/**
 * Un rendez-vous, réduit à ce que le moteur de créneaux en lit (#31, #34).
 *
 * Ni client, ni prix, ni notes : la projection du vrai repository ne les
 * sélectionne pas, et un double plus bavard laisserait passer un test qui les
 * lirait. `status` y figure parce que c'est lui qui décide si le créneau est
 * occupé.
 */
interface StoredAppointment {
  tenantId: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
}

/**
 * Les statuts qui occupent l'agenda — la **même** liste que le vrai repository,
 * importée de #31 et non recopiée : un double qui figerait sa propre liste
 * cesserait de rougir le jour où la vraie change.
 */
const OCCUPYING = new Set<string>(OCCUPYING_STATUSES);

export class FakeAvailabilityRepository {
  public readonly staff: StoredStaff[] = [];
  public readonly schedules: StoredSchedule[] = [];
  public readonly closingDays: StoredClosingDay[] = [];
  public readonly tenants: StoredTenant[] = [];
  public readonly serviceStaff: StoredServiceStaff[] = [];
  public readonly appointments: StoredAppointment[] = [];

  /**
   * Déclare un établissement, son fuseau et ses réglages de créneaux —
   * l'équivalent d'une ligne `tenants`.
   *
   * Sans lui, `currentTimeZone` rend `null` et le service répond 404 : c'est le
   * comportement voulu pour un jeton signé sur une portée disparue, et il ne
   * doit pas être le comportement par défaut d'un test qui l'a oublié.
   *
   * Les deux réglages reprennent les valeurs par défaut de la colonne (#34), de
   * sorte qu'un test qui ne s'y intéresse pas n'a pas à les écrire — et qu'un
   * test qui s'y intéresse les pose explicitement.
   */
  public seedTenant(input: {
    id: string;
    timezone?: string;
    slotIntervalMinutes?: number;
    minBookingNoticeMinutes?: number;
  }): StoredTenant {
    const tenant: StoredTenant = {
      id: input.id,
      timezone: input.timezone ?? 'Europe/Paris',
      slotIntervalMinutes: input.slotIntervalMinutes ?? 15,
      minBookingNoticeMinutes: input.minBookingNoticeMinutes ?? 60,
    };
    this.tenants.push(tenant);
    return tenant;
  }

  /** Affecte un praticien à une prestation — l'équivalent d'une ligne `service_staff`. */
  public seedServiceStaff(input: {
    tenantId: string;
    serviceId: string;
    staffId: string;
  }): StoredServiceStaff {
    const assignment: StoredServiceStaff = { ...input };
    this.serviceStaff.push(assignment);
    return assignment;
  }

  /** Pose un rendez-vous sur l'agenda d'un praticien. `PENDING` par défaut. */
  public seedAppointment(input: {
    tenantId: string;
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    status?: string;
  }): StoredAppointment {
    const appointment: StoredAppointment = { ...input, status: input.status ?? 'PENDING' };
    this.appointments.push(appointment);
    return appointment;
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

  public async currentBookingSettings(): Promise<TenantBookingSettingsRecord | null> {
    const tenantId = this.requireTenant();
    const found = this.tenants.find((candidate) => candidate.id === tenantId);

    return found === undefined
      ? null
      : {
          timezone: found.timezone,
          slotIntervalMinutes: found.slotIntervalMinutes,
          minBookingNoticeMinutes: found.minBookingNoticeMinutes,
        };
  }

  public async findStaffById(id: string): Promise<StaffRecord | null> {
    const tenantId = this.requireTenant();
    const found = this.staff.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );

    return found === undefined ? null : { id: found.id, isActive: found.isActive };
  }

  /**
   * Les praticiens **actifs** affectés à la prestation, croissants.
   *
   * Le filtre sur `isActive` est celui du vrai — il porte sur la table `staff`
   * jointe, pas sur l'affectation : une affectation survit à la désactivation du
   * praticien, et c'est le moteur de créneaux qui l'écarte.
   */
  public async listServiceStaffIds(serviceId: string): Promise<string[]> {
    const tenantId = this.requireTenant();
    const active = new Set(
      this.staff
        .filter((member) => member.tenantId === tenantId && member.isActive)
        .map((member) => member.id),
    );

    return this.serviceStaff
      .filter(
        (assignment) =>
          assignment.tenantId === tenantId &&
          assignment.serviceId === serviceId &&
          active.has(assignment.staffId),
      )
      .map((assignment) => assignment.staffId)
      .sort((left, right) => left.localeCompare(right));
  }

  public async listSchedulesForStaff(
    staffIds: readonly string[],
  ): Promise<StaffScheduleRangeRecord[]> {
    const tenantId = this.requireTenant();

    if (staffIds.length === 0) {
      return [];
    }

    const wanted = new Set(staffIds);

    return this.schedules
      .filter((candidate) => candidate.tenantId === tenantId && wanted.has(candidate.staffId))
      .map((candidate) => ({
        staffId: candidate.staffId,
        weekday: candidate.weekday,
        startMinute: candidate.startMinute,
        endMinute: candidate.endMinute,
      }))
      .sort(
        (left, right) =>
          left.staffId.localeCompare(right.staffId) ||
          left.weekday - right.weekday ||
          left.startMinute - right.startMinute,
      );
  }

  /**
   * Les rendez-vous qui **recoupent** la fenêtre — `startsAt < to AND endsAt >
   * from`, et non l'inclusion.
   *
   * Le prédicat est celui du vrai : un rendez-vous commencé avant la fenêtre et
   * courant encore occupe bien le praticien pendant celle-ci. Le double le
   * reproduit pour que le test le constate plutôt que de le supposer.
   */
  public async listBookedRanges(
    staffIds: readonly string[],
    window: TimeOffWindow,
  ): Promise<StaffBusyRange[]> {
    const tenantId = this.requireTenant();

    if (staffIds.length === 0) {
      return [];
    }

    const wanted = new Set(staffIds);

    return this.appointments
      .filter(
        (candidate) =>
          candidate.tenantId === tenantId &&
          wanted.has(candidate.staffId) &&
          OCCUPYING.has(candidate.status) &&
          candidate.startsAt.getTime() < window.to.getTime() &&
          candidate.endsAt.getTime() > window.from.getTime(),
      )
      .map((candidate) => ({
        staffId: candidate.staffId,
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
      }))
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
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
