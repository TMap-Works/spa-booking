import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountPage from '@/app/(account)/[tenantSlug]/compte/(liste)/page';
import AccountHistoryPage from '@/app/(account)/[tenantSlug]/compte/historique/page';

import { service, tenant } from './fixtures';

/**
 * Ce que les deux états vides de l'espace client offrent à cliquer — #745,
 * repris par #1053.
 *
 * ## La référence, et pourquoi elle est tenue ici
 *
 * `docs/design/appointments/states.md` § « Règles générales » :
 *
 * > **Vide** : toujours accompagné d'une explication et d'**au moins une
 * > action** pour sortir de l'impasse. Un cul-de-sac muet fait abandonner.
 *
 * L'audit de conception a relevé l'écart sur un compte créé à l'instant, à
 * 360 px : les deux moitiés sont vides en même temps, toutes deux portent leur
 * explication et aucune ne porte quoi que ce soit de cliquable. Le seul chemin
 * restant était un lien de pied de page, situé **sous** les deux blocs.
 *
 * Les deux moitiés ayant leur onglet depuis #1053, chacune se juge sur son écran
 * — mais la règle ne change pas : un vide sans sortie reste un cul-de-sac.
 *
 * ## Ce que #1053 y ajoute
 *
 * `BM-HISTO-02` — « Réserver à nouveau » — veut que la cliente refasse la même
 * prestation sans refaire tout le tunnel. L'état vide des rendez-vous **nomme**
 * donc la dernière prestation honorée, quand il y en a une. Il ne la
 * pré-sélectionne pas : le tunnel n'accepte aucun paramètre d'URL aujourd'hui, et
 * promettre « en un clic » aurait été une promesse que le lien ne tient pas.
 */

const fetchMyAppointments = vi.fn();
const fetchPublicServices = vi.fn();
const fetchPublicTenant = vi.fn();

// Même doublure que `account-appointment-sections.test.tsx` : le module réel est
// repris et seules les lectures sont remplacées, pour que la mémoïsation de
// `tenant.ts` (`cache()` de React) reste en place.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchMyAppointments: (...args: unknown[]) => fetchMyAppointments(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccountData: <T,>(
    _tenantSlug: string,
    _currentPath: string,
    read: (token: string) => Promise<T>,
  ) => read('jeton-de-test'),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  cancelOwnAppointmentAction: vi.fn(),
  logoutAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2e',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-21T08:00:00.000Z',
    endsAt: '2026-09-21T09:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
    ...overrides,
  };
}

function servir(upcoming: readonly BookedAppointment[], past: readonly BookedAppointment[]): void {
  fetchPublicTenant.mockResolvedValue(tenant);
  fetchPublicServices.mockResolvedValue([service]);
  fetchMyAppointments.mockImplementation((_token: string, query: { scope?: string }) =>
    Promise.resolve(query.scope === 'past' ? [...past] : [...upcoming]),
  );
}

async function rendreLesRendezVous(): Promise<HTMLElement> {
  const { container } = render(
    await AccountPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }),
  );

  return container;
}

async function rendreLHistorique(): Promise<HTMLElement> {
  const { container } = render(
    await AccountHistoryPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }),
  );

  return container;
}

afterEach(() => {
  cleanup();
  fetchMyAppointments.mockReset();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
});

describe('les états vides de l’espace client à la première visite', () => {
  it('offre le rendez-vous que la phrase du bloc « à venir » appelle déjà', async () => {
    servir([], []);

    await rendreLesRendezVous();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });
    const action = within(aVenir).getByRole('link', { name: 'Prendre rendez-vous' });

    expect(action.getAttribute('href')).toBe(`/${tenant.slug}/reservation`);
    expect(within(aVenir).getByText('Aucun rendez-vous à venir')).toBeDefined();
    expect(within(aVenir).getByText(/réserver votre prochaine visite/i)).toBeDefined();
  });

  it('offre aussi une sortie à l’historique, que la capture montrait muet', async () => {
    servir([], []);

    await rendreLHistorique();

    const historique = screen.getByRole('region', { name: 'Historique' });
    const action = within(historique).getByRole('link', { name: 'Découvrir les prestations' });

    // La vitrine, et non le tunnel : l'historique se remplit d'un rendez-vous,
    // et un rendez-vous commence par le choix d'un soin.
    expect(action.getAttribute('href')).toBe(`/${tenant.slug}`);
    expect(within(historique).getByText('Votre historique est vide')).toBeDefined();
  });

  it.each([
    ['les rendez-vous', rendreLesRendezVous],
    ['l’historique', rendreLHistorique],
  ])('ne laisse aucun bloc vide de %s sans quelque chose à cliquer', async (_ecran, rendre) => {
    servir([], []);

    const container = await rendre();

    const vides = [...container.querySelectorAll('.spa-empty')];

    expect(vides).toHaveLength(1);
    for (const vide of vides) {
      expect(vide.querySelector('a[href]')).not.toBeNull();
    }
  });

  it('ne met l’accent que sur la sortie des rendez-vous', async () => {
    servir([], []);

    const rendezVous = await rendreLesRendezVous();
    expect(rendezVous.querySelectorAll('.spa-empty .spa-button--accent')).toHaveLength(1);

    cleanup();
    servir([], []);

    // L'historique est le second rôle : deux accents empilés dans le parcours ne
    // hiérarchiseraient plus rien (#745).
    const historique = await rendreLHistorique();
    expect(historique.querySelectorAll('.spa-empty .spa-button--accent')).toHaveLength(0);
  });

  it('n’ajoute l’action qu’au vide : une moitié peuplée n’en porte pas', async () => {
    servir([appointment()], []);

    await rendreLesRendezVous();

    expect(screen.queryByRole('link', { name: 'Prendre rendez-vous' })).toBeNull();
  });
});

describe('l’état vide nomme la dernière prestation honorée (BM-HISTO-02, #1053)', () => {
  it('la nomme avec sa durée et son praticien', async () => {
    servir([], [appointment({ status: 'completed' })]);

    await rendreLesRendezVous();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });

    expect(within(aVenir).getByText(/Votre dernière visite/)).toBeDefined();
    expect(within(aVenir).getByText(/Massage suédois/)).toBeDefined();
    expect(within(aVenir).getByText(/Hery/)).toBeDefined();
    // La sortie reste la même : c'est une suggestion, pas une seconde action.
    expect(within(aVenir).getByRole('link', { name: 'Prendre rendez-vous' })).toBeDefined();
  });

  it('retombe sur la phrase générique quand rien n’a été honoré', async () => {
    // Un rendez-vous annulé n'est pas une visite : le proposer « à nouveau »
    // rappellerait à la cliente ce qu'elle a précisément décidé de ne pas faire.
    servir([], [appointment({ status: 'cancelled', cancelledBy: 'client' })]);

    await rendreLesRendezVous();

    expect(screen.getByText(/réserver votre prochaine visite/i)).toBeDefined();
    expect(screen.queryByText(/Votre dernière visite/)).toBeNull();
  });
});
