import type { Service } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La liste du catalogue distingue une prestation que personne ne pratique — #885.
 *
 * Ce que ce fichier tient, et que le reste de la chaîne ne peut pas tenir seul :
 *
 * 1. le badge **apparaît** sur la prestation à zéro praticien et **seulement**
 *    sur elle — c'est le critère d'acceptation, et il ne se déduit d'aucun type ;
 * 2. le libellé est **celui de la vitrine**, importé du même module. L'assertion
 *    porte sur la constante et non sur une chaîne recopiée : recopier ici aurait
 *    laissé le test passer le jour où les deux écrans divergent, c'est-à-dire
 *    exactement le jour où il devrait échouer ;
 * 3. le signal est **écrit** — le texte est dans l'arbre accessible, et non porté
 *    par la seule couleur (WCAG 1.4.1) ;
 * 4. la page ne rappelle **pas** le point d'entrée public pour recomposer le
 *    compte. C'est la dérive que l'issue a écartée : `listPublicServices` ne rend
 *    que les prestations actives et ne compte que les praticiens actifs, si bien
 *    que la liste se serait mise à contredire la fiche qu'elle ouvre.
 */

const fetchServices = vi.fn();
const fetchOwnProfile = vi.fn();
const fetchPublicServices = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : la page
// importe aussi `ApiClientError` par sa cascade d'erreurs.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchServices: (...args: unknown[]) => fetchServices(...args),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/catalogue',
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-de-session-du-comptoir'),
  adminLoadFailure: () => null,
}));

import CatalogPage from '@/app/(admin)/[tenantSlug]/admin/catalogue/(liste)/page';
import { UNSTAFFED_SERVICE_LABEL } from '@/components/salon/service-catalog';

const SLUG = 'salon-lotus';

function prestation(overrides: Partial<Service> = {}): Service {
  return {
    id: 'cccccccc-0000-4000-8000-000000000001',
    slug: 'massage-suedois',
    name: 'Massage suédois',
    description: null,
    category: null,
    durationMinutes: 60,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    occupiedMinutes: 75,
    price: { amountMinor: 3500, currency: 'EUR' },
    isActive: true,
    assignedStaffCount: 1,
    ...overrides,
  };
}

async function ouvrirLeCatalogue() {
  return CatalogPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({}),
  });
}

beforeEach(() => {
  fetchOwnProfile.mockResolvedValue({ id: 'compte-1', role: 'manager' });
  fetchServices.mockResolvedValue([prestation()]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('catalogue — une prestation active que personne ne pratique', () => {
  it('porte le libellé de la vitrine, et sur elle seule', async () => {
    fetchServices.mockResolvedValue([
      prestation({
        id: 'cccccccc-0000-4000-8000-000000000002',
        name: 'Soin orphelin',
        slug: 'soin-orphelin',
        assignedStaffCount: 0,
      }),
      prestation({ name: 'Massage suédois', assignedStaffCount: 2 }),
    ]);

    render(await ouvrirLeCatalogue());

    // Un seul badge pour deux prestations : celle qui a deux praticiens n'en
    // porte pas. Sans ce compte, les deux lignes seraient indiscernables.
    expect(screen.getAllByText(UNSTAFFED_SERVICE_LABEL)).toHaveLength(1);
    // Le signal est un texte, pas une teinte : un lecteur d'écran le restitue, et
    // un daltonien le lit (WCAG 1.4.1).
    expect(screen.getByText(UNSTAFFED_SERVICE_LABEL).textContent).toBe(UNSTAFFED_SERVICE_LABEL);
    // La prestation réservable garde son seul badge d'état.
    expect(screen.getAllByText('Active')).toHaveLength(2);
  });

  it('ne dit rien de tel d’une prestation que quelqu’un pratique', async () => {
    fetchServices.mockResolvedValue([prestation({ assignedStaffCount: 3 })]);

    render(await ouvrirLeCatalogue());

    expect(screen.queryByText(UNSTAFFED_SERVICE_LABEL)).toBeNull();
  });

  /**
   * Le badge ne regarde pas l'activité, comme la fiche ne la regarde pas : une
   * prestation désactivée que personne ne pratique n'offrira rien de plus le jour
   * où on la réactive, et c'est utile de l'apprendre avant de la remettre en
   * ligne.
   */
  it('le dit aussi d’une prestation désactivée, à côté de son état', async () => {
    fetchServices.mockResolvedValue([prestation({ isActive: false, assignedStaffCount: 0 })]);

    render(await ouvrirLeCatalogue());

    expect(screen.getByText('Désactivée')).toBeTruthy();
    expect(screen.getByText(UNSTAFFED_SERVICE_LABEL)).toBeTruthy();
  });

  it('tient le compte de l’API, sans second appel au catalogue public', async () => {
    fetchServices.mockResolvedValue([prestation({ assignedStaffCount: 0 })]);

    render(await ouvrirLeCatalogue());

    expect(screen.getByText(UNSTAFFED_SERVICE_LABEL)).toBeTruthy();
    expect(fetchServices).toHaveBeenCalledTimes(1);
    expect(fetchPublicServices).not.toHaveBeenCalled();
  });
});
