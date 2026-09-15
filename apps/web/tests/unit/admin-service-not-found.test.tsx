import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L'état « introuvable » de la fiche prestation — #697.
 *
 * Deux défauts se répondaient ici, et ce fichier tient les deux :
 *
 * 1. un identifiant **mal formé** partait jusqu'à l'API, dont le `ParseUUIDPipe`
 *    rend 400 — statut que la cascade de la page ne distinguait pas, et qui
 *    finissait dans la branche par défaut d'`adminLoadFailure` : le message brut
 *    de l'API, ou l'écran de connexion vide quand le jeton d'accès expirait dans
 *    la même seconde, sur une session pourtant valide ;
 * 2. un identifiant **inconnu** rendait bien l'encart, mais depuis `page.tsx` et
 *    donc sous un statut **200** : l'écran disait « introuvable » pendant que le
 *    protocole annonçait une prestation existante.
 *
 * La page et sa frontière sont donc éprouvées ensemble : l'une décide, l'autre
 * affiche, et séparées elles ne prouveraient ni que le 404 se déclenche, ni qu'il
 * mène quelque part.
 */

const fetchOwnProfile = vi.fn();
const fetchService = vi.fn();
const fetchServiceCategories = vi.fn();
const fetchServiceStaff = vi.fn();
const fetchStaffMembers = vi.fn();

// Le module réel est repris et **seules les lectures** sont remplacées :
// `ApiClientError` doit rester la vraie classe, faute de quoi le `instanceof` de
// la page ne reconnaîtrait pas le 404.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchService: (...args: unknown[]) => fetchService(...args),
  fetchServiceCategories: (...args: unknown[]) => fetchServiceCategories(...args),
  fetchServiceStaff: (...args: unknown[]) => fetchServiceStaff(...args),
  fetchStaffMembers: (...args: unknown[]) => fetchStaffMembers(...args),
}));

const notFound = vi.fn();
const adminLoadFailure = vi.fn();

/** L'URL que la frontière lira : chaque test la pose avant de rendre. */
let cheminCourant = '/salon-lotus/admin/catalogue/pas-un-uuid';

