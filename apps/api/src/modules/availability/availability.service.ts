import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { ServicesService } from '../catalog/services.service';
import {
  AvailabilityRangeTooWideError,
  MAX_AVAILABILITY_RANGE_DAYS,
} from './availability.errors';
import { AvailabilityRepository } from './availability.repository';
import { calendarDaysBetween, eachCalendarDate } from './availability.schedule';
import { computeSlots, type SlotShape, type StaffFreeTime } from './availability.slots';
import type { AvailabilityView, DayAvailabilityView } from './availability.types';
import { StaffScheduleService } from './staff-schedule.service';
import { StaffTimeOffService } from './staff-time-off.service';
import { TenantClockService } from './tenant-clock.service';

/**
 * Calcul des créneaux libres — le cœur de la valeur perçue (CDC §2.3, #34).
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2).
 *
 * ## Rien n'est matérialisé, et c'est une contrainte du CDC
 *
 * Aucune table de créneaux, aucun pré-calcul nocturne : la réponse est produite
 * à la demande à partir de six lectures. Matérialiser voudrait dire recalculer
 * l'agenda entier à chaque changement d'horaire, de congé ou de rendez-vous —
 * et vivre avec la fenêtre pendant laquelle la table ment. Ce que l'on met en
 * cache, c'est le **résultat** de ce calcul, avec un TTL court et une
 * invalidation explicite : c'est l'objet de #35, et rien ici ne le préempte.
 *
 * ## Les six étapes, et où chacune vit
 *
 * | Étape (booking-engine §3) | Ce qui la fait |
 * |---|---|
 * | 1. praticiens candidats | `AvailabilityRepository.listServiceStaffIds` |
 * | 2. fenêtres de travail − fermetures | `StaffScheduleService.windowsForMany` (#32) |
 * | 3. − congés − rendez-vous occupants | `StaffTimeOffService.busyRanges` + `listBookedRanges` |
 * | 4-6. découpage, durée occupée, préavis | `availability.slots.ts` |
 * | regroupement par journée du salon | ce service |
 *
 * Ce service n'est donc pas l'algorithme : il en **assemble les entrées** et
 * regroupe la sortie. Le calcul lui-même est pur et se lit sans monter Nest.
 *
 * ## Où se joue l'isolation, et pourquoi rien ici ne la vérifie
 *
 * Aucune méthode ne reçoit ni ne compare de `tenantId`. Toutes les lectures
 * passent par des repositories dont le client Prisma est **scopé** par le
 * contexte de requête : un `serviceId` d'un autre établissement ne se trouve pas
 * (404), et un `staffId` d'ailleurs n'apparaît dans aucune liste de candidats,
 * donc ne produit aucun créneau. Il n'y a pas de `if` qui aurait eu à choisir
 * entre 403 et 404 (tenant-isolation §4).
 *
 * ## Ce que ce ticket ne pose pas
 *
 * Ni route — `GET /api/v1/availability` et son cache Redis appartiennent à #35 —
 * ni règle d'affectation du praticien lorsque la cliente n'en choisit pas : #36
 * la documentera, et ce service lui rend d'ici là **tous** les créneaux de tous
 * les candidats, ce qui est exactement la matière dont elle aura besoin.
 */
@Injectable()
export class AvailabilityService {
  public constructor(
    private readonly repository: AvailabilityRepository,
    private readonly schedules: StaffScheduleService,
    private readonly timeOff: StaffTimeOffService,
    private readonly services: ServicesService,
    private readonly clock: TenantClockService,
  ) {}

