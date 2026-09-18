import { Inject, Injectable } from '@nestjs/common';
import type { PlatformTenantEventKind as PrismaEventKind } from '@prisma/client';
import { TENANT_BILLING_STATUSES, type PlatformTenantEventKind, type TenantBillingStatus } from '@spa/shared';

import {
  PRISMA_UNSCOPED,
  type UnscopedPrismaClient,
} from '../../../infrastructure/database/prisma-clients';
import { TENANT_SUMMARY_SELECT, tenantOrigin, toTenantSummary } from './platform.repository';
import type {
  OverviewCounts,
  TenantAccountRecord,
  TenantActivityRecord,
  TenantDetailRecord,
  TenantEventRecord,
  TenantSetupRecord,
} from './platform.types';

/**
 * Ce que la console lit **sur** les salons, et ce qu'elle y note — le tableau de
 * bord de l'éditeur et la fiche salon.
 *
 * ## Pourquoi le client non scopé, et ce qu'il est permis d'en lire
 *
 * Même dérogation que `PlatformRepository`, et pour la même raison : une requête
 * de console n'a pas d'établissement courant (`PlatformAuthGuard` n'en pose
 * aucun). Les trois obligations de `prisma-clients.ts` sont tenues — le champ se
 * nomme `prismaUnscoped`, ce commentaire dit pourquoi, et **chaque requête qui
 * vise une table de salon porte son filtre `tenantId` écrit à la main**.
 *
 * Ce qui en sort est borné par l'ADR 0012 et par le registre des traitements
 * (l'éditeur est sous-traitant des salons) :
 *
 * - des **nombres** — rendez-vous, prestations, comptes clients —, jamais une
 *   ligne d'agenda, une fiche cliente ni un montant encaissé par un salon ;
 * - les comptes **internes** d'un salon (gérants, praticiens), parce que c'est
 *   à eux que l'éditeur a affaire quand un salon l'appelle ;
 * - les tables de l'espace plateforme, qui n'appartiennent à aucun salon.
 */

/** « Prénom N. » — ce que l'historique dit de l'opérateur. */
function operatorName(operator: { firstName: string; lastName: string }): string {
  return `${operator.firstName} ${operator.lastName.slice(0, 1)}.`;
}

/** La casse du contrat : `INVITATION_REISSUED` devient `invitation_reissued`. */
function toEventKind(kind: PrismaEventKind): PlatformTenantEventKind {
  return kind.toLowerCase() as PlatformTenantEventKind;
}

/** Les rôles internes, dans la casse du schéma — les clientes n'en font pas partie. */
const INTERNAL_ROLES = ['STAFF', 'MANAGER', 'ADMIN'] as const;

/** Le nombre de lignes d'historique qu'une fiche affiche. */
export const TENANT_EVENTS_LIMIT = 50;

