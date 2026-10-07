import type { Permission, PublicTenant, UserRole } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Les phrases sont **lues** au catalogue et jamais recopiées : une suite qui
// citerait le littéral resterait verte le jour où l'écran cesserait de consulter
// la table (même règle que `admin-clients-ecriture-refusee`).
import planningFr from '@/messages/fr/admin-my-planning.json';

/**
 * « Mon planning » devant un compte sans fiche praticien — #1411.
 *
 * ## Le défaut que cette suite ferme
 *
 * `GET /v1/me/staff-profile` répond 404 à tout compte du salon qui n'a pas de
 * fiche praticien, gérante et administratrice comprises — elles obtiennent cet
 * écran parce qu'elles donnent aussi des soins. L'état vide leur disait pourtant
 * « Demandez à la gérance de créer votre fiche dans « Personnel » », et son seul
 * bouton ouvrait le planning du salon : le motif était faux, et la sortie menait
 * ailleurs que là où le geste se pose.
 *
 * ## Ce qui est éprouvé, et dans les deux sens
 *
 * 1. à partir du rang `manager` — le seuil de `POST /v1/staff` —, le texte cesse
 *    de renvoyer à la gérance et l'action **accentuée** mène à la création d'une
 *    fiche praticien, avant la sortie vers le planning du salon ;
 * 2. le rang `admin` l'obtient aussi : le seuil est un rang, pas un rôle unique ;
 * 3. au rang praticien, **rien ne change** — « demandez à la gérance » est le vrai
 *    motif, aucun lien ne lui est offert, et la non-régression de ce rang fait
 *    partie du ticket. C'est la conduite déjà tranchée pour lui par #1176 : un
 *    état vide ne propose pas un écran fermé au rôle ;
 * 4. un shell illisible — `GET /auth/me` muet — retombe sur ce même message : on
 *    ne propose pas un geste sur un rang qu'on ignore.
 *
 * La garde d'affichage ne remplace pas celle de l'API, et cette suite ne le
 * prétend pas : `POST /v1/staff` continue d'exiger `MANAGER` pour tout le monde
 * (`apps/api/src/modules/catalog/staff.controller.ts`).
 *
 * La langue est celle de l'amorce des suites (`fr`) : ce qui est éprouvé ici est
 * la **branche de rendu**, et la variante anglaise de ces phrases l'est par
 * `admin-my-planning-i18n`.
 */

const fetchPublicTenant = vi.fn();
const fetchMyStaffProfile = vi.fn();
const fetchMyAgenda = vi.fn();
const fetchMySchedule = vi.fn();
const loadAdminShell = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
  fetchMyStaffProfile: (...args: unknown[]) => fetchMyStaffProfile(...args),
  fetchMyAgenda: (...args: unknown[]) => fetchMyAgenda(...args),
  fetchMySchedule: (...args: unknown[]) => fetchMySchedule(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-du-compte-connecte'),
  adminLoadFailure: () => <p>écran de refus d’accès</p>,
}));

/**
 * Le shell du back-office — la seule source du rang et des permissions
 * effectives. Doublé plutôt que reconstitué : la vraie fonction lit le cookie de
 * session et appelle trois routes, et ce que cette suite doit pouvoir varier est
 * sa **sortie**, rang par rang.
 */
