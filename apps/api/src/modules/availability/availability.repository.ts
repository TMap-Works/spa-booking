import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
// Les statuts qui **occupent** l'agenda, importés et non redéclarés : c'est la
// liste du `WHERE` partiel de `appointments_no_overlap` (#31), et une suite de
// test la compare au SQL de la migration. Une seconde copie ici produirait
// exactement ce que ce témoin existe pour empêcher — un moteur qui masque un
// créneau que la base laisserait réserver, ou qui en propose un qu'elle refusera
// en 409. L'import traverse une frontière de module, mais pas celle
// qu'api-module §3 ferme : `appointment-status.ts` est un **vocabulaire** sans
// dépendance, ni repository ni service. Même précédent que
// `../identity/auth.decorator`, que trois contrôleurs de ce module importent.
import { OCCUPYING_STATUSES } from '../appointments/appointment-status';
import type { ScheduleRange } from './availability.schedule';
import type { StaffBusyRange, TimeOffWindow } from './staff-time-off.types';

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

/**
 * La même plage, mais **pour plusieurs praticiens à la fois** (#34).
 *
 * Le calcul de créneaux lit la semaine de travail de tous les candidats d'une
 * prestation en une requête : à raison d'une lecture par praticien, un service
 * pratiqué par six personnes coûterait six allers-retours pour une réponse que
 * #35 doit rendre sous 300 ms.
 */
export interface StaffScheduleRangeRecord extends StaffScheduleRecord {
  staffId: string;
}

/**
 * Les réglages de l'établissement dont dépend le calcul de créneaux.
 *
 * Le fuseau y figure avec les deux autres parce qu'ils se lisent sur la même
 * ligne : les demander séparément coûterait deux allers-retours pour deux
 * colonnes de la même table, sur le chemin le plus chaud de l'API.
 */
export interface TenantBookingSettingsRecord {
  timezone: string;
  slotIntervalMinutes: number;
  minBookingNoticeMinutes: number;
}

const SCHEDULE_SELECT = { weekday: true, startMinute: true, endMinute: true } as const;

const SCHEDULE_RANGE_SELECT = {
  staffId: true,
  weekday: true,
  startMinute: true,
  endMinute: true,
} as const;

const STAFF_SELECT = { id: true, isActive: true } as const;

const BOOKING_SETTINGS_SELECT = {
  timezone: true,
  slotIntervalMinutes: true,
  minBookingNoticeMinutes: true,
} as const;

/**
 * L'intervalle occupé par un rendez-vous, et rien de plus.
 *
 * Ni client, ni prestation, ni prix, ni notes : le moteur soustrait des
 * intervalles de l'agenda d'un praticien, il n'a aucune ligne à désigner ni
 * personne à nommer. La projection est la garantie — ce qui n'est pas lu ne peut
 * pas se retrouver dans une réponse publique, où ces créneaux manquants
 * aboutissent (même arbitrage que `BUSY_SELECT` des absences).
 */
