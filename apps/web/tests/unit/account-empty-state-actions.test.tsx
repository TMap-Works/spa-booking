import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountPage from '@/app/(account)/[tenantSlug]/compte/(liste)/page';

import { service, tenant } from './fixtures';

/**
 * Ce que les deux états vides de l'espace client offrent à cliquer — #745.
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
 * explication — « Choisissez une prestation et un créneau… » — et aucune ne
 * porte quoi que ce soit de cliquable. Le seul chemin restant était un lien de
 * pied de page, situé **sous** les deux blocs : à cette largeur il faut faire
 * défiler pour le trouver, alors que la phrase demande d'agir tout de suite.
 *
 * La suite éprouve donc les deux moitiés, et pas seulement celle que la
 * direction proposée nommait : une moitié corrigée et l'autre laissée muette
 * contredirait la règle autant qu'avant.
 *
 * ## Ce qu'elle protège en plus du simple « il y a un lien »
 *
 * - **L'explication reste** : l'action s'ajoute au texte, elle ne le remplace
 *   pas. La règle exige les deux.
 * - **Un seul accent** : deux boutons primaires empilés ne hiérarchisent plus
 *   rien, et c'est le bloc « à venir » qui commande l'écran.
 * - **L'action appartient au vide** : une moitié peuplée ne la rend pas, sans
 *   quoi l'écran gagnerait un bouton à chaque section.
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

function appointment(): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: service.id,
    staffId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2e',
    clientId: '9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2f',
    startsAt: '2026-09-21T08:00:00.000Z',
    endsAt: '2026-09-21T09:00:00.000Z',
    price: { amountMinor: 3500, currency: 'EUR' },
    clientNote: null,
    rescheduledFromId: null,
    cancelledAt: null,
    cancelledBy: null,
  };
}

function servir(upcoming: readonly BookedAppointment[], past: readonly BookedAppointment[]): void {
  fetchPublicTenant.mockResolvedValue(tenant);
  fetchPublicServices.mockResolvedValue([service]);
  fetchMyAppointments.mockImplementation((_token: string, query: { scope?: string }) =>
    Promise.resolve(query.scope === 'past' ? [...past] : [...upcoming]),
  );
}

async function rendreLaPage(): Promise<HTMLElement> {
  const { container } = render(
    await AccountPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }),
  );

  return container;
}

afterEach(() => {
  cleanup();
  fetchMyAppointments.mockReset();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
});

describe("les états vides de l'espace client à la première visite", () => {
  it('offre le rendez-vous que la phrase du bloc « à venir » appelle déjà', async () => {
    servir([], []);

    await rendreLaPage();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });
    const action = within(aVenir).getByRole('link', { name: 'Prendre rendez-vous' });

    expect(action.getAttribute('href')).toBe(`/${tenant.slug}/reservation`);
  });

  it('offre aussi une sortie au bloc « Historique », que la capture montrait muet', async () => {
    servir([], []);

    await rendreLaPage();

    const historique = screen.getByRole('region', { name: 'Historique' });
    const action = within(historique).getByRole('link', { name: 'Découvrir les prestations' });

    // La vitrine, et non le tunnel : l'historique se remplit d'un rendez-vous,
    // et un rendez-vous commence par le choix d'un soin. Répéter à l'identique
    // le bouton du bloc du dessus donnerait deux fois la même phrase empilée.
    expect(action.getAttribute('href')).toBe(`/${tenant.slug}`);
  });

  it("garde l'explication à côté de l'action — la règle exige les deux", async () => {
    servir([], []);

    await rendreLaPage();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });
    const historique = screen.getByRole('region', { name: 'Historique' });

    expect(within(aVenir).getByText('Aucun rendez-vous à venir')).toBeDefined();
    expect(within(aVenir).getByText(/réserver votre prochaine visite/i)).toBeDefined();
    expect(within(historique).getByText('Votre historique est vide')).toBeDefined();
    expect(
      within(historique).getByText(/quittera la liste « Rendez-vous à venir »/i),
    ).toBeDefined();
  });

  it('ne laisse aucun bloc vide de la page sans quelque chose à cliquer', async () => {
    servir([], []);

    const container = await rendreLaPage();

    const vides = [...container.querySelectorAll('.spa-empty')];

    // Deux blocs vides, c'est la situation de la capture : si une troisième
    // moitié apparaissait un jour, elle tomberait sous la même règle.
    expect(vides).toHaveLength(2);
    for (const vide of vides) {
      expect(vide.querySelector('a[href]')).not.toBeNull();
    }
  });

  it("ne met l'accent que sur une seule des deux sorties", async () => {
    servir([], []);

    const container = await rendreLaPage();

    const accents = container.querySelectorAll('.spa-empty .spa-button--accent');

    expect(accents).toHaveLength(1);
    expect(accents[0]?.textContent).toBe('Prendre rendez-vous');
  });

  it("n'ajoute l'action qu'au vide : une moitié peuplée n'en porte pas", async () => {
    servir([appointment()], []);

    await rendreLaPage();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });
    const historique = screen.getByRole('region', { name: 'Historique' });

    expect(within(aVenir).queryByRole('link', { name: 'Prendre rendez-vous' })).toBeNull();
    // L'autre moitié, elle, est bien vide : sa sortie reste.
    expect(within(historique).getByRole('link', { name: 'Découvrir les prestations' })).toBeDefined();
  });
});