// `notFound()` lève dans Next : le double lève aussi, sans quoi la page
// poursuivrait après une navigation qu'elle croit terminée — et le test passerait
// sur un rendu que l'application ne produit jamais.
vi.mock('next/navigation', () => ({
  notFound: () => {
    notFound();
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
  usePathname: () => cheminCourant,
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve(TOKEN),
  adminLoadFailure: (...args: unknown[]) => {
    adminLoadFailure(...args);
    return null;
  },
}));

import ServiceNotFound from '@/app/(admin)/[tenantSlug]/admin/catalogue/[serviceId]/not-found';
import ServicePage from '@/app/(admin)/[tenantSlug]/admin/catalogue/[serviceId]/page';
import { ApiClientError } from '@/lib/api-client';

const TOKEN = 'jeton-de-session-du-comptoir';
const SLUG = 'salon-lotus';
const PRESTATION = '11111111-1111-4111-8111-111111111111';
const INCONNUE = '00000000-0000-4000-8000-000000000000';

function ouvrirLaFiche(serviceId: string) {
  return ServicePage({ params: Promise.resolve({ tenantSlug: SLUG, serviceId }) });
}

beforeEach(() => {
  cheminCourant = `/${SLUG}/admin/catalogue/pas-un-uuid`;

  fetchOwnProfile.mockResolvedValue({ id: 'compte-1', role: 'manager' });
  fetchService.mockResolvedValue({
    id: PRESTATION,
    name: 'Massage aux pierres chaudes',
    slug: 'massage-pierres-chaudes',
    isActive: true,
    occupiedMinutes: 75,
    price: { amount: 120000, currency: 'MGA' },
  });
  fetchServiceCategories.mockResolvedValue([]);
  fetchServiceStaff.mockResolvedValue([]);
  fetchStaffMembers.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('fiche prestation — les trois façons de ne pas trouver la prestation', () => {
  /**
   * Le cœur du ticket : un identifiant mal formé ne doit **pas** atteindre
   * l'API. `adminLoadFailure` est ce qui rendait le message brut du
   * `ParseUUIDPipe` — et, selon l'instant, la redirection vers la connexion ;
   * l'affirmer muet est la seule façon de prouver qu'aucun des deux ne peut plus
   * se produire.
   */
  it.each(['pas-un-uuid', '', '  ', '11111111-1111-1111-8111-111111111111'])(
    'un identifiant hors contrat (%j) part en 404 sans un seul appel d’API',
    async (serviceId) => {
      await expect(ouvrirLaFiche(serviceId)).rejects.toThrow('NEXT_NOT_FOUND');

      expect(notFound).toHaveBeenCalled();
      expect(adminLoadFailure).not.toHaveBeenCalled();
      expect(fetchService).not.toHaveBeenCalled();
      expect(fetchServiceStaff).not.toHaveBeenCalled();
      expect(fetchServiceCategories).not.toHaveBeenCalled();
      expect(fetchStaffMembers).not.toHaveBeenCalled();
      expect(fetchOwnProfile).not.toHaveBeenCalled();
    },
  );

  /**
   * Un 404 de l'API — prestation supprimée, ou prestation d'un autre
   * établissement. Il rendait l'encart depuis la page, donc sous un statut 200 ;
   * il doit maintenant lever, comme l'identifiant mal formé.
   */
  it('un 404 de l’API part en 404, et non en encart rendu sous un statut 200', async () => {
    fetchService.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Prestation introuvable.', 404),
    );

    await expect(ouvrirLaFiche(INCONNUE)).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
    expect(adminLoadFailure).not.toHaveBeenCalled();
  });

  /**
   * La contrepartie : ce ticket ne doit pas transformer en 404 ce qui n'en est
   * pas un. Un refus de rôle reste un refus de rôle, et il garde son écran.
   */
  it('un 403 reste un refus de rôle, pas un 404', async () => {
    fetchService.mockRejectedValue(new ApiClientError('FORBIDDEN', 'Accès refusé.', 403));

    await expect(ouvrirLaFiche(PRESTATION)).resolves.toBeNull();

    expect(notFound).not.toHaveBeenCalled();
    expect(adminLoadFailure).toHaveBeenCalled();
  });

  /** Et un identifiant bien formé et connu ouvre toujours la fiche. */
  it('un identifiant v4 connu atteint bien l’API', async () => {
    await ouvrirLaFiche(PRESTATION);

    expect(notFound).not.toHaveBeenCalled();
    expect(adminLoadFailure).not.toHaveBeenCalled();
    expect(fetchService).toHaveBeenCalledWith(TOKEN, PRESTATION);
  });
});

describe('frontière « Prestation introuvable »', () => {
  it('parle de la prestation, en français, et non d’une adresse inconnue', () => {
    render(<ServiceNotFound />);

    expect(screen.getByText('Prestation introuvable')).toBeDefined();
    expect(document.body.textContent).not.toContain('uuid is expected');
    expect(document.body.textContent).not.toContain('Vérifiez le lien');
  });

  it('offre le retour vers le catalogue de l’établissement de l’URL', () => {
    render(<ServiceNotFound />);

    const retour = screen.getByRole('link', { name: 'Revenir au catalogue' });

    expect(retour.getAttribute('href')).toBe(`/${SLUG}/admin/catalogue`);
  });

  /**
   * Le slug est réencodé par `adminCatalogPath` : sans le décodage de
   * `usePathname()`, il le serait deux fois et le lien pointerait à côté.
   */
  it('décode le slug de l’URL avant de reconstruire le chemin', () => {
    cheminCourant = '/salon%20lotus/admin/catalogue/pas-un-uuid';

    render(<ServiceNotFound />);

    expect(screen.getByRole('link').getAttribute('href')).toBe('/salon%20lotus/admin/catalogue');
  });

  /**
   * Un chemin sans slug lisible ne doit produire **aucun** lien : `//admin/...`
   * serait lu par le navigateur comme l'URL absolue `https://admin/...`, et la
   * seule issue de l'écran sortirait du site.
   */
  it.each([
    ['sans premier segment', '/'],
    ['avec une séquence non décodable', '/%E0%A4%A/admin/catalogue/pas-un-uuid'],
  ])('ne fabrique aucun lien %s', (_cas, chemin) => {
    cheminCourant = chemin;

    render(<ServiceNotFound />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Prestation introuvable')).toBeDefined();
  });
});