const BOOKED_SELECT = { staffId: true, startsAt: true, endsAt: true } as const;

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

  /**
   * Fuseau, pas de créneau et délai minimum de l'établissement courant — `null`
   * s'il n'existe pas.
   *
   * Comme `currentTimeZone`, `Tenant` est scopé par l'extension **sur son `id`** :
   * cette lecture ne peut rendre que l'établissement de la requête, et il n'y a
   * aucun paramètre par lequel en désigner un autre.
   *
   * Elle ne remplace pas `currentTimeZone` et ne fait pas double emploi avec
   * elle : les horaires récurrents n'ont besoin que du fuseau, et leur faire
   * charger deux réglages qu'ils n'utilisent pas ferait passer la projection pour
   * un détail sans conséquence — c'est précisément l'habitude qui finit par
   * transporter une colonne interne jusqu'à une réponse publique.
   */
  public async currentBookingSettings(): Promise<TenantBookingSettingsRecord | null> {
    return this.prisma.tenant.findFirst({ select: BOOKING_SETTINGS_SELECT });
  }

  /** Un praticien de l'établissement courant — `null` hors de celui-ci. */
  public async findStaffById(id: string): Promise<StaffRecord | null> {
    return this.prisma.staff.findFirst({ where: { id }, select: STAFF_SELECT });
  }

  /**
   * Les praticiens **actifs** de l'établissement courant qui pratiquent cette
   * prestation — la première étape du moteur de créneaux (booking-engine §3).
   *
   * ## Pourquoi cette lecture est ici et non derrière un appel au catalogue
   *
   * `CatalogModule` n'exporte que `ServicesService`, dont la surface ne porte pas
   * l'affectation des praticiens ; `ServiceStaffService` reste privé, et le
   * rendre public relève du module qui le possède, pas de celui-ci. Un module
   * n'importe jamais le repository d'un autre (api-module §3) — et n'écrit pas
   * non plus dans le sien.
   *
   * Ce qui reste est une **lecture** de deux tables que ce module ne possède
   * pas, exactement comme `findStaffById` juste au-dessus lit `staff` sans en
   * être propriétaire : il ne les crée ni ne les modifie. Le jour où le catalogue
   * exposera « quels praticiens pratiquent cette prestation », cette lecture
   * deviendra l'appel de service correspondant, et rien d'autre ne bougera.
   *
   * ## Les praticiens désactivés sont écartés, contrairement au back-office
   *
   * `CatalogRepository.listServiceStaff` les garde délibérément — un écran
   * d'affectation doit montrer qu'une prestation reste rattachée à quelqu'un qui
   * ne prend plus de rendez-vous. Ici c'est l'inverse qui compte : proposer le
   * créneau d'un praticien désactivé produirait une réservation que personne
   * n'honorerait. C'est aussi ce que `StaffScheduleService` annonce en gardant
   * ses horaires intacts à la désactivation — « c'est le calcul de créneaux qui
   * écarte les praticiens inactifs ».
   *
   * L'ordre est stable — par identifiant : sans `orderBy`, PostgreSQL n'en
   * garantit aucun, et l'ordre des créneaux d'une même heure changerait d'un
   * rafraîchissement à l'autre.
   */
  public async listServiceStaffIds(serviceId: string): Promise<string[]> {
    const assignments = await this.prisma.serviceStaff.findMany({
      where: { serviceId, staff: { isActive: true } },
      select: { staffId: true },
      orderBy: [{ staffId: 'asc' }],
    });

    return assignments.map((assignment) => assignment.staffId);
  }

  /**
   * Les plages récurrentes de **plusieurs** praticiens, en une requête.
   *
   * `@@index([tenantId, staffId, weekday])` sert le filtre par son préfixe. Le
   * tri est stable pour la même raison que celui de `listStaffSchedule`, et
   * inclut `staffId` en tête : c'est ce qui rend le regroupement par praticien
   * lisible sans dépendre de l'ordre de la base.
   *
   * `staffIds` vide rend une liste vide **sans requête** : c'est le cas d'une
   * prestation qu'aucun praticien actif ne pratique, et un `IN ()` s'écrirait
   * `false` en SQL sans que ce soit lisible.
   */
  public async listSchedulesForStaff(
    staffIds: readonly string[],
  ): Promise<StaffScheduleRangeRecord[]> {
    if (staffIds.length === 0) {
      return [];
    }

    return this.prisma.staffSchedule.findMany({
      where: { staffId: { in: [...staffIds] } },
      select: SCHEDULE_RANGE_SELECT,
      orderBy: [{ staffId: 'asc' }, { weekday: 'asc' }, { startMinute: 'asc' }],
    });
  }

  /**
   * Les rendez-vous qui **occupent** l'agenda de ces praticiens sur la fenêtre —
   * l'étape 3 du moteur de créneaux.
   *
   * ## Lire les rendez-vous n'est pas s'en remettre à cette lecture
   *
   * Elle sert à *proposer*, ce qui est une question d'affichage ; elle ne garantit
   * rien. Entre le moment où ce `SELECT` s'exécute et celui où la cliente valide,
   * une autre transaction peut insérer — et aucune relecture ne rattrape cela. La
   * garantie est la contrainte d'exclusion `appointments_no_overlap`, et elle
   * seule (ADR 0002, booking-engine §1). C'est exactement ce que
   * `AppointmentsRepository` annonce de son côté : « le moteur de disponibilité
   * lira bien les rendez-vous existants — pour proposer des créneaux ».
   *
   * ## Pourquoi la lecture est ici plutôt que dans `appointments`
   *
   * Ce module ne peut pas importer `AppointmentsRepository` : un module
   * n'importe jamais le repository d'un autre (api-module §3), et celui-là
   * documente d'ailleurs son propre export comme transitoire, en attendant le
   * service que #37 posera. Même arbitrage que pour `staff` et `service_staff` :
   * une **lecture** d'une table qu'on ne possède pas, à projection réduite, qui
   * deviendra un appel de service le jour où il y en aura un.
   *
   * Le prédicat est le **recoupement** — `startsAt < to AND endsAt > from` — et
   * non l'inclusion : un rendez-vous commencé avant la fenêtre et courant encore
   * occupe bien le praticien pendant celle-ci. Le retenir sur son seul début
   * proposerait un créneau déjà pris.
   *
   * `@@index([tenantId, staffId, startsAt])` sert cette lecture.
   *
   * ## `excludeAppointmentId` — le rendez-vous que le report est en train de déplacer (#316)
   *
   * Un report soumet son créneau d'arrivée au même contrôle qu'une réservation :
   * le moteur doit l'avoir proposé. Or le rendez-vous **en cours de déplacement**
   * occupe encore son créneau — il l'occupe, tant que la transaction n'a pas eu
   * lieu. Sans ce paramètre, avancer d'un quart d'heure un soin d'une heure
   * demande un créneau que le calcul ne propose pas, et le geste le plus courant
   * du comptoir reçoit un 409.
   *
   * Ce que ce paramètre ne fait **pas**, et c'est le seul point qui compte :
   * relâcher quoi que ce soit de l'unicité. Il n'agit que sur la lecture qui sert
   * à *proposer*, laquelle ne garantissait déjà rien (voir ci-dessus).
   * L'insertion du report reste jugée par `appointments_no_overlap`, dans la même
   * transaction qui annule la ligne de départ — et c'est cette annulation, pas ce
   * paramètre, qui sort la ligne de l'index partiel avant que la nouvelle ne soit
   * jugée. Deux reports concurrents vers des créneaux chevauchants continuent
   * donc de n'en voir aboutir qu'un, et le test de concurrence le vérifie.
   *
   * ## Un identifiant d'un autre établissement est sans effet, jamais une fuite
   *
   * Le `where` entier est scopé par l'extension : `id: { not: … }` ne peut que
   * **retirer** une ligne d'un ensemble déjà borné à l'établissement courant.
   * L'identifiant d'un rendez-vous voisin n'y désigne rien, la lecture rend
   * exactement ce qu'elle aurait rendu sans lui, et rien de ce voisin n'entre
   * dans le résultat — il n'y a ni chemin de lecture, ni différence observable
   * qui ferait de ce paramètre une sonde d'existence (tenant-isolation §4).
   */
  public async listBookedRanges(
    staffIds: readonly string[],
    window: TimeOffWindow,
    excludeAppointmentId?: string,
  ): Promise<StaffBusyRange[]> {
    if (staffIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.appointment.findMany({
      where: {
        staffId: { in: [...staffIds] },
        status: { in: [...OCCUPYING_STATUSES] },
        startsAt: { lt: window.to },
        endsAt: { gt: window.from },
        // Étalé plutôt que posé à `undefined` : Prisma traite bien un `id`
        // absent et un `id: undefined` de la même façon, mais l'écrire ainsi
        // rend le cas « aucune exclusion » lisible sans avoir à le savoir.
        ...(excludeAppointmentId === undefined ? {} : { id: { not: excludeAppointmentId } }),
      },
      select: BOOKED_SELECT,
      orderBy: [{ startsAt: 'asc' }],
    });

    return rows.map((row) => ({
      staffId: row.staffId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    }));
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
