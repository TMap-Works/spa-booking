import type { Service } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * La liste du catalogue dit d'une prestation si elle est réservable — #885, #895.
 *
 * Ce que ce fichier tient, et que le reste de la chaîne ne peut pas tenir seul :
 *
 * 1. le badge **apparaît** sur la prestation qu'aucun praticien actif ne pratique
 *    et **seulement** sur elle — c'est le critère d'acceptation, et il ne se déduit
 *    d'aucun type ;
 * 2. le libellé de l'absence d'affectation est **celui de la vitrine**, importé du
 *    même module. L'assertion porte sur la constante et non sur une chaîne
 *    recopiée : recopier ici aurait laissé le test passer le jour où les deux
 *    écrans divergent, c'est-à-dire exactement le jour où il devrait échouer ;
 * 3. le badge se fonde sur `activeAssignedStaffCount` et non sur
 *    `assignedStaffCount` : une prestation dont le seul praticien affecté est
 *    désactivé n'offre aucun créneau, et la liste le dit comme l'aperçu public le
 *    dit (#895). Elle le dit dans d'autres mots, et c'est le quatrième point ;
 * 4. elle n'annonce pas « aucun praticien » quand il y en a un, fût-il désactivé :
 *    la fiche le liste sous « Compte désactivé », et #885 a posé que la liste ne
 *    devait pas contredire la fiche qu'elle ouvre ;
 * 5. le signal est **écrit** — le texte est dans l'arbre accessible, et non porté
 *    par la seule couleur (WCAG 1.4.1) ;
 * 6. la page ne rappelle **pas** le point d'entrée public pour recomposer les
 *    comptes. C'est la dérive que #885 a écartée : `listPublicServices` ne rend que
 *    les prestations actives, et cette liste montre aussi les autres.
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
import { INACTIVE_STAFF_SERVICE_LABEL } from '@/app/(admin)/[tenantSlug]/admin/components/service-bookability-badge';
import { UNSTAFFED_SERVICE_LABEL } from '@/components/salon/service-catalog';

const SLUG = 'salon-lotus';

/**
 * `activeAssignedStaffCount` suit `assignedStaffCount` tant qu'on ne dit rien :
 * le cas courant est celui d'un salon dont les praticiens sont actifs, et obliger
 * chaque cas de test à répéter les deux comptes ferait passer le cas intéressant —
 * celui où ils diffèrent — pour du bruit. Le préciser reste possible, et c'est
 * exactement ce que fait le test de #895.
 */
function prestation(overrides: Partial<Service> = {}): Service {
  const assignedStaffCount = overrides.assignedStaffCount ?? 1;

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
    assignedStaffCount,
    activeAssignedStaffCount: assignedStaffCount,
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

/**
 * Le cas de #895 : la prestation *est* rattachée à quelqu'un, et n'est pourtant
 * pas réservable. C'est le seul état où les deux comptes divergent, et c'est celui
 * qui faisait taire la liste pendant que l'aperçu public annonçait la prestation
 * injoignable.
 */
describe('catalogue — une prestation dont les praticiens sont tous désactivés', () => {
  it('annonce l’absence de créneau, comme l’aperçu public', async () => {
    fetchServices.mockResolvedValue([
      prestation({ assignedStaffCount: 1, activeAssignedStaffCount: 0 }),
    ]);

    render(await ouvrirLeCatalogue());

    // La conclusion est mot pour mot celle de la vitrine — c'est elle qui doit
    // coïncider d'un écran à l'autre.
    expect(screen.getByText(INACTIVE_STAFF_SERVICE_LABEL)).toBeTruthy();
    expect(INACTIVE_STAFF_SERVICE_LABEL.endsWith('pas de créneau en ligne')).toBe(true);
    expect(UNSTAFFED_SERVICE_LABEL.endsWith('pas de créneau en ligne')).toBe(true);
  });

  it('ne prétend pas qu’aucun praticien n’est affecté', async () => {
    fetchServices.mockResolvedValue([
      prestation({ assignedStaffCount: 2, activeAssignedStaffCount: 0 }),
    ]);

    render(await ouvrirLeCatalogue());

    // La fiche liste ces deux praticiens, sous « Compte désactivé » : la liste qui
    // l'ouvre ne peut pas dire qu'il n'y en a aucun (#885).
    expect(screen.queryByText(UNSTAFFED_SERVICE_LABEL)).toBeNull();
  });

  it('se tait dès qu’un seul praticien actif subsiste', async () => {
    fetchServices.mockResolvedValue([
      prestation({ assignedStaffCount: 3, activeAssignedStaffCount: 1 }),
    ]);

    render(await ouvrirLeCatalogue());

    expect(screen.queryByText(INACTIVE_STAFF_SERVICE_LABEL)).toBeNull();
    expect(screen.queryByText(UNSTAFFED_SERVICE_LABEL)).toBeNull();
  });
});