@Injectable()
export class PlatformConsoleRepository {
  public constructor(
    // Dérogation au scoping, argumentée dans l'en-tête de ce fichier.
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /**
   * Tout ce que la vue d'ensemble compte, en une transaction de lecture.
   *
   * L'entonnoir d'activation ne compte **pas** les salons `pending` : une
   * inscription dont le paiement n'a pas abouti n'est pas un salon ouvert, et
   * la compter ferait baisser tous les taux d'une population qui n'a jamais eu
   * accès au produit (ADR 0016).
   */
  public async overviewCounts(input: {
    readonly now: Date;
    readonly trialHorizon: Date;
    readonly openingsSince: Date;
    readonly activitySince: Date;
  }): Promise<OverviewCounts> {
    const opened = { billingStatus: { not: 'PENDING' } } as const;

    const [
      byStatus,
      total,
      suspended,
      trialsEndingSoon,
      openings,
      configured,
      booked,
      activeLast30Days,
      recent,
    ] = await this.prismaUnscoped.$transaction([
      this.prismaUnscoped.tenant.groupBy({
        by: ['billingStatus'],
        orderBy: { billingStatus: 'asc' },
        _count: { _all: true },
      }),
      this.prismaUnscoped.tenant.count(),
      this.prismaUnscoped.tenant.count({ where: { isActive: false } }),
      this.prismaUnscoped.tenant.findMany({
        where: {
          billingStatus: 'TRIALING',
          trialEndsAt: { gte: input.now, lt: input.trialHorizon },
        },
        select: TENANT_SUMMARY_SELECT,
        orderBy: [{ trialEndsAt: 'asc' }, { id: 'asc' }],
        take: 20,
      }),
      this.prismaUnscoped.tenant.findMany({
        where: { createdAt: { gte: input.openingsSince } },
        select: {
          createdAt: true,
          billingStatus: true,
          _count: { select: { platformProvisionings: true } },
        },
      }),
      this.prismaUnscoped.tenant.count({
        where: {
          ...opened,
          services: { some: { isActive: true } },
          staff: { some: { isActive: true } },
        },
      }),
      this.prismaUnscoped.tenant.count({ where: { ...opened, appointments: { some: {} } } }),
      this.prismaUnscoped.tenant.count({
        where: { ...opened, appointments: { some: { createdAt: { gte: input.activitySince } } } },
      }),
      this.prismaUnscoped.tenant.findMany({
        select: TENANT_SUMMARY_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      }),
    ]);

    const byBillingStatus = Object.fromEntries(
      TENANT_BILLING_STATUSES.map((status) => [status, 0]),
    ) as Record<TenantBillingStatus, number>;
    for (const row of byStatus) {
      const count = row._count;
      byBillingStatus[row.billingStatus.toLowerCase() as TenantBillingStatus] =
        typeof count === 'object' ? (count._all ?? 0) : 0;
    }

    return {
      total,
      suspended,
      byBillingStatus,
      trialsEndingSoon: trialsEndingSoon.map(toTenantSummary),
      recentOpenings: openings.map((row) => ({
        createdAt: row.createdAt,
        origin: tenantOrigin(row),
      })),
      activation: {
        opened: total - byBillingStatus.pending,
        configured,
        booked,
        activeLast30Days,
      },
      recent: recent.map(toTenantSummary),
    };
  }

  /** La fiche d'un salon — coordonnées, identité, facturation. `null` s'il n'existe pas. */
  public async findTenantDetail(id: string): Promise<TenantDetailRecord | null> {
    const row = await this.prismaUnscoped.tenant.findUnique({
      where: { id },
      select: {
        ...TENANT_SUMMARY_SELECT,
        contactEmail: true,
        contactPhone: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        countryCode: true,
        legalName: true,
        legalId: true,
        currentPeriodEndsAt: true,
        stripeCustomerId: true,
      },
    });

    if (row === null) {
      return null;
    }

    return {
      summary: toTenantSummary(row),
      contactEmail: row.contactEmail,
      contactPhone: row.contactPhone,
      // La base garantit que les trois sont nuls ensemble ou renseignés
      // ensemble (`tenants_address_completeness_check`).
      address:
        row.addressLine1 === null || row.city === null || row.countryCode === null
          ? null
          : {
              line1: row.addressLine1,
              line2: row.addressLine2,
              postalCode: row.postalCode,
              city: row.city,
              country: row.countryCode,
            },
      legalName: row.legalName,
      hasLegalId: row.legalId !== null,
      currentPeriodEndsAt: row.currentPeriodEndsAt,
      stripeCustomerId: row.stripeCustomerId,
    };
  }

  /**
   * Les comptes **internes** d'un salon, administrateurs d'abord.
   *
   * L'empreinte du mot de passe est lue pour une seule raison — dire si
   * l'invitation a été acceptée — et convertie ici en booléen : elle ne quitte
   * pas ce dépôt.
   */
  public async listInternalAccounts(tenantId: string): Promise<TenantAccountRecord[]> {
    const rows = await this.prismaUnscoped.user.findMany({
      where: { tenantId, role: { in: [...INTERNAL_ROLES] }, anonymizedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isActive: true,
        passwordHash: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      role: row.role.toLowerCase() as TenantAccountRecord['role'],
      isActive: row.isActive,
      activated: row.passwordHash !== null,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    }));
  }

  /** Le nombre de comptes clients d'un salon — un nombre, jamais une liste. */
  public async countClients(tenantId: string): Promise<number> {
    return this.prismaUnscoped.user.count({
      where: { tenantId, role: 'CLIENT', anonymizedAt: null },
    });
  }

  /** Où en est la mise en route d'un salon. */
  public async setup(tenantId: string): Promise<TenantSetupRecord> {
    const [openingHours, activeServices, activeStaff, staffWithSchedule, first] =
      await this.prismaUnscoped.$transaction([
        this.prismaUnscoped.tenantOpeningHour.count({ where: { tenantId } }),
        this.prismaUnscoped.service.count({ where: { tenantId, isActive: true } }),
        this.prismaUnscoped.staff.count({ where: { tenantId, isActive: true } }),
        this.prismaUnscoped.staff.count({
          where: { tenantId, isActive: true, schedules: { some: {} } },
        }),
        this.prismaUnscoped.appointment.findFirst({
          where: { tenantId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { createdAt: true },
        }),
      ]);

    return {
      openingHours: openingHours > 0,
      activeServices,
      activeStaff,
      staffWithSchedule,
      firstAppointmentAt: first?.createdAt ?? null,
    };
  }

  /**
   * Trente jours d'activité, **en nombres**.
   *
   * Honorés et non honorés se comptent sur l'heure du rendez-vous — ce qui a
   * eu lieu dans la fenêtre —, les annulations sur l'instant d'annulation, les
   * réservations sur l'instant où elles ont été prises.
   */
  public async activity(input: {
    readonly tenantId: string;
    readonly now: Date;
    readonly since: Date;
  }): Promise<TenantActivityRecord> {
    const { tenantId, now, since } = input;
    const past = { gte: since, lt: now };

    const [created, upcoming, completed, noShow, cancelled, last] =
      await this.prismaUnscoped.$transaction([
        this.prismaUnscoped.appointment.count({ where: { tenantId, createdAt: { gte: since } } }),
        this.prismaUnscoped.appointment.count({
          where: { tenantId, startsAt: { gte: now }, status: { in: ['PENDING', 'CONFIRMED'] } },
        }),
        this.prismaUnscoped.appointment.count({
          where: { tenantId, status: 'COMPLETED', startsAt: past },
        }),
        this.prismaUnscoped.appointment.count({
          where: { tenantId, status: 'NO_SHOW', startsAt: past },
        }),
        this.prismaUnscoped.appointment.count({
          where: { tenantId, status: 'CANCELLED', cancelledAt: { gte: since } },
        }),
        this.prismaUnscoped.appointment.findFirst({
          where: { tenantId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true },
        }),
      ]);

    return {
      createdLast30Days: created,
      upcoming,
      completedLast30Days: completed,
      noShowLast30Days: noShow,
      cancelledLast30Days: cancelled,
      lastBookingAt: last?.createdAt ?? null,
    };
  }

  /**
   * L'historique d'un salon, le plus récent d'abord — les lignes de la console,
   * puis l'ouverture depuis la console, qui est toujours la plus ancienne.
   */
  public async listEvents(tenantId: string): Promise<TenantEventRecord[]> {
    const [events, provisioning] = await this.prismaUnscoped.$transaction([
      this.prismaUnscoped.platformTenantEvent.findMany({
        where: { subjectTenantId: tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: TENANT_EVENTS_LIMIT,
        select: {
          id: true,
          kind: true,
          body: true,
          createdAt: true,
          operator: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prismaUnscoped.platformTenantProvisioning.findFirst({
        where: { createdTenantId: tenantId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          createdAt: true,
          operator: { select: { firstName: true, lastName: true } },
        },
      }),
    ]);

    const lines: TenantEventRecord[] = events.map((event) => ({
      id: event.id,
      kind: toEventKind(event.kind),
      body: event.body,
      operatorName: operatorName(event.operator),
      createdAt: event.createdAt,
    }));

    if (provisioning !== null) {
      lines.push({
        id: `ouverture-${provisioning.id}`,
        kind: 'provisioned',
        body: null,
        operatorName: operatorName(provisioning.operator),
        createdAt: provisioning.createdAt,
      });
    }

    return lines;
  }

  /** Inscrit une ligne d'historique — note ou réinvitation. */
  public async recordEvent(input: {
    readonly tenantId: string;
    readonly operatorId: string;
    readonly kind: 'NOTE' | 'INVITATION_REISSUED';
    readonly body: string | null;
  }): Promise<TenantEventRecord> {
    const event = await this.prismaUnscoped.platformTenantEvent.create({
      data: {
        subjectTenantId: input.tenantId,
        operatorId: input.operatorId,
        kind: input.kind,
        body: input.body,
      },
      select: {
        id: true,
        kind: true,
        body: true,
        createdAt: true,
        operator: { select: { firstName: true, lastName: true } },
      },
    });

    return {
      id: event.id,
      kind: toEventKind(event.kind),
      body: event.body,
      operatorName: operatorName(event.operator),
      createdAt: event.createdAt,
    };
  }

  /**
   * Suspend ou réactive un salon — **en une transaction** avec sa ligne
   * d'historique et, à la suspension, la révocation de ses sessions.
   *
   * ## La bascule est conditionnelle, et c'est ce qui la rend sûre
   *
   * `updateMany` filtre sur l'état **inverse** de celui qu'on demande : deux
   * suspensions concurrentes ne peuvent pas passer toutes les deux, et la
   * seconde ne réécrit ni l'état ni l'historique. `changed: false` le dit.
   *
   * ## Ce que la suspension coupe
   *
   * - le slug ne se résout plus : vitrine, réservation et connexion répondent
   *   comme pour un salon inexistant (`findTenantIdBySlug`) ;
   * - toutes les sessions ouvertes du salon sont révoquées — plus aucun jeton
   *   de rafraîchissement ne se renouvelle. Un jeton d'accès déjà émis vit
   *   encore au plus sa durée (quinze minutes).
   *
   * `null` si le salon n'existe pas.
   */
  public async setTenantActive(input: {
    readonly tenantId: string;
    readonly operatorId: string;
    readonly isActive: boolean;
    readonly reason: string;
    readonly now: Date;
  }): Promise<{ changed: boolean; revokedSessions: number } | null> {
    return this.prismaUnscoped.$transaction(async (tx) => {
      const flipped = await tx.tenant.updateMany({
        where: { id: input.tenantId, isActive: !input.isActive },
        data: { isActive: input.isActive },
      });

      if (flipped.count === 0) {
        const exists = await tx.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true },
        });
        return exists === null ? null : { changed: false, revokedSessions: 0 };
      }

      await tx.platformTenantEvent.create({
        data: {
          subjectTenantId: input.tenantId,
          operatorId: input.operatorId,
          kind: input.isActive ? 'REACTIVATED' : 'SUSPENDED',
          body: input.reason,
        },
        select: { id: true },
      });

      if (input.isActive) {
        return { changed: true, revokedSessions: 0 };
      }

      const revoked = await tx.refreshToken.updateMany({
        where: { tenantId: input.tenantId, revokedAt: null },
        data: { revokedAt: input.now },
      });
      return { changed: true, revokedSessions: revoked.count };
    });
  }
}
