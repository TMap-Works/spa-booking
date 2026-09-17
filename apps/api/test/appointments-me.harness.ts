import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

import { FakeAppointmentsRepository } from '../src/modules/appointments/__tests__/appointments.doubles';
import { AppointmentsRepository } from '../src/modules/appointments/appointments.repository';
import { FakeAvailabilityRepository } from '../src/modules/availability/__tests__/availability.doubles';
import { FakeStaffTimeOffRepository } from '../src/modules/availability/__tests__/staff-time-off.doubles';
import { AvailabilityRepository } from '../src/modules/availability/availability.repository';
import { StaffTimeOffRepository } from '../src/modules/availability/staff-time-off.repository';
import { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { CatalogRepository } from '../src/modules/catalog/catalog.repository';
import type { UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { createTenantHarness, type TenantFixture, type TenantHarness } from './utils/tenant-harness';
import { inTenant } from './utils/tenant-scope';

/**
 * Amorçage de l'**espace praticien** — `GET /api/v1/me/*` (#811).
 *
 * Un harnais à part plutôt qu'une extension d'`appointments.harness.ts`, pour
 * une raison qui tient en une phrase : celui-là équipe un salon **réservable**,
 * celui-ci équipe un salon **doté de comptes praticiens**. Le lien
 * `(tenant_id, user_id)` de la table `staff` est précisément ce que rien ne
 * lisait avant ce ticket, et c'est lui que tout se joue ici — l'ajouter au
 * harnais de réservation aurait fait porter un compte à chaque praticien de
 * toutes les suites de #37 à #461, sans qu'aucune s'en serve.
 *
 * ## Ce qu'il pose, et pourquoi chaque pièce est nécessaire
 *
 * | Pièce | Ce qu'elle sert |
 * |---|---|
 * | deux établissements | la traversée : le praticien de B ne doit rien voir de A |
 * | **deux** praticiens dans A, chacun avec son compte | la traversée interne : un praticien ne doit rien voir de son collègue |
 * | un compte `MANAGER` **sans fiche** dans A | le 404 `STAFF_PROFILE_NOT_FOUND` du cinquième critère |
 * | des horaires, une absence, un jour de fermeture | les trois matières de `GET /me/schedule` |
 *
 * ## Les jetons portent un `userId` **choisi**, et c'est tout le propos
 *
 * `TenantHarness.tokenFor` signe avec un `userId` tiré au hasard : parfait pour
 * une route qui ne regarde que le rôle, inutilisable ici, où la réponse dépend
 * entièrement du compte. `bearerFor` signe donc le compte demandé, par le
 * **vrai** `TokenService` — la garde vérifie une signature, pas une convention
 * de test.
 *
 * ## Le fuseau est `UTC`, délibérément
 *
 * Comme `appointments.harness.ts` : la conversion heure murale ↔ instant a ses
 * propres suites (#41), et la rejouer ici obligerait chaque assertion à porter
 * un décalage saisonnier qui n'apprend rien sur la dérivation du praticien. Ce
 * qui est prouvé ici, c'est **qui** voit quoi.
 */

/** Fuseau des deux établissements — voir l'en-tête. */
export const TENANT_TIMEZONE = 'UTC';

/** Ouverture et fermeture du praticien, en minutes depuis minuit local. */
export const MORNING_START_MINUTE = 9 * 60;
export const MORNING_END_MINUTE = 12 * 60;
export const AFTERNOON_START_MINUTE = 14 * 60;
export const AFTERNOON_END_MINUTE = 18 * 60;

/** Le jour ISO sur lequel les deux plages de travail sont posées — mardi. */
export const WORKING_WEEKDAY = 2;

/** Le jour où le salon n'ouvre pour personne — dimanche. */
export const CLOSED_WEEKDAY = 7;

/** Durée et tampon de la prestation semée, en minutes. */
export const SERVICE_DURATION_MINUTES = 60;
export const BUFFER_BEFORE_MINUTES = 10;

/** Un praticien du harnais : sa fiche, et le compte auquel elle est rattachée. */
export interface StaffAccount {
  readonly staffId: string;
  readonly userId: string;
  readonly displayName: string;
}

/** Un établissement équipé pour l'espace praticien. */
export interface StaffedTenant {
  readonly tenant: TenantFixture;
  readonly serviceId: string;
  /** Le praticien dont les suites lisent l'agenda. */
  readonly staff: StaffAccount;
  /** Un second praticien du même salon — la traversée interne. */
  readonly colleague: StaffAccount;
  /** Un compte du salon **sans** fiche praticien — le 404 attendu. */
  readonly accountWithoutProfile: string;
}

export interface MyStaffHarness {
  readonly app: INestApplication;
  readonly appointments: FakeAppointmentsRepository;
  readonly availability: FakeAvailabilityRepository;
  readonly timeOff: FakeStaffTimeOffRepository;
  /** L'établissement de l'appelant. */
  readonly a: StaffedTenant;
  /** L'établissement voisin, pour les scénarios de traversée. */
  readonly b: StaffedTenant;
  /** Un `Authorization` signé pour ce compte, dans cet établissement. */
  bearerFor(userId: string, tenant: TenantFixture, role?: UserRole): Promise<string>;
  /** Pose une absence dans l'établissement, comme un jeu d'essai en base. */
  seedTimeOff(input: {
    tenant: TenantFixture;
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    reason?: string | null;
  }): Promise<{ id: string }>;
  server(): ReturnType<INestApplication['getHttpServer']>;
  close(): Promise<void>;
}

export async function createMyStaffHarness(): Promise<MyStaffHarness> {
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

  /**
   * Un praticien, sa semaine de travail, et le compte auquel il est rattaché.
   *
   * La fiche est semée des **deux** côtés : dans `availability`, qui sert les
   * horaires, et dans `appointments`, qui sert la dérivation depuis le compte.
   * Ce sont deux doubles d'une même table, et les laisser diverger ferait
   * répondre 404 à une route et 200 à l'autre pour le même praticien.
   */
  const equipStaff = (tenantId: string, displayName: string): StaffAccount => {
    const member = availability.seedStaff({ tenantId });
    const userId = randomUUID();

    for (const [startMinute, endMinute] of [
      [MORNING_START_MINUTE, MORNING_END_MINUTE],
      [AFTERNOON_START_MINUTE, AFTERNOON_END_MINUTE],
    ] as const) {
      availability.seedSchedule({
        tenantId,
        staffId: member.id,
        weekday: WORKING_WEEKDAY,
        startMinute,
        endMinute,
      });
    }

    appointments.seedStaffProfile({ tenantId, staffId: member.id, userId, displayName });
    timeOff.registerStaff(tenantId, member.id);

    return { staffId: member.id, userId, displayName };
  };

  const equip = (tenant: TenantFixture): StaffedTenant => {
    availability.seedTenant({ id: tenant.id, timezone: TENANT_TIMEZONE });

    // Le salon ferme le dimanche — une fois par établissement, jamais par
    // praticien : c'est un fait de l'établissement, et le semer dans la boucle
    // des praticiens en aurait posé autant de lignes que de fiches.
    availability.seedClosingDay({ tenantId: tenant.id, weekday: CLOSED_WEEKDAY });
    appointments.seedClosedWeekdays(tenant.id, [CLOSED_WEEKDAY]);

    const service = catalog.seedService({
      tenantId: tenant.id,
      durationMinutes: SERVICE_DURATION_MINUTES,
      bufferBeforeMinutes: BUFFER_BEFORE_MINUTES,
    });

    return {
      tenant,
      serviceId: service.id,
      staff: equipStaff(tenant.id, 'Camille'),
      colleague: equipStaff(tenant.id, 'Dominique'),
      // Un compte du salon qui n'a **aucune** fiche : jamais passé à
      // `seedStaffProfile`, donc introuvable par `findStaffByUserId`.
      accountWithoutProfile: randomUUID(),
    };
  };

  const tokens = harness.app.get(TokenService);

  return {
    app: harness.app,
    appointments,
    availability,
    timeOff,
    a: equip(harness.a),
    b: equip(harness.b),
    bearerFor: async (userId, tenant, role = 'STAFF') =>
      `Bearer ${await tokens.signAccessToken({ userId, tenantId: tenant.id, role })}`,
    seedTimeOff: async (input) =>
      // `inTenant` et non un appel nu : le double refuse toute écriture hors
      // portée, exactement comme l'extension Prisma. Voir `utils/tenant-scope.ts`.
      inTenant(input.tenant.id, () =>
        timeOff.create({
          staffId: input.staffId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason ?? null,
        }),
      ),
    server: () => harness.server(),
    close: () => harness.close(),
  };
}

/**
 * Le prochain `weekday` ISO demandé, à partir d'aujourd'hui — en UTC.
 *
 * Ancré sur minuit et calculé depuis « maintenant », jamais sur une date en
 * dur : une suite qui fige `2026-09-01` devient rouge le jour où cette date
 * passe, et la panne ne dit rien du code qu'elle gardait.
 */
export function nextWeekday(weekday: number, hourUtc = 10): Date {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);

  const current = ((day.getUTCDay() + 6) % 7) + 1;
  const ahead = (weekday - current + 7) % 7 || 7;

  return new Date(day.getTime() + (ahead * 24 + hourUtc) * 3_600_000);
}

/** La date civile d'un instant — les deux établissements sont à `UTC`. */
export function calendarDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * L'intervalle **occupé** d'un soin qui commence à `billedStart`.
 *
 * C'est ce que la base stocke : le tampon de cabine recule le début. La réponse,
 * elle, rend le soin — et c'est exactement l'écart que la suite vérifie.
 */
export function occupied(billedStart: Date): { startsAt: Date; endsAt: Date } {
  return {
    startsAt: new Date(billedStart.getTime() - BUFFER_BEFORE_MINUTES * 60_000),
    endsAt: new Date(billedStart.getTime() + SERVICE_DURATION_MINUTES * 60_000),
  };
}