  /**
   * Les créneaux libres d'une prestation, journée du salon par journée du salon.
   *
   * `from` et `to` sont des **dates civiles de l'établissement**, bornes
   * comprises : c'est ce qu'affiche un calendrier, et le seul référentiel dans
   * lequel « la semaine du 3 mars » veut dire quelque chose.
   *
   * `staffId` restreint à un praticien. Un identifiant inconnu, désactivé, d'un
   * autre établissement, ou qui ne pratique pas cette prestation rend **une
   * réponse vide**, jamais une erreur : ces quatre cas doivent être
   * indiscernables, faute de quoi la page publique devient une sonde
   * d'existence. C'est aussi ce qu'exige booking-engine §6 — « un praticien qui
   * ne fait pas ce service n'est jamais proposé ».
   *
   * `now` est un paramètre plutôt qu'un `new Date()` enfoui : le filtrage du
   * passé et du préavis est un des sept critères de ce ticket, et un test qui
   * doit décaler l'horloge de la machine pour l'exercer ne s'écrit pas — il se
   * saute.
   *
   * @throws {NotFoundError} prestation inconnue, hors de l'établissement, ou
   * retirée du catalogue.
   * @throws {AvailabilityRangeTooWideError} plage inversée ou de plus de
   * `MAX_AVAILABILITY_RANGE_DAYS` jours.
   */
  public async slotsFor(
    query: { serviceId: string; staffId?: string; from: string; to: string },
    now: Date = new Date(),
  ): Promise<AvailabilityView> {
    const dates = requireServableRange(query.from, query.to);

    // Les deux lectures sont indépendantes : le fuseau ne dépend pas de la
    // prestation, et la prestation ne dépend pas du fuseau.
    const [settings, service] = await Promise.all([
      this.repository.currentBookingSettings(),
      this.services.byId(query.serviceId),
    ]);

    if (settings === null) {
      // `tenants.timezone` est `NOT NULL` : l'absence ne peut venir que d'un
      // établissement qui n'existe pas — un jeton signé sur une portée disparue,
      // ou un slug résolu puis supprimé. Le 404 est la seule réponse qui
      // n'apprenne rien.
      throw new NotFoundError('Établissement introuvable.');
    }

    if (!service.isActive) {
      // Une prestation retirée du catalogue n'est pas réservable, et le dire
      // autrement qu'en 404 la distinguerait d'une prestation qui n'existe pas.
      throw new NotFoundError('Prestation introuvable.');
    }

    const shape: SlotShape = {
      slotIntervalMinutes: settings.slotIntervalMinutes,
      serviceDurationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
    };

    const staffIds = await this.candidates(query.serviceId, query.staffId);

    if (staffIds.length === 0) {
      return { serviceId: query.serviceId, timezone: settings.timezone, days: emptyDays(dates) };
    }

    // La fenêtre d'occupation en instants : du premier minuit du salon au dernier.
    // Elle est plus large que la somme des fenêtres de travail, ce qui est voulu —
    // un congé posé la nuit doit être lu, même si personne ne travaille alors.
    const window = {
      from: this.clock.dayRange(query.from, settings.timezone).startsAt,
      to: this.clock.dayRange(query.to, settings.timezone).endsAt,
    };

    const [windowsByStaff, timeOff, booked] = await Promise.all([
      // Le fuseau est passé plutôt que relu : `currentBookingSettings` vient de
      // le rendre avec les deux réglages, sur la même ligne de `tenants`.
      this.schedules.windowsForMany(staffIds, query.from, query.to, settings.timezone),
      this.timeOff.busyRanges(staffIds, window),
      this.repository.listBookedRanges(staffIds, window),
    ]);

    // Congés et rendez-vous se soustraient de la même façon : ce sont deux
    // intervalles pendant lesquels le praticien n'est pas disponible, et le
    // moteur n'a aucune raison de savoir lequel il tient.
    const busyByStaff = groupByStaff([...timeOff, ...booked]);

    const staff: StaffFreeTime[] = staffIds.map((staffId) => ({
      staffId,
      windows: windowsByStaff.get(staffId) ?? [],
      busy: busyByStaff.get(staffId) ?? [],
    }));

    const slots = computeSlots({
      staff,
      shape,
      notBefore: new Date(now.getTime() + settings.minBookingNoticeMinutes * MINUTE_MS),
    });

    return {
      serviceId: query.serviceId,
      timezone: settings.timezone,
      days: this.groupByDay(slots, dates, settings.timezone),
    };
  }

