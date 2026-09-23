import type { PlatformTenant, PlatformTenantDetail } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  billingBadge,
  billingStatusLabel,
  daysUntil,
  eventTitle,
  formatPlatformDate,
  formatPlatformDateTime,
  hasTenantFilters,
  originLabel,
  readTenantFilters,
  setupSteps,
  tenantFilterSearch,
  tenantsCsv,
} from '@/lib/platform-console';

/**
 * La console de l'éditeur — libellés, filtres de la liste, export CSV, mise en
 * route. Ce qui se décide sans DOM.
 *
 * Depuis #1106, chaque fonction reçoit sa langue : ces suites l'éprouvent dans
 * les deux, la langue étant justement ce que ce module a de plus fragile — un
 * libellé oublié ne casse rien, il s'affiche simplement dans l'autre langue.
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
  it('datent la fin d’un essai, dans le fuseau du salon et dans la langue lue', () => {
    expect(billingBadge(TENANT, { locale: 'fr' })).toEqual({
      label: 'Essai · fin le 20/09/2026',
      tone: 'confirmed',
    });
    // `en-US` écrit le mois d'abord : la date suit la langue, le fuseau ne bouge
    // pas — c'est toujours le 20 septembre à Paris.
    expect(billingBadge(TENANT, { locale: 'en' })).toEqual({
      label: 'Trial · ends 9/20/26',
      tone: 'confirmed',
    });
  });

  it('dit un impayé à relancer dans les deux langues', () => {
    const past = { ...TENANT, billingStatus: 'past_due' as const };

    expect(billingBadge(past, { locale: 'fr' }).label).toBe('Impayé — relance');
    expect(billingBadge(past, { locale: 'en' }).label).toBe('Unpaid — follow up');
  });

  it('nomme chaque statut de facturation dans la langue lue', () => {
    expect(billingStatusLabel('managed', 'fr')).toBe('Géré par la plateforme');
    expect(billingStatusLabel('managed', 'en')).toBe('Managed by the platform');
    expect(billingStatusLabel('canceled', 'en')).toBe('Canceled');
  });

  it('nomme l’origine d’un salon dans la langue lue', () => {
    expect(originLabel(TENANT, 'fr')).toBe('Ouvert par la console');
    expect(originLabel({ ...TENANT, origin: 'signup' }, 'en')).toBe('Signed up online');
  });

  it('comptent les jours restants sans jamais passer sous zéro', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(daysUntil('2026-09-20T10:00:00.000Z', now)).toBe(2);
    expect(daysUntil('2026-09-17T10:00:00.000Z', now)).toBe(0);
  });
});

describe('les dates de la console', () => {
  it('suivent la langue, et restent dans le fuseau du salon', () => {
    expect(formatPlatformDate(TENANT.createdAt, 'Europe/Paris', { locale: 'fr' })).toBe(
      '6 sept. 2026',
    );
    expect(formatPlatformDate(TENANT.createdAt, 'Europe/Paris', { locale: 'en' })).toBe(
      'Sep 6, 2026',
    );
  });

  it('suivent la région de l’établissement quand il en a publié une', () => {
    // Même langue, deux régions : le Royaume-Uni écrit le jour d'abord.
    const american = formatPlatformDateTime(TENANT.createdAt, 'UTC', {
      locale: 'en',
      countryCode: 'US',
    });
    const british = formatPlatformDateTime(TENANT.createdAt, 'UTC', {
      locale: 'en',
      countryCode: 'GB',
    });

    expect(american.startsWith('9/6/26')).toBe(true);
    expect(british.startsWith('06/09/2026')).toBe(true);
  });
});

describe('les filtres de la liste', () => {
  it('relisent l’adresse, dont les paramètres restent en français', () => {
    expect(
      readTenantFilters({ q: ' lotus ', facturation: 'trialing', etat: 'suspended', page: '2' }),
    ).toEqual({
      page: 2,
      q: 'lotus',
      billingStatus: 'trialing',
      state: 'suspended',
    });
  });

  it('ignorent une valeur inconnue plutôt que de provoquer un 400', () => {
    expect(readTenantFilters({ facturation: 'gratuit', etat: 'ferme', page: '-3' })).toEqual({
      page: 1,
    });
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
  it('s’ouvre dans un tableur : BOM, point-virgule, fins de ligne CRLF', () => {
    const csv = tenantsCsv([TENANT], 'fr');

    // Le BOM est vérifié par son point de code : un caractère invisible dans une
    // chaîne de test ne se relit pas.
    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(csv.slice(1).startsWith('"Salon";"Adresse"')).toBe(true);
    expect(csv).toContain('"Maison Lotus";"maison-lotus";"Console";"Essai";"2026-09-20";"Actif"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('écrit ses en-têtes dans la langue de l’export', () => {
    const csv = tenantsCsv([TENANT], 'en');

    expect(csv.codePointAt(0)).toBe(0xfeff);
    expect(
      csv.slice(1).startsWith('"Salon";"Address";"Origin";"Billing";"Trial end";"State"'),
    ).toBe(true);
    // Les trois valeurs que la console **nomme** suivent aussi la langue ; les
    // données du salon, elles, ne se traduisent pas.
    expect(csv).toContain('"Maison Lotus";"maison-lotus";"Console";"Trial";"2026-09-20";"Active"');
    // La date reste en ISO : une colonne de dates se trie et se recalcule.
    expect(csv).toContain('"2026-09-20"');
  });

  it('neutralise une formule et double les guillemets', () => {
    const csv = tenantsCsv([{ ...TENANT, name: '=HYPERLINK("x")' }], 'fr');

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
    const steps = setupSteps(detail, { locale: 'fr' });

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

  it('dit ce qu’il reste à faire, en nombres et dans la langue lue', () => {
    const fr = setupSteps(detail, { locale: 'fr' });
    const en = setupSteps(detail, { locale: 'en' });

    expect(fr.find((step) => step.key === 'prestations')?.detail).toBe('3 prestations actives');
    expect(en.find((step) => step.key === 'prestations')?.detail).toBe('3 active services');
    expect(fr.find((step) => step.key === 'praticiens')?.detail).toBe(
      'Horaires saisis pour 1 sur 2 praticien·ne·s actif·ve·s',
    );
    expect(en.find((step) => step.key === 'praticiens')?.detail).toBe(
      'Hours entered for 1 of 2 active practitioners',
    );
    expect(fr.find((step) => step.key === 'premier-rdv')?.detail).toBe(
      'Aucun rendez-vous pour l’instant.',
    );
    expect(en.find((step) => step.key === 'premier-rdv')?.detail).toBe('No appointment yet.');
  });

  it('accorde le nom sur le nombre de praticiens actifs, jamais sur ceux qui ont des horaires', () => {
    const seul = {
      ...detail,
      setup: { ...detail.setup, activeStaff: 1, staffWithSchedule: 1 },
    } as PlatformTenantDetail;

    expect(setupSteps(seul, { locale: 'en' }).find((step) => step.key === 'praticiens')?.detail).toBe(
      'Hours entered for 1 of 1 active practitioner',
    );
  });

  it('date le premier rendez-vous dans la langue lue', () => {
    const booked = {
      ...detail,
      setup: { ...detail.setup, firstAppointmentAt: '2026-09-10T08:00:00.000Z' },
    } as PlatformTenantDetail;

    expect(setupSteps(booked, { locale: 'en' }).find((step) => step.key === 'premier-rdv')?.detail).toBe(
      'On Sep 10, 2026',
    );
  });

  it('titre chaque ligne d’historique dans la langue lue', () => {
    const event = {
      id: 'x',
      kind: 'suspended' as const,
      body: 'Motif',
      operatorName: null,
      createdAt: TENANT.createdAt,
    };

    expect(eventTitle(event, 'fr')).toBe('Salon suspendu');
    expect(eventTitle(event, 'en')).toBe('Salon suspended');
    expect(eventTitle({ ...event, kind: 'invitation_reissued' }, 'en')).toBe('Access links resent');
  });
});
