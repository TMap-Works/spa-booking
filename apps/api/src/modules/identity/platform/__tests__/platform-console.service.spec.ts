import { JwtService } from '@nestjs/jwt';

import { NotFoundError } from '../../../../common/errors';
import type { StructuredLogger } from '../../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../../config/app-config.service';
import { fakeConfig, rejectionOf } from '../../__tests__/identity.doubles';
import { PasswordHasher } from '../../password.hasher';
import { TokenService } from '../../token.service';
import { PlatformConsoleService } from '../platform-console.service';
import { PlatformService } from '../platform.service';
import { PlatformTokenService } from '../platform-token.service';
import type { AuthenticatedOperator } from '../platform.types';
import { FakePlatformConsoleRepository, FakePlatformRepository } from './platform.doubles';

/**
 * Le suivi des salons par l'éditeur — vue d'ensemble, fiche, notes, suspension.
 *
 * Les dépôts sont doublés : ce qui est exercé est ce que le service **décide**
 * (fenêtres de lecture, revenu, drapeaux de mise en route, historique, rejeu),
 * pas les requêtes, qui ont leur recette.
 */

const APP_URL = 'https://exemple.test';
const NOW = new Date('2026-09-18T12:00:00.000Z');

interface CapturedLog {
  message: string;
  params: unknown[];
}

function fixture(): {
  service: PlatformConsoleService;
  tenants: FakePlatformRepository;
  console: FakePlatformConsoleRepository;
  operator: AuthenticatedOperator;
  logs: CapturedLog[];
} {
  const config = fakeConfig({ appUrl: APP_URL } as Partial<AppConfigService>);
  const tenants = new FakePlatformRepository();
  const consoleRepository = new FakePlatformConsoleRepository(tenants);
  const logs: CapturedLog[] = [];
  const logger = {
    log: (message: unknown, ...params: unknown[]): void => {
      logs.push({ message: String(message), params });
    },
    warn: (): void => undefined,
    error: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;

  const platform = new PlatformService(
    tenants.asRepository(),
    new PasswordHasher(config),
    new PlatformTokenService(new JwtService(), config),
    new TokenService(new JwtService(), config),
    config,
    logger,
  );

  return {
    service: new PlatformConsoleService(
      consoleRepository.asRepository(),
      tenants.asRepository(),
      platform,
      config,
      logger,
    ),
    tenants,
    console: consoleRepository,
    operator: { operatorId: '0f0f0f0f-0000-4000-8000-000000000001', email: 'op@tmap-works.test' },
    logs,
  };
}

describe('Vue d’ensemble', () => {
  it('compte le revenu récurrent au tarif de l’offre, et range les ouvertures par semaine', async () => {
    const { service, console } = fixture();
    console.counts = {
      ...console.counts,
      total: 20,
      byBillingStatus: { managed: 3, pending: 1, trialing: 4, active: 10, past_due: 2, canceled: 0 },
      recentOpenings: [
        { createdAt: new Date('2026-09-16T08:00:00.000Z'), origin: 'signup' },
        { createdAt: new Date('2026-09-15T08:00:00.000Z'), origin: 'console' },
      ],
    };

    const overview = await service.overview(NOW);

    expect(overview.revenue.monthlyRecurring).toEqual({ amountMinor: 29_000, currency: 'EUR' });
    expect(overview.revenue.atRisk).toEqual({ amountMinor: 5_800, currency: 'EUR' });
    expect(overview.signupsByWeek.at(-1)).toEqual({
      weekStart: '2026-09-14',
      console: 1,
      signup: 1,
    });
    expect(overview.generatedAt).toBe(NOW);
  });

  it('lit la base avec les bornes de la fenêtre — essais à sept jours', async () => {
    const { service, console } = fixture();

    await service.overview(NOW);

    expect(console.lastOverviewWindow?.trialHorizon.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(console.lastOverviewWindow?.openingsSince.toISOString()).toBe('2026-06-29T00:00:00.000Z');
  });
});

describe('Fiche d’un salon', () => {
  it('répond 404 sur un salon inconnu', async () => {
    const { service } = fixture();

    expect(
      await rejectionOf(service.tenantDetail('99999999-9999-4999-8999-999999999999', NOW)),
    ).toBeInstanceOf(NotFoundError);
  });

  it('rend les liens de vitrine et de back-office — jamais le lien d’activation', async () => {
    const { service, tenants } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });

    const detail = await service.tenantDetail(tenant.id, NOW);

    expect(detail.links.bookingUrl).toContain('/reservation');
    expect(detail.links.adminLoginUrl).toContain('/admin/connexion');
    expect(JSON.stringify(detail.links)).not.toContain('token=');
  });

  it('dit l’administrateur activé quand l’un d’eux a posé son mot de passe', async () => {
    const { service, tenants, console } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });
    const account = {
      firstName: 'Alice',
      lastName: 'Durand',
      email: 'alice@maison-lotus.test',
      isActive: true,
      lastLoginAt: null,
      createdAt: NOW,
    };
    console.accounts = [
      { ...account, id: 'a1', role: 'admin', activated: false },
      { ...account, id: 's1', role: 'staff', activated: true },
    ];

    expect((await service.tenantDetail(tenant.id, NOW)).setup.adminActivated).toBe(false);

    console.accounts = [{ ...account, id: 'a1', role: 'admin', activated: true }];
    expect((await service.tenantDetail(tenant.id, NOW)).setup.adminActivated).toBe(true);
  });

  it('exige raison sociale **et** identifiant pour dire l’identité légale renseignée', async () => {
    const { service, tenants } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });

    const detail = await service.tenantDetail(tenant.id, NOW);

    expect(detail.setup.address).toBe(true);
    expect(detail.setup.legalIdentity).toBe(false);
  });
});