  /**
   * Les praticiens à considérer — l'étape 1 de booking-engine §3.
   *
   * Sans `staffId`, tous ceux qui pratiquent la prestation. Avec, l'intersection
   * — donc au plus un, et zéro dès qu'il ne la pratique pas. L'intersection est
   * ce qui rend le critère « `first-available` ne propose jamais un praticien qui
   * ne fait pas ce service » vrai **aussi** quand la cliente en désigne un :
   * filtrer après coup aurait laissé le chemin explicite sans contrôle.
   */
  private async candidates(serviceId: string, staffId?: string): Promise<string[]> {
    const assigned = await this.repository.listServiceStaffIds(serviceId);

    if (staffId === undefined) {
      return assigned;
    }

    return assigned.filter((candidate) => candidate === staffId);
  }

  /**
   * Répartit les créneaux dans les journées civiles de l'établissement.
   *
   * Toutes les journées demandées figurent, y compris vides : c'est ce qui permet
   * au calendrier d'afficher « complet » sans deviner ses trous. La date d'un
   * créneau se lit dans le fuseau du salon, jamais dans celui du serveur — sans
   * quoi les créneaux du soir basculeraient au lendemain pour un salon à l'est de
   * Greenwich.
   */
  private groupByDay(
    slots: readonly { startsAt: Date; endsAt: Date; staffId: string }[],
    dates: readonly string[],
    timeZone: string,
  ): DayAvailabilityView[] {
    const byDate = new Map<string, { startsAt: string; endsAt: string; staffId: string }[]>(
      dates.map((date) => [date, []]),
    );

    for (const slot of slots) {
      const date = this.clock.calendarDateOf(slot.startsAt, timeZone);

      // Un créneau hors des dates demandées serait un défaut de calcul, pas une
      // donnée à ranger ailleurs : les fenêtres de travail sont construites date
      // par date sur cette même plage. Le `?.` l'ignore plutôt que de créer une
      // journée que l'appelant n'a pas demandée.
      byDate.get(date)?.push({
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
        staffId: slot.staffId,
      });
    }

    return dates.map((date) => ({ date, slots: byDate.get(date) ?? [] }));
  }
}

const MINUTE_MS = 60_000;

/**
 * Les dates civiles de la plage, ou le refus de la servir.
 *
 * Fonction de module et non méthode privée : c'est une règle pure, qui se teste
 * sans monter le service — même arbitrage que `requirePlausibleRange` pour les
 * absences. Elle rend les dates parce que l'appelant en a besoin juste après.
 *
 * La plage est **comptée avant d'être énumérée** : le refus est une protection
 * contre le déni de service décrit par `AvailabilityRangeTooWideError`, et
 * matérialiser d'abord les soixante-treize mille journées qu'on s'apprête à
 * refuser ferait payer exactement ce coût-là. `calendarDaysBetween` rend zéro ou
 * moins sur une plage inversée, ce qui distingue les deux refus sans avoir à
 * comparer les chaînes ici.
 *
 * Le pendant côté contrat est le double `refine` d'`availabilityQuerySchema`, et
 * la borne est la même des deux côtés.
 */
function requireServableRange(from: string, to: string): string[] {
  const days = calendarDaysBetween(from, to);

  if (days < 1 || days > MAX_AVAILABILITY_RANGE_DAYS) {
    throw new AvailabilityRangeTooWideError(from, to);
  }

  return eachCalendarDate(from, to);
}

/** Le calendrier demandé, sans un seul créneau — la réponse d'un agenda vide. */
function emptyDays(dates: readonly string[]): DayAvailabilityView[] {
  return dates.map((date) => ({ date, slots: [] }));
}

/** Regroupe des intervalles d'occupation par praticien, en une passe. */
function groupByStaff<T extends { staffId: string }>(ranges: readonly T[]): Map<string, T[]> {
  const byStaff = new Map<string, T[]>();

  for (const range of ranges) {
    const existing = byStaff.get(range.staffId) ?? [];
    existing.push(range);
    byStaff.set(range.staffId, existing);
  }

  return byStaff;
}
