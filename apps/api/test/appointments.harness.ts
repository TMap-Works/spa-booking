import type { INestApplication } from '@nestjs/common';

import { FakeAppointmentsRepository } from '../src/modules/appointments/__tests__/appointments.doubles';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import { AppointmentEvents } from '../src/modules/appointments/events/appointment-events';
import { FakeAvailabilityRepository } from '../src/modules/availability/__tests__/availability.doubles';
import { FakeStaffTimeOffRepository } from '../src/modules/availability/__tests__/staff-time-off.doubles';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { StaffTimeOffRepository } from '../src/modules/availability/staff-time-off.repository';
import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import { createTenantHarness, type TenantFixture, type TenantHarness } from './utils/tenant-harness';

/**
 * Amorçage du module `appointments` pour ses suites d'intégration et d'isolation
 * (#37).
 *
 * Une **spécialisation** du harnais partagé (`utils/tenant-harness.ts`, #27),
 * comme `catalog.harness.ts` et `availability.harness.ts` : deux établissements,
 * l'application réellement câblée par `configureApp`, et les slugs par lesquels
 * l'espace public les désigne.
 *
 * ## Quatre dépôts substitués, et aucun n'est superflu
 *
 * Réserver traverse trois modules, et chacun apporte le sien :
 *
 * | Dépôt | Ce qu'il sert |
 * |---|---|
 * | `AppointmentsRepository` | l'écriture du rendez-vous et la fiche cliente |
 * | `CatalogRepository` | la durée, les tampons et le prix de la prestation |
 * | `AvailabilityRepository` | les réglages du salon, les horaires, les affectations |
 * | `StaffTimeOffRepository` | les congés — vide ici, mais le service les lit |
 *
 * Chacun de ces doubles refuse de lire **sans portée de tenant** et filtre sur
 * elle, exactement comme l'extension Prisma : une garde qui n'ouvrirait pas la
 * portée, ou qui l'ouvrirait sur le mauvais établissement, fait rougir la suite
 * plutôt que de la laisser verdir pour la mauvaise raison.
 *
 * ## Le fuseau est `UTC`, délibérément
 *
 * Les deux établissements sont à l'heure UTC, là où `availability.harness.ts`
 * en prend deux différents. Ce n'est pas un relâchement : la conversion heure
 * murale ↔ instant a ses propres suites (#41, `dst-booking.spec.ts`), et la
 * rejouer ici obligerait chaque assertion de cette suite-ci à porter un décalage
 * saisonnier qui n'apprend rien sur la réservation. Ce qui est prouvé ici, c'est
 * qu'un créneau proposé se réserve, que sa durée occupée inclut les tampons, et
 * qu'un conflit sort en 409.
 *
 * ## L'horaire est posé sur la journée cible, calculée depuis « maintenant »
 *
 * `bookableSlot()` rend un créneau situé **quatorze jours plus tard**, et le
 * planning du praticien est posé sur le jour de la semaine correspondant. Une
 * date en dur aurait fait de cette suite une bombe à retardement : le préavis
 * minimum de réservation écarte tout créneau passé, et la suite serait devenue
 * rouge le jour où la date choisie serait derrière nous.
 */

/** Fuseau des deux établissements — voir l'en-tête. */
export const TENANT_TIMEZONE = 'UTC';

/** Pas de la grille de créneaux, en minutes — le défaut de la colonne. */
const SLOT_INTERVAL_MINUTES = 15;

/** Durée facturée de la prestation du harnais. */
export const SERVICE_DURATION_MINUTES = 60;

/** Préparation de la cabine — non facturée, mais occupée sur l'agenda. */
export const BUFFER_BEFORE_MINUTES = 10;

/** Remise en état — mêmes règles. */
export const BUFFER_AFTER_MINUTES = 10;

/** Prix de la prestation du harnais, en centimes. */
export const SERVICE_PRICE_MINOR = 7500;

