import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L'état « introuvable » de la fiche praticien — #696.
 *
 * Deux défauts se répondaient ici, et ce fichier tient les deux :
 *
 * 1. un identifiant **mal formé** partait jusqu'à l'API, dont le `ParseUUIDPipe`
 *    rend 400 — statut que la cascade de la page ne distinguait pas, et qui
 *    finissait en « Validation failed (uuid is expected) », en anglais, sous
 *    « Fiche indisponible » ;
 * 2. un identifiant **inconnu** appelait bien `notFound()`, mais aucune frontière
 *    ne le recevait à ce segment : l'appel remontait jusqu'à `app/not-found.tsx`,
 *    la page d'adresse inconnue **des clientes**, hors du back-office et sans le
 *    moindre lien de retour.
 *
 * La page et sa frontière sont donc éprouvées ensemble : l'une décide, l'autre
 * affiche, et séparées elles ne prouveraient ni que le 404 se déclenche, ni qu'il
 * mène quelque part.
 */

const fetchAdminAvailability = vi.fn();
const fetchOwnProfile = vi.fn();
const fetchServiceStaff = vi.fn();
const fetchServices = vi.fn();
const fetchStaffMembers = vi.fn();
const fetchStaffSchedule = vi.fn();
const fetchStaffTimeOff = vi.fn();

// Le module réel est repris et **seules les lectures** sont remplacées :
// `ApiClientError` doit rester la vraie classe, faute de quoi le `instanceof` de
// la page ne reconnaîtrait pas le 404.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchAdminAvailability: (...args: unknown[]) => fetchAdminAvailability(...args),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchServiceStaff: (...args: unknown[]) => fetchServiceStaff(...args),
  fetchServices: (...args: unknown[]) => fetchServices(...args),
  fetchStaffMembers: (...args: unknown[]) => fetchStaffMembers(...args),
  fetchStaffSchedule: (...args: unknown[]) => fetchStaffSchedule(...args),
  fetchStaffTimeOff: (...args: unknown[]) => fetchStaffTimeOff(...args),
}));

const notFound = vi.fn();
const adminLoadFailure = vi.fn();

/** L'URL que la frontière lira : chaque test la pose avant de rendre. */
let cheminCourant = '/salon-lotus/admin/personnel/pas-un-uuid';

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

import StaffMemberNotFound from '@/app/(admin)/[tenantSlug]/admin/personnel/[staffId]/not-found';
import StaffMemberPage from '@/app/(admin)/[tenantSlug]/admin/personnel/[staffId]/page';
import { ApiClientError } from '@/lib/api-client';

const TOKEN = 'jeton-de-session-du-comptoir';
const SLUG = 'salon-lotus';
const PRATICIENNE = '33333333-3333-4333-8333-333333333333';
const INCONNUE = '00000000-0000-4000-8000-000000000000';

function ouvrirLaFiche(staffId: string) {
  return StaffMemberPage({ params: Promise.resolve({ tenantSlug: SLUG, staffId }) });
}

beforeEach(() => {
  cheminCourant = `/${SLUG}/admin/personnel/pas-un-uuid`;

  fetchOwnProfile.mockResolvedValue({ id: 'compte-1', role: 'manager' });
  fetchStaffMembers.mockResolvedValue([
    { id: PRATICIENNE, displayName: 'Hanta R.', isActive: true },
  ]);
  fetchStaffSchedule.mockResolvedValue({
    staffId: PRATICIENNE,
    timezone: 'Indian/Antananarivo',
    entries: [],
  });
  fetchStaffTimeOff.mockResolvedValue([]);
  fetchServices.mockResolvedValue([]);
  fetchServiceStaff.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('fiche praticien — les trois façons de ne pas trouver la fiche', () => {
  /**
   * Le cœur du ticket : un identifiant mal formé ne doit **pas** atteindre
   * l'API. `adminLoadFailure` est ce qui rendait « Validation failed (uuid is
   * expected) » ; l'affirmer muet est la seule façon de prouver que ce message
   * ne peut plus s'afficher.
   */
  it.each(['pas-un-uuid', '', '  ', '33333333-3333-3333-8333-333333333333'])(
    'un identifiant hors contrat (%j) part en 404 sans un seul appel d’API',
    async (staffId) => {
      await expect(ouvrirLaFiche(staffId)).rejects.toThrow('NEXT_NOT_FOUND');

      expect(notFound).toHaveBeenCalled();
      expect(adminLoadFailure).not.toHaveBeenCalled();
      expect(fetchStaffSchedule).not.toHaveBeenCalled();
      expect(fetchStaffMembers).not.toHaveBeenCalled();
      expect(fetchOwnProfile).not.toHaveBeenCalled();
    },
  );

  /** Un 404 de l'API — fiche supprimée, ou fiche d'un autre établissement. */
  it('un 404 de l’API part en 404, pas en écran d’erreur', async () => {
    fetchStaffSchedule.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Praticien introuvable.', 404),
    );

    await expect(ouvrirLaFiche(INCONNUE)).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
    expect(adminLoadFailure).not.toHaveBeenCalled();
  });

  /**
   * Une fiche absente de l'annuaire de l'établissement sans que l'API n'ait
   * refusé : le troisième chemin, et il doit rendre exactement le même écran.
   */
  it('une fiche absente de l’annuaire part en 404', async () => {
    fetchStaffMembers.mockResolvedValue([]);

    await expect(ouvrirLaFiche(INCONNUE)).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
  });
});

describe('frontière « Praticien introuvable »', () => {
  it('parle de la fiche, en français, et non d’une adresse inconnue', () => {
    render(<StaffMemberNotFound />);

    expect(screen.getByText('Praticien introuvable')).toBeDefined();
    expect(document.body.textContent).not.toContain('uuid is expected');
    expect(document.body.textContent).not.toContain('Vérifiez le lien');
  });

  it('offre le retour vers le personnel de l’établissement de l’URL', () => {
    render(<StaffMemberNotFound />);

    const retour = screen.getByRole('link', { name: 'Revenir au personnel' });

    expect(retour.getAttribute('href')).toBe(`/${SLUG}/admin/personnel`);
  });

  /**
   * Le slug est réencodé par `adminStaffPath` : sans le décodage de
   * `usePathname()`, il le serait deux fois et le lien pointerait à côté.
   */
  it('décode le slug de l’URL avant de reconstruire le chemin', () => {
    cheminCourant = '/salon%20lotus/admin/personnel/pas-un-uuid';

    render(<StaffMemberNotFound />);

    expect(screen.getByRole('link').getAttribute('href')).toBe('/salon%20lotus/admin/personnel');
  });

  /**
   * Un chemin sans slug lisible ne doit produire **aucun** lien : `//admin/...`
   * serait lu par le navigateur comme l'URL absolue `https://admin/...`, et la
   * seule issue de l'écran sortirait du site.
   */
  it.each([
    ['sans premier segment', '/'],
    ['avec une séquence non décodable', '/%E0%A4%A/admin/personnel/pas-un-uuid'],
  ])('ne fabrique aucun lien %s', (_cas, chemin) => {
    cheminCourant = chemin;

    render(<StaffMemberNotFound />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Praticien introuvable')).toBeDefined();
  });
});
