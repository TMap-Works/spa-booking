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
import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
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
  /**
   * La cliente du salon — celle **pour qui** le tunnel réserve depuis #1136.
   *
   * Réserver exige un compte : il n'y a plus de fiche créée au passage depuis
   * des coordonnées, et une suite qui ne sèmerait pas cette fiche-là
   * exercerait le 404 de cliente inconnue au lieu du cas passant. Elle est
   * semée d'office, comme le praticien et la prestation, parce qu'elle est
   * devenue une condition de la même façon qu'eux.
   */
  readonly clientId: string;
  /**
   * L'adresse de cette fiche — la seule coordonnée que les suites aient à
   * nommer depuis #1222.
   *
   * Elle est exposée parce que deux propriétés se disent en la citant, et
   * qu'aucune ne se dit plus en citant une adresse écrite dans le corps de la
   * demande : que le flux temps réel ne transporte **pas** les coordonnées de
   * la cliente, et qu'un homonyme au fichier du salon voisin ne pèse sur rien
   * ici. Une suite qui inventerait son adresse à elle ne prouverait ni l'une ni
   * l'autre — elle chercherait une chaîne qui n'existe nulle part.
   */
  readonly clientEmail: string;
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
  /**
   * Un **second** praticien pour cet établissement, affecté à la même
   * prestation et sur le même horaire.
   *
   * Le report peut changer de praticien en chemin (#39) : sans un second
   * candidat, ce chemin ne s'exerce pas. Il n'est pas semé d'office — les suites
   * de réservation raisonnent sur un praticien, et un second ferait apparaître
   * des créneaux qu'elles ne comptent pas.
   */
  addStaff(target: BookableTenant): string;
  /**
   * Un en-tête `Authorization` signé par le **vrai** `TokenService`, pour un
   * compte de cet établissement (#1136).
   *
   * Signé plutôt que fabriqué : c'est la seule façon d'exercer `JwtAuthGuard`
   * pour ce qu'il fait — lire le `tenantId` d'un jeton *vérifié* et le poser
   * dans le contexte de requête —, et donc la seule façon de prouver qu'un
   * jeton du salon voisin ne passe pas sous ce slug-ci.
   *
   * Sans `userId`, le jeton désigne la cliente du salon (`target.clientId`) :
   * c'est le cas dominant depuis que réserver, annuler et reporter l'exigent.
   */
  bearer(target: BookableTenant, role?: UserRole, userId?: string): Promise<string>;
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
 *
 * `occupiedHourUtc` désigne l'heure **occupée** du créneau voulu, dans la
 * journée de travail du praticien (9 h – 18 h). Le paramètre existe pour le
 * report (#39), qui a besoin de deux créneaux du même jour : celui d'où l'on
 * part et celui où l'on va. Toute heure pleine de la fenêtre tombe sur la
 * grille de quinze minutes, et laisse tenir les quatre-vingts minutes occupées.
 */
export function bookableSlot(occupiedHourUtc = 10): {
  startsAt: Date;
  endsAt: Date;
  occupiedStartsAt: Date;
} {
  const day = new Date(Date.now() + 14 * DAY_MS);
  day.setUTCHours(0, 0, 0, 0);

  const occupiedStartsAt = new Date(day.getTime() + occupiedHourUtc * 60 * MINUTE_MS);
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

  /**
   * Un praticien affecté à cette prestation, ouvert sur la journée cible.
   *
   * Le praticien n'est déclaré que du côté `availability` : la réservation ne
   * demande au catalogue que la durée, les tampons et le prix — jamais la fiche
   * du praticien, dont l'affectation se lit dans `service_staff`.
   */
  const equipStaff = (tenantId: string, serviceId: string): string => {
    const staff = availability.seedStaff({ tenantId });
    availability.seedServiceStaff({ tenantId, serviceId, staffId: staff.id });
    availability.seedSchedule({
      tenantId,
      staffId: staff.id,
      weekday,
      startMinute: WORKDAY_START_MINUTE,
      endMinute: WORKDAY_END_MINUTE,
    });
    timeOff.registerStaff(tenantId, staff.id);
    return staff.id;
  };

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

    // La cliente du salon (#1136) — une fiche `CLIENT` au fichier, celle que le
    // jeton du tunnel désigne. L'adresse porte le slug pour rester unique d'un
    // établissement à l'autre : la clé du fichier client est `(tenant, e-mail)`.
    const client = appointments.seedClient({
      tenantId: tenant.id,
      email: `cliente@${tenant.slug}.test`,
      firstName: 'Camille',
      lastName: 'Rakoto',
      phone: '+261341234567',
    });

    return {
      tenant,
      serviceId: service.id,
      staffId: equipStaff(tenant.id, service.id),
      clientId: client.id,
      clientEmail: client.email,
    };
  };

  const tokens = harness.app.get(TokenService);

  return {
    app: harness.app,
    appointments,
    catalog,
    availability,
    events: harness.app.get(AppointmentEvents),
    a: equip(harness.a),
    b: equip(harness.b),
    addStaff: (target: BookableTenant) => equipStaff(target.tenant.id, target.serviceId),
    bearer: async (target: BookableTenant, role: UserRole = 'CLIENT', userId?: string) =>
      `Bearer ${await tokens.signAccessToken({
        userId: userId ?? target.clientId,
        tenantId: target.tenant.id,
        role,
      })}`,
    server: () => harness.server(),
    close: () => harness.close(),
  };
}