/** Ouverture et fermeture du praticien, en minutes depuis minuit local. */
const WORKDAY_START_MINUTE = 9 * 60;
const WORKDAY_END_MINUTE = 18 * 60;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Ce qu'un établissement du harnais expose comme matière à réserver. */
export interface BookableTenant {
  readonly tenant: TenantFixture;
  readonly serviceId: string;
  readonly staffId: string;
}

export interface AppointmentsHarness {
  app: INestApplication;
  appointments: FakeAppointmentsRepository;
  catalog: FakeCatalogRepository;
  availability: FakeAvailabilityRepository;
  events: AppointmentEvents;
  /** L'établissement de l'appelant. */
  a: BookableTenant;
  /** L'établissement voisin, pour les scénarios de traversée. */
  b: BookableTenant;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

/**
 * Un créneau réellement proposable, quatorze jours plus tard.
 *
 * L'instant rendu est celui du **soin** — ce que le calendrier affiche et ce que
 * le corps de la requête porte. La grille se pose sur l'intervalle *occupé*,
 * ancrée à l'ouverture : `10:00` occupé donne `10:10` facturé, le tampon avant
 * valant dix minutes.
 */
export function bookableSlot(): { startsAt: Date; endsAt: Date; occupiedStartsAt: Date } {
  const day = new Date(Date.now() + 14 * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);

  const occupiedStartsAt = new Date(day.getTime() + 10 * 60 * MINUTE_MS);
  const startsAt = new Date(occupiedStartsAt.getTime() + BUFFER_BEFORE_MINUTES * MINUTE_MS);

  return {
    occupiedStartsAt,
    startsAt,
    endsAt: new Date(startsAt.getTime() + SERVICE_DURATION_MINUTES * MINUTE_MS),
  };
}

/** Le jour ISO de la semaine (1 = lundi) d'un instant lu en UTC. */
function isoWeekdayOf(instant: Date): number {
  return ((instant.getUTCDay() + 6) % 7) + 1;
}

export async function createAppointmentsHarness(): Promise<AppointmentsHarness> {
  const appointments = new FakeAppointmentsRepository();
  const catalog = new FakeCatalogRepository();
  const availability = new FakeAvailabilityRepository();
  const timeOff = new FakeStaffTimeOffRepository();

  const harness: TenantHarness = await createTenantHarness({
    overrides: [
      { provide: AppointmentsRepository, useValue: appointments },
      { provide: CatalogRepository, useValue: catalog },
      { provide: AvailabilityRepository, useValue: availability },
      { provide: StaffTimeOffRepository, useValue: timeOff },
    ],
  });

  const weekday = isoWeekdayOf(bookableSlot().startsAt);

  const equip = (tenant: TenantFixture): BookableTenant => {
    availability.seedTenant({
      id: tenant.id,
      timezone: TENANT_TIMEZONE,
      slotIntervalMinutes: SLOT_INTERVAL_MINUTES,
    });

    const service = catalog.seedService({
      tenantId: tenant.id,
      durationMinutes: SERVICE_DURATION_MINUTES,
      bufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
      bufferAfterMinutes: BUFFER_AFTER_MINUTES,
      priceAmountMinor: SERVICE_PRICE_MINOR,
    });

    // Le praticien n'est déclaré que du côté `availability` : la réservation ne
    // demande au catalogue que la durée, les tampons et le prix — jamais la
    // fiche du praticien, dont l'affectation se lit dans `service_staff`.
    const staff = availability.seedStaff({ tenantId: tenant.id });
    availability.seedServiceStaff({
      tenantId: tenant.id,
      serviceId: service.id,
      staffId: staff.id,
    });
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
    appointments,
    catalog,
    availability,
    events: harness.app.get(AppointmentEvents),
    a: equip(harness.a),
    b: equip(harness.b),
    server: () => harness.server(),
    close: () => harness.close(),
  };
}
