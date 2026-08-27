import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { OverlappingScheduleRangesError } from './availability.errors';
import { AvailabilityRepository } from './availability.repository';
import {
  firstOverlap,
  isIsoWeekday,
  localTimeToMinutes,
  minutesToLocalTime,
  workingWindows,
  type IsoWeekday,
  type ScheduleRange,
  type WorkingWindow,
} from './availability.schedule';
import type { StaffScheduleEntryView, StaffScheduleView } from './availability.types';
import { TenantClockService } from './tenant-clock.service';

/**
 * Horaires récurrents du personnel — CDC §1.4, gestion du personnel (#32).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`, et c'est voulu : le
 * client Prisma injecté dans le repository est **scopé** par le contexte de
 * requête, que `JwtAuthGuard` a renseigné depuis une revendication signée. Une
 * lecture visant le praticien d'un autre établissement ne le trouve donc pas —
 * elle rend `null`, que ce service traduit en `NotFoundError`, donc en 404.
 *
 * Un service qui aurait comparé les tenants lui-même aurait eu un `if` à écrire,
 * et ce `if` aurait eu à choisir entre 403 et 404. Le 403 est précisément la
 * fuite qu'on refuse (tenant-isolation §4). Ne pas avoir l'information est la
 * meilleure garantie de ne pas la divulguer.
 *
 * ## La conversion se fait ici, et une seule fois
 *
 * Le service manipule des **heures murales** en entrée et en sortie, des
 * **minutes** en base, et ne produit d'instants que dans `windowsFor` — en
 * passant par `TenantClockService` (#41), qui recalcule l'offset pour l'instant
 * considéré. Aucun décalage n'est mémorisé nulle part : c'est le seul moyen que
 * l'agenda reste juste des deux côtés d'un changement d'heure.
 */
@Injectable()
export class StaffScheduleService {
  public constructor(
    private readonly repository: AvailabilityRepository,
    private readonly clock: TenantClockService,
  ) {}

  /**
   * La semaine de travail d'un praticien de l'établissement courant.
   *
   * Le 404 couvre indistinctement « n'existe nulle part » et « existe dans un
   * autre établissement » — la différence entre les deux est précisément
   * l'information à ne pas donner.
   */
  public async forStaff(staffId: string): Promise<StaffScheduleView> {
    await this.requireStaff(staffId);

    const [timezone, records] = await Promise.all([
      this.requireTimeZone(),
      this.repository.listStaffSchedule(staffId),
    ]);

    return { staffId, timezone, entries: records.map((record) => toEntryView(record)) };
  }

  /**
   * Remplace la semaine de travail d'un praticien.
   *
   * Le recouvrement est refusé **avant** l'écriture, pour le nommer : la
   * contrainte d'exclusion en base porte la même règle, mais elle ne dirait que
   * « violation de contrainte », donc 500. Les deux ne font pas double emploi —
   * la base reste la garantie, ce contrôle est le message.
   */
  public async replace(
    staffId: string,
    entries: readonly StaffScheduleEntryView[],
  ): Promise<StaffScheduleView> {
    await this.requireStaff(staffId);

    const ranges = entries.map((entry) => toRange(entry));
    const clash = firstOverlap(ranges);

    if (clash !== null) {
      throw new OverlappingScheduleRangesError(
        clash.left.weekday,
        describeRange(clash.left),
        describeRange(clash.right),
      );
    }

    const [timezone, records] = await Promise.all([
      this.requireTimeZone(),
      this.repository.replaceStaffSchedule(staffId, ranges),
    ]);

    return { staffId, timezone, entries: records.map((record) => toEntryView(record)) };
  }

  /**
   * Les fenêtres de travail réelles d'un praticien, en instants UTC.
   *
   * C'est ce que consommera le calcul de créneaux (#34) : « horaires − jours de
   * fermeture de l'établissement », auquel il retranchera les congés (#33) et
   * les rendez-vous déjà pris. La méthode est publique et le module l'exporte
   * pour cette raison — un appel de service, jamais un import de fichier profond
   * (api-module §3).
   *
   * `from` et `to` sont des **dates civiles** du tenant, bornes comprises : c'est
   * ce qu'affiche un calendrier, et le seul référentiel dans lequel « le mardi »
   * veut dire quelque chose.
   */
  public async windowsFor(
    staffId: string,
    from: string,
    to: string,
  ): Promise<readonly WorkingWindow[]> {
    await this.requireStaff(staffId);

    const [timeZone, records, closed] = await Promise.all([
      this.requireTimeZone(),
      this.repository.listStaffSchedule(staffId),
      this.repository.listClosedWeekdays(),
    ]);

    return workingWindows(this.clock, {
      ranges: records.map((record) => toStoredRange(record)),
      closedWeekdays: new Set(closed.filter(isIsoWeekday)),
      timeZone,
      from,
      to,
    });
  }

  /**
   * Le praticien, ou 404.
   *
   * Un praticien **désactivé** garde ses horaires : ils sont ce qui l'attend
   * s'il revient, et les effacer à la désactivation obligerait à les ressaisir.
   * C'est le calcul de créneaux qui écarte les praticiens inactifs, comme le
   * catalogue public le fait déjà de ses affectations.
   */
  private async requireStaff(staffId: string): Promise<void> {
    const staff = await this.repository.findStaffById(staffId);

    if (staff === null) {
      throw new NotFoundError('Praticien introuvable.');
    }
  }

  /**
   * Le fuseau de l'établissement courant.
   *
   * `tenants.timezone` est `NOT NULL` : l'absence ne peut venir que d'un
   * établissement qui n'existe pas — un jeton signé sur une portée disparue. Le
   * 404 est alors la bonne réponse, et la seule qui n'apprenne rien.
   */
  private async requireTimeZone(): Promise<string> {
    const timezone = await this.repository.currentTimeZone();

    if (timezone === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return timezone;
  }
}

/** Une plage de la base, sous la forme que l'API rend. */
function toEntryView(record: { weekday: number; startMinute: number; endMinute: number }): StaffScheduleEntryView {
  return {
    // La colonne est bornée à 1-7 par un `CHECK` : la conversion ne peut pas
    // mentir, et un `filter` ici ferait disparaître une ligne au lieu de faire
    // rougir la contrainte qui l'aurait laissée passer.
    weekday: record.weekday as IsoWeekday,
    startsAt: minutesToLocalTime(record.startMinute),
    endsAt: minutesToLocalTime(record.endMinute),
  };
}

/** Une plage de l'API, sous la forme que la base porte. */
function toRange(entry: StaffScheduleEntryView): ScheduleRange {
  return {
    weekday: entry.weekday,
    startMinute: localTimeToMinutes(entry.startsAt),
    endMinute: localTimeToMinutes(entry.endsAt),
  };
}

function toStoredRange(record: {
  weekday: number;
  startMinute: number;
  endMinute: number;
}): ScheduleRange {
  return {
    weekday: record.weekday as IsoWeekday,
    startMinute: record.startMinute,
    endMinute: record.endMinute,
  };
}

/** `09:00–12:00` — la plage telle qu'un message d'erreur la nomme. */
function describeRange(range: ScheduleRange): string {
  return `${minutesToLocalTime(range.startMinute)}–${minutesToLocalTime(range.endMinute)}`;
}