vi.mock('@/app/(admin)/[tenantSlug]/admin/layout', () => ({
  loadAdminShell: (...args: unknown[]) => loadAdminShell(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/spa-lumiere/admin/mon-planning',
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/calendrier/actions', () => ({
  markDeskAppointmentStatusAction: vi.fn(),
}));

import { ApiClientError } from '@/lib/api-client';
import MyPlanningPage from '@/app/(admin)/[tenantSlug]/admin/mon-planning/page';
import { adminCalendarPath } from '@/app/(admin)/[tenantSlug]/admin/paths';
import { adminNewStaffMemberPath } from '@/app/(admin)/[tenantSlug]/admin/personnel/paths';

const SLUG = 'spa-lumiere';
const TZ = 'Europe/Paris';

/** Ce que l'API sert à une praticienne (ADR 0013). */
const PERMISSIONS_PRATICIENNE: readonly Permission[] = [
  'agenda:read:own',
  'appointment:write:own',
  'customers:read:own',
];

/** Et ce qu'elle sert à une gérante. */
const PERMISSIONS_GERANTE: readonly Permission[] = [
  ...PERMISSIONS_PRATICIENNE,
  'agenda:read:all',
  'appointment:write:all',
  'customers:read:all',
  'customers:write',
  'accounts:read',
  'checkout:collect',
  'reporting:read',
];

const TENANT: PublicTenant = {
  id: '99999999-9999-4999-8999-999999999999',
  slug: SLUG,
  name: 'Spa Lumière',
  timezone: TZ,
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
  address: {
    line1: '4 quai des Lumières',
    city: 'Lyon',
    postalCode: '69002',
    country: 'FR',
  },
};

/** Le shell d'un compte du salon, au rang demandé. */
function shellDe(role: UserRole, permissions: readonly Permission[] | null) {
  return {
    establishments: [{ slug: SLUG, name: TENANT.name }],
    timeZone: TZ,
    countryCode: 'FR',
    userName: 'Claire B.',
    role,
    billing: null,
    permissions,
    hasStaffProfile: false,
  };
}

/** Le 404 que `GET /v1/me/staff-profile` rend à un compte sans fiche. */
function sansFichePraticien(): ApiClientError {
  return new ApiClientError(
    'STAFF_PROFILE_NOT_FOUND',
    'Ce compte n’a pas de fiche praticien dans ce salon.',
    404,
  );
}

beforeEach(() => {
  fetchPublicTenant.mockResolvedValue(TENANT);
  fetchMyStaffProfile.mockRejectedValue(sansFichePraticien());
  // La page lance les trois lectures ensemble : les deux autres n'ont pas à
  // échouer pour que la première décide de l'écran.
  fetchMyAgenda.mockResolvedValue({
    staffId: 'cccccccc-0000-4000-8000-000000000003',
    timezone: TZ,
    from: '2026-10-02',
    to: '2026-10-02',
    appointments: [],
  });
  fetchMySchedule.mockResolvedValue({
    staffId: 'cccccccc-0000-4000-8000-000000000003',
    timezone: TZ,
    from: '2026-10-02',
    to: '2026-10-02',
    entries: [],
  });
});

afterEach(() => {
  cleanup();
  fetchPublicTenant.mockReset();
  fetchMyStaffProfile.mockReset();
  fetchMyAgenda.mockReset();
  fetchMySchedule.mockReset();
  loadAdminShell.mockReset();
});

async function ouvrirMonPlanning(): Promise<React.ReactElement> {
  return MyPlanningPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({}),
  }) as unknown as Promise<React.ReactElement>;
}

describe('à un compte qui gère le personnel, l’écran propose de créer sa fiche', () => {
  it('nomme le vrai motif et mène à la création d’une fiche praticien', async () => {
    loadAdminShell.mockResolvedValue(shellDe('manager', PERMISSIONS_GERANTE));

    render(await ouvrirMonPlanning());

    expect(screen.getByText(planningFr.noProfile.title)).toBeDefined();
    expect(screen.getByText(planningFr.noProfile.managerBody)).toBeDefined();
    // Le message qui renvoie à la gérance est celui de l'autre rang, et il ne
    // doit plus s'adresser à la gérance elle-même — c'est le constat du ticket.
    expect(screen.queryByText(planningFr.noProfile.body)).toBeNull();

    const creer = screen.getByRole('link', { name: planningFr.noProfile.createRecord });
    expect(creer.getAttribute('href')).toBe(adminNewStaffMemberPath(SLUG));
    expect(creer.className).toContain('spa-button--accent');
  });

  it('garde la sortie vers le planning du salon, mais après le geste et en retrait', async () => {
    loadAdminShell.mockResolvedValue(shellDe('manager', PERMISSIONS_GERANTE));

    render(await ouvrirMonPlanning());

    const liens = screen.getAllByRole('link');
    expect(liens.map((lien) => lien.textContent)).toEqual([
      planningFr.noProfile.createRecord,
      planningFr.noProfile.openCalendar,
    ]);

    const planning = screen.getByRole('link', { name: planningFr.noProfile.openCalendar });
    expect(planning.getAttribute('href')).toBe(adminCalendarPath(SLUG));
    expect(planning.className).toContain('spa-button--neutral');
  });

  it('l’offre aussi au rang administrateur, qui est au-dessus du seuil', async () => {
    loadAdminShell.mockResolvedValue(shellDe('admin', [...PERMISSIONS_GERANTE, 'accounts:write']));

    render(await ouvrirMonPlanning());

    expect(screen.getByText(planningFr.noProfile.managerBody)).toBeDefined();
    expect(screen.getByRole('link', { name: planningFr.noProfile.createRecord })).toBeDefined();
  });
});

describe('au rang praticien, l’écran ne change pas', () => {
  it('renvoie à la gérance et n’offre aucun lien', async () => {
    loadAdminShell.mockResolvedValue(shellDe('staff', PERMISSIONS_PRATICIENNE));

    render(await ouvrirMonPlanning());

    expect(screen.getByText(planningFr.noProfile.body)).toBeDefined();
    expect(screen.queryByText(planningFr.noProfile.managerBody)).toBeNull();
    // Ni la création — qu'il n'obtiendrait pas — ni le planning du salon, qui lui
    // est fermé depuis #812 : un état vide ne propose pas un écran fermé au rôle
    // (#1176).
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it('s’y rabat quand le shell du back-office est illisible', async () => {
    loadAdminShell.mockResolvedValue(null);

    render(await ouvrirMonPlanning());

    expect(screen.getByText(planningFr.noProfile.body)).toBeDefined();
    expect(screen.queryAllByRole('link')).toEqual([]);
  });
});
