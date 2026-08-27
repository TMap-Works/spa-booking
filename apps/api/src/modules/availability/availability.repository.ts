import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type { ScheduleRange } from './availability.schedule';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une seule requête
 * d'ici ait à le répéter — donc sans qu'aucune puisse l'oublier. Le module n'a
 * **aucune** dérogation : rien ici n'est légitimement inter-tenant, et
 * `prismaUnscoped` n'y est donc pas injecté du tout. C'est plus sûr qu'un client
 * disponible dont on se promet de ne pas se servir.
 *
 * ## Ce que ce dépôt ne stocke jamais
 *
 * Aucun instant, et aucun décalage. Les plages de travail sont des **minutes
 * depuis minuit local** ; leur conversion en instants UTC se fait à la lecture,
 * date par date, dans `StaffScheduleService`. Une colonne `timestamptz` ici
 * aurait figé l'offset du jour de la saisie, et décalé l'agenda à chaque
 * changement d'heure — CDC §6, sévérité haute.
 */

/** Une plage récurrente, telle que la base la porte. */
export interface StaffScheduleRecord {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * La fiche praticien, réduite à ce que ce module a besoin d'en savoir.
 *
 * Le module `availability` lit la table `staff` sans en être propriétaire : il
 * ne la crée ni ne la modifie, il vérifie seulement qu'un identifiant reçu
 * désigne un praticien **d'ici** avant d'écrire ses horaires. Même arbitrage —
 * et même commentaire — que `CatalogRepository.findStaffById` : le jour où un
 * module prendra la fiche praticien, cette lecture deviendra l'appel de service
 * correspondant.
 */
export interface StaffRecord {
  id: string;
  isActive: boolean;
}

const SCHEDULE_SELECT = { weekday: true, startMinute: true, endMinute: true } as const;

const STAFF_SELECT = { id: true, isActive: true } as const;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que `catalog.repository.ts` : le type
 * généré par Prisma exige `tenantId` — la colonne est `NOT NULL` — alors que le
 * repository ne doit justement pas le fournir. C'est l'extension qui le pose
 * depuis le contexte de requête, et qui écrase ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

@Injectable()
export class AvailabilityRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Le fuseau de l'établissement courant — `null` s'il n'existe pas.
   *
   * `Tenant` est scopé par l'extension **sur son `id`** : cette lecture ne peut
   * rendre que l'établissement de la requête, et il n'y a aucun paramètre par
   * lequel en désigner un autre.
   */
  public async currentTimeZone(): Promise<string | null> {
    const tenant = await this.prisma.tenant.findFirst({ select: { timezone: true } });

    return tenant?.timezone ?? null;
  }

  /** Un praticien de l'établissement courant — `null` hors de celui-ci. */
  public async findStaffById(id: string): Promise<StaffRecord | null> {
    return this.prisma.staff.findFirst({ where: { id }, select: STAFF_SELECT });
  }

  /**
   * Les plages récurrentes d'un praticien de l'établissement courant.
   *
   * `@@index([tenantId, staffId, weekday])` sert cette lecture, et le tri l'est
   * aussi par son préfixe. L'ordre est **stable** — sans `orderBy`, PostgreSQL
   * n'en garantit aucun, et l'écran de saisie changerait d'ordre d'un
   * rafraîchissement à l'autre.
   */
  public async listStaffSchedule(staffId: string): Promise<StaffScheduleRecord[]> {
    return this.prisma.staffSchedule.findMany({
      where: { staffId },
      select: SCHEDULE_SELECT,
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
  }

  /**
   * Remplace **intégralement** la semaine de travail d'un praticien.
   *
   * Le retrait et l'écriture sont dans une seule transaction : sans elle, un
   * incident entre les deux laisserait le praticien sans aucun horaire, donc
   * invisible de tout le calendrier public, jusqu'à ce que quelqu'un s'en
   * aperçoive. La transaction est **interactive** parce que c'est la seule forme
   * où l'extension de scoping s'applique aux opérations imbriquées : chaque
   * requête du bloc reste bornée à l'établissement courant.
   *
   * Un remplacement plutôt qu'un CRUD plage par plage : la seule invariante qui
   * compte — aucune plage ne se recouvre — porte sur l'ensemble, et la vérifier
   * à chaque ajout ferait dépendre le résultat de l'ordre des appels.
   */
  public async replaceStaffSchedule(
    staffId: string,
    ranges: readonly ScheduleRange[],
  ): Promise<StaffScheduleRecord[]> {
    await this.prisma.$transaction(async (tx) => {
      await tx.staffSchedule.deleteMany({ where: { staffId } });

      if (ranges.length === 0) {
        return;
      }

      await tx.staffSchedule.createMany({
        data: ranges.map((range) =>
          withScopedTenant<Prisma.StaffScheduleUncheckedCreateInput>({
            staffId,
            weekday: range.weekday,
            startMinute: range.startMinute,
            endMinute: range.endMinute,
          }),
        ),
      });
    });

    return this.listStaffSchedule(staffId);
  }

  /** Les jours de fermeture récurrents de l'établissement courant, croissants. */
  public async listClosedWeekdays(): Promise<number[]> {
    const days = await this.prisma.tenantClosingDay.findMany({
      select: { weekday: true },
      orderBy: [{ weekday: 'asc' }],
    });

    return days.map((day) => day.weekday);
  }

  /**
   * Remplace intégralement les jours de fermeture — même arbitrage, et même
   * transaction, que `replaceStaffSchedule`.
   *
   * Le `deleteMany` sans `where` n'est pas un balayage global : l'extension y
   * ajoute `tenant_id`, et une opération sans contexte de tenant est refusée
   * plutôt que ramenée à « toutes les lignes » (tenant-isolation §3).
   */
  public async replaceClosedWeekdays(weekdays: readonly number[]): Promise<number[]> {
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantClosingDay.deleteMany({});

      if (weekdays.length === 0) {
        return;
      }

      await tx.tenantClosingDay.createMany({
        data: weekdays.map((weekday) =>
          withScopedTenant<Prisma.TenantClosingDayUncheckedCreateInput>({ weekday }),
        ),
      });
    });

    return this.listClosedWeekdays();
  }
}
