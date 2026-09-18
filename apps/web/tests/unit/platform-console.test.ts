import type { PlatformTenant, PlatformTenantDetail } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  billingBadge,
  daysUntil,
  eventTitle,
  hasTenantFilters,
  readTenantFilters,
  setupSteps,
  tenantFilterSearch,
  tenantsCsv,
} from '@/lib/platform-console';

/**
 * La console de l'éditeur — libellés, filtres de la liste, export CSV, mise en
 * route. Ce qui se décide sans DOM.
 */

const TENANT: PlatformTenant = {
  id: '7e586141-9ccf-4caa-802d-72c4d5e7aa2c',
  slug: 'maison-lotus',
  name: 'Maison Lotus',
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  isActive: true,
  billingStatus: 'trialing',
  trialEndsAt: '2026-09-20T10:00:00.000Z',
  createdAt: '2026-09-06T10:00:00.000Z',
  origin: 'console',
};

describe('les pastilles de facturation', () => {
  it('datent la fin d’un essai, dans le fuseau du salon', () => {
    expect(billingBadge(TENANT)).toEqual({ label: 'Essai · fin le 20/09/2026', tone: 'confirmed' });
  });

  it('disent un impayé à relancer', () => {
    expect(billingBadge({ ...TENANT, billingStatus: 'past_due' }).label).toBe('Impayé — relance');
  });

  it('comptent les jours restants sans jamais passer sous zéro', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(daysUntil('2026-09-20T10:00:00.000Z', now)).toBe(2);
    expect(daysUntil('2026-09-17T10:00:00.000Z', now)).toBe(0);
  });
});

describe('les filtres de la liste', () => {
  it('relisent l’adresse, en français', () => {
    expect(readTenantFilters({ q: ' lotus ', facturation: 'trialing', etat: 'suspended', page: '2' })).toEqual({
      page: 2,
      q: 'lotus',
      billingStatus: 'trialing',
      state: 'suspended',
    });
  });

  it('ignorent une valeur inconnue plutôt que de provoquer un 400', () => {
    expect(readTenantFilters({ facturation: 'gratuit', etat: 'ferme', page: '-3' })).toEqual({ page: 1 });
  });

  it('se réécrivent en paramètres, sans la première page', () => {
    expect(tenantFilterSearch({ q: 'lotus', billingStatus: 'active', page: 1 }).toString()).toBe(
      'q=lotus&facturation=active',
    );
    expect(hasTenantFilters({ page: 3 })).toBe(false);
    expect(hasTenantFilters({ state: 'active' })).toBe(true);
  });
});

describe('l’export CSV', () => {
  it('s’ouvre dans Excel en français : BOM, point-virgule, fins de ligne CRLF', () => {
    const csv = tenantsCsv([TENANT]);

    expect(csv.startsWith('\uFEFF"Salon";"Adresse"')).toBe(true);
    expect(csv).toContain('"Maison Lotus";"maison-lotus";"Console";"Essai";"2026-09-20";"Actif"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('neutralise une formule et double les guillemets', () => {
    const csv = tenantsCsv([{ ...TENANT, name: '=HYPERLINK("x")' }]);

    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
  });
});

describe('la mise en route d’un salon', () => {
  const detail = {
    tenant: TENANT,
    setup: {
      adminActivated: true,
      address: true,
      legalIdentity: false,
      openingHours: true,
      activeServices: 3,
      activeStaff: 2,
      staffWithSchedule: 1,
      firstAppointmentAt: null,
    },
  } as unknown as PlatformTenantDetail;

  it('déroule les étapes dans l’ordre où on les franchit', () => {
    const steps = setupSteps(detail);

    expect(steps.map((step) => step.key)).toEqual([
      'admin',
      'adresse',
      'horaires',
      'prestations',
      'praticiens',
      'legal',
      'premier-rdv',
    ]);
    expect(steps.filter((step) => step.done)).toHaveLength(5);
  });

  it('dit ce qu’il reste à faire, en nombres', () => {
    const steps = setupSteps(detail);

    expect(steps.find((step) => step.key === 'praticiens')?.detail).toBe(
      '1 praticien avec horaires sur 2 actifs',
    );
    expect(steps.find((step) => step.key === 'premier-rdv')?.detail).toBe(
      'Aucun rendez-vous pour l’instant.',
    );
  });

  it('titre chaque ligne d’historique', () => {
    expect(
      eventTitle({ id: 'x', kind: 'suspended', body: 'Motif', operatorName: null, createdAt: TENANT.createdAt }),
    ).toBe('Salon suspendu');
  });
});