describe('Notes internes', () => {
  it('inscrit la note dans l’historique du salon', async () => {
    const { service, tenants, operator } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });

    const note = await service.addNote({ operator, tenantId: tenant.id, body: 'Relancée le 18/09.' });

    expect(note.kind).toBe('note');
    expect(note.body).toBe('Relancée le 18/09.');
    expect((await service.tenantDetail(tenant.id, NOW)).events[0]?.body).toBe('Relancée le 18/09.');
  });

  it('refuse une note sur un salon inconnu — 404, rien d’écrit', async () => {
    const { service, console, operator } = fixture();

    expect(
      await rejectionOf(
        service.addNote({
          operator,
          tenantId: '99999999-9999-4999-8999-999999999999',
          body: 'Note',
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
    expect(console.events).toHaveLength(0);
  });
});

describe('Suspension et réactivation', () => {
  it('suspend, garde le motif, et le journalise sans le motif', async () => {
    const { service, tenants, console, operator, logs } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });
    console.revokedSessions = 3;

    const updated = await service.updateStatus({
      operator,
      tenantId: tenant.id,
      isActive: false,
      reason: 'Impayé depuis 30 jours',
      now: NOW,
    });

    expect(updated.isActive).toBe(false);
    expect(console.events.at(-1)).toMatchObject({ kind: 'suspended', body: 'Impayé depuis 30 jours' });
    const log = logs.find((entry) => entry.message.startsWith('Suspension'));
    expect(log).toBeDefined();
    expect(JSON.stringify(log?.params)).not.toContain('Impayé');
    expect(JSON.stringify(log?.params)).toContain('"revokedSessions":3');
  });

  it('rejouée, ne réécrit ni l’état ni l’historique', async () => {
    const { service, tenants, console, operator } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });
    const suspend = {
      operator,
      tenantId: tenant.id,
      isActive: false,
      reason: 'Motif',
      now: NOW,
    };

    await service.updateStatus(suspend);
    await service.updateStatus(suspend);

    expect(console.events.filter((event) => event.kind === 'suspended')).toHaveLength(1);
  });

  it('réactive un salon suspendu', async () => {
    const { service, tenants, operator } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });
    tenants.setActive(tenant.id, false);

    const updated = await service.updateStatus({
      operator,
      tenantId: tenant.id,
      isActive: true,
      reason: 'Régularisé',
      now: NOW,
    });

    expect(updated.isActive).toBe(true);
  });

  it('répond 404 sur un salon inconnu', async () => {
    const { service, operator } = fixture();

    expect(
      await rejectionOf(
        service.updateStatus({
          operator,
          tenantId: '99999999-9999-4999-8999-999999999999',
          isActive: false,
          reason: 'Motif',
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe('Réémission de l’invitation', () => {
  it('note la réémission dans l’historique du salon', async () => {
    const { service, tenants, console, operator } = fixture();
    const tenant = tenants.addTenant({ slug: 'maison-lotus' });

    const reissued = await service.reissueAdminInvitation({ operator, tenantId: tenant.id });

    expect(reissued.links.adminInvitationUrl).toContain('token=');
    expect(console.events.at(-1)).toMatchObject({ kind: 'invitation_reissued', body: null });
  });
});
