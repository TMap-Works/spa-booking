import { Injectable } from '@nestjs/common';
import { tenantPublicUrl } from '@spa/shared';

import { NotFoundError } from '../../../common/errors';
import { StructuredLogger } from '../../../common/logging/structured-logger';
import { AppConfigService } from '../../../config/app-config.service';
import { PlatformConsoleRepository } from './platform-console.repository';
import {
  ACTIVITY_DAYS,
  overviewWindow,
  recurringRevenue,
  signupWeeks,
} from './platform-overview';
import { PlatformRepository } from './platform.repository';
import { PlatformService } from './platform.service';
import type {
  AuthenticatedOperator,
  PlatformOverviewView,
  ReissuedTenantInvitation,
  TenantDetailView,
  TenantEventRecord,
  TenantSummary,
} from './platform.types';

const DAY_MS = 86_400_000;

/**
 * Le suivi des salons par l'éditeur — tableau de bord, fiche salon, notes,
 * suspension.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Ouvrir un
 * salon et se connecter restent l'affaire de `PlatformService` : ce service-ci
 * lit ce qui s'est passé depuis, et trace ce que l'éditeur y fait.
 *
 * ## Ce que la console lit d'un salon, et ce qu'elle n'en lit pas
 *
 * Des **nombres** (rendez-vous, prestations, comptes clients) et les comptes
 * **internes** du salon — ceux à qui l'éditeur a affaire. Jamais un rendez-vous,
 * une fiche cliente ni un montant encaissé par le salon (ADR 0012) : l'éditeur
 * est sous-traitant, il n'a pas d'usage propre de ces données.
 *
 * ## Chaque geste laisse une ligne
 *
 * Suspendre, réactiver, réinviter : l'historique du salon le garde, avec
 * l'opérateur et le motif. Le journal structuré en garde une seconde trace, qui
 * alerte ; la table est celle qui se relit.
 */
@Injectable()
export class PlatformConsoleService {
  public constructor(
    private readonly repository: PlatformConsoleRepository,
    private readonly tenants: PlatformRepository,
    private readonly platform: PlatformService,
    private readonly config: AppConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  /** La vue d'ensemble de la plateforme, à l'instant `now`. */
  public async overview(now: Date = new Date()): Promise<PlatformOverviewView> {
    const window = overviewWindow(now);
    const counts = await this.repository.overviewCounts({ now, ...window });

    return {
      generatedAt: now,
      tenants: {
        total: counts.total,
        suspended: counts.suspended,
        byBillingStatus: counts.byBillingStatus,
      },
      revenue: recurringRevenue(counts.byBillingStatus),
      trialsEndingSoon: counts.trialsEndingSoon,
      signupsByWeek: signupWeeks(counts.recentOpenings, now),
      activation: counts.activation,
      recent: counts.recent,
    };
  }

  /**
   * La fiche d'un salon.
   *
   * Les liens rendus sont ceux de la vitrine et du back-office — **pas** celui
   * d'activation, qui porte un jeton : il ne s'obtient que par la réémission,
   * geste explicite et tracé.
   *
   * La **langue** du salon fait partie de ce que la fiche rend (#1189) : la
   * console la lisait sur `GET /public/{slug}`, qui ne répond pas pour un salon
   * suspendu — un détour qui coûtait un appel et taisait la langue de ceux-là
   * mêmes qu'un opérateur consulte le plus.
   */
  public async tenantDetail(id: string, now: Date = new Date()): Promise<TenantDetailView> {
    const record = await this.repository.findTenantDetail(id);
    if (record === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    const since = new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS);
    const [accounts, clientCount, setup, activity, events] = await Promise.all([
      this.repository.listInternalAccounts(id),
      this.repository.countClients(id),
      this.repository.setup(id),
      this.repository.activity({ tenantId: id, now, since }),
      this.repository.listEvents(id),
    ]);

    const baseUrl = this.config.appUrl;
    const slug = record.summary.slug;

    return {
      record,
      links: {
        bookingUrl: tenantPublicUrl(slug, '/reservation', { baseUrl }),
        adminLoginUrl: tenantPublicUrl(slug, '/admin/connexion', { baseUrl }),
      },
      accounts,
      clientCount,
      setup: {
        ...setup,
        adminActivated: accounts.some((account) => account.role === 'admin' && account.activated),
        address: record.address !== null,
        legalIdentity: record.legalName !== null && record.hasLegalId,
      },
      activity,
      events,
    };
  }

  /** Ajoute une note interne à l'historique d'un salon. */
  public async addNote(input: {
    readonly operator: AuthenticatedOperator;
    readonly tenantId: string;
    readonly body: string;
  }): Promise<TenantEventRecord> {
    await this.requireTenant(input.tenantId);

    return this.repository.recordEvent({
      tenantId: input.tenantId,
      operatorId: input.operator.operatorId,
      kind: 'NOTE',
      body: input.body,
    });
  }

  /**
   * Suspend ou réactive un salon — le motif est gardé dans son historique.
   *
   * **Rejouable** : demander l'état où le salon est déjà ne réécrit rien, et ne
   * double pas la ligne d'historique. La réponse est le salon tel qu'il est.
   */
  public async updateStatus(input: {
    readonly operator: AuthenticatedOperator;
    readonly tenantId: string;
    readonly isActive: boolean;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<TenantSummary> {
    const outcome = await this.repository.setTenantActive({
      tenantId: input.tenantId,
      operatorId: input.operator.operatorId,
      isActive: input.isActive,
      reason: input.reason,
      now: input.now ?? new Date(),
    });

    if (outcome === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    if (outcome.changed) {
      // Le motif n'y figure pas : il est libre, et un journal n'est pas le lieu
      // d'un texte qu'on n'a pas relu. Il vit dans l'historique du salon.
      this.logger.log(
        input.isActive
          ? 'Réactivation d’un établissement depuis la console plateforme.'
          : 'Suspension d’un établissement depuis la console plateforme.',
        {
          operatorId: input.operator.operatorId,
          tenantId: input.tenantId,
          revokedSessions: outcome.revokedSessions,
          context: 'PlatformConsoleService',
        },
      );
    }

    return this.requireTenant(input.tenantId);
  }

  /**
   * Réémet l'invitation de l'administrateur — et le **note** dans l'historique
   * du salon, pour que le suivant sache qu'un lien est déjà parti.
   */
  public async reissueAdminInvitation(input: {
    readonly operator: AuthenticatedOperator;
    readonly tenantId: string;
  }): Promise<ReissuedTenantInvitation> {
    const reissued = await this.platform.reissueAdminInvitation(input);

    await this.repository.recordEvent({
      tenantId: reissued.tenantId,
      operatorId: input.operator.operatorId,
      kind: 'INVITATION_REISSUED',
      body: null,
    });

    return reissued;
  }

  private async requireTenant(id: string): Promise<TenantSummary> {
    const tenant = await this.tenants.findTenantById(id);
    if (tenant === null) {
      throw new NotFoundError('Établissement introuvable.');
    }
    return tenant;
  }
}
