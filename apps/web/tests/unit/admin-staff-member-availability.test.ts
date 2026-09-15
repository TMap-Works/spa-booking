import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L'aperçu de créneaux de la fiche praticien — les quatre critères de #676.
 *
 * Ce qui se prouve ici n'est pas ce qui part sur le fil —
 * `admin-availability-api.test.ts` s'en charge depuis #642 —, mais **laquelle
 * des deux lectures la page choisit**, ce qu'elle lui passe, et ce qu'elle fait
 * de chacun des statuts que la route **gardée** rend réellement. La distinction
 * compte : les deux routes rendent la même charge utile, seule la porte les
 * sépare, et c'est la porte qui décide des refus.
 *
 * Les panneaux d'écriture ne sont pas doublés : la page ne fait que fabriquer
 * leurs éléments, elle ne les rend pas. Ce sont les lectures, la garde et la
 * navigation qui sont remplacées.
 */

const fetchAdminAvailability = vi.fn();
const fetchAvailability = vi.fn();
const fetchOwnProfile = vi.fn();
const fetchServiceStaff = vi.fn();
const fetchServices = vi.fn();
const fetchStaffMembers = vi.fn();
const fetchStaffSchedule = vi.fn();
const fetchStaffTimeOff = vi.fn();

// Le module réel est repris et **seules les lectures** sont remplacées :
// `ApiClientError` doit rester la vraie classe, faute de quoi ni le `instanceof`
// du `catch` de l'aperçu ni celui de la page ne reconnaîtraient les refus.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchAdminAvailability: (...args: unknown[]) => fetchAdminAvailability(...args),
  // La lecture publique reste exportée — c'est celle du tunnel de réservation —,
  // et elle est doublée ici précisément pour pouvoir affirmer que cette page ne
  // l'appelle plus (premier critère).
  fetchAvailability: (...args: unknown[]) => fetchAvailability(...args),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchServiceStaff: (...args: unknown[]) => fetchServiceStaff(...args),
  fetchServices: (...args: unknown[]) => fetchServices(...args),
  fetchStaffMembers: (...args: unknown[]) => fetchStaffMembers(...args),
  fetchStaffSchedule: (...args: unknown[]) => fetchStaffSchedule(...args),
  fetchStaffTimeOff: (...args: unknown[]) => fetchStaffTimeOff(...args),
}));

const notFound = vi.fn();
const adminLoadFailure = vi.fn();

// `notFound()` et `redirect()` lèvent dans Next : les doubles lèvent aussi, sans
// quoi la page poursuivrait après une navigation qu'elle croit terminée — et le
// test passerait sur un rendu que l'application ne produit jamais.
vi.mock('next/navigation', () => ({
  notFound: () => {
    notFound();
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve(TOKEN),
  adminLoadFailure: (...args: unknown[]) => {
    adminLoadFailure(...args);
    return null;
  },
}));

import StaffMemberPage from '@/app/(admin)/[tenantSlug]/admin/personnel/[staffId]/page';
import { ApiClientError } from '@/lib/api-client';

// Le jeton ne contient **pas** le slug en sous-chaîne : sans cette précaution,
// l'assertion « le slug ne part plus » passerait sur le jeton lui-même et ne
// prouverait rien.
const TOKEN = 'jeton-de-session-du-comptoir';
const SLUG = 'salon-lotus';
const PRATICIENNE = '33333333-3333-4333-8333-333333333333';
const SERVICE = '11111111-1111-4111-8111-111111111111';
const TIMEZONE = 'Indian/Antananarivo';

/** 2026-09-15 à 11 h à Antananarivo : la semaine d'aperçu court jusqu'au 21. */
const MAINTENANT = new Date('2026-09-15T08:00:00.000Z');
const AUJOURDHUI = '2026-09-15';
const SEPTIEME_JOUR = '2026-09-21';

const VUE = {
  serviceId: SERVICE,
  timezone: TIMEZONE,
  days: [
    {
      date: AUJOURDHUI,
      slots: [
        {
          startsAt: '2026-09-15T06:00:00.000Z',
          endsAt: '2026-09-15T07:00:00.000Z',
          staffId: PRATICIENNE,
        },
      ],
    },
  ],
};

function ouvrirLaFiche() {
  return StaffMemberPage({ params: Promise.resolve({ tenantSlug: SLUG, staffId: PRATICIENNE }) });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MAINTENANT);

  fetchOwnProfile.mockResolvedValue({ id: 'compte-1', role: 'manager' });
  fetchStaffMembers.mockResolvedValue([
    { id: PRATICIENNE, displayName: 'Hanta R.', isActive: true },
  ]);
  fetchStaffSchedule.mockResolvedValue({
    staffId: PRATICIENNE,
    timezone: TIMEZONE,
    entries: [],
  });
  fetchStaffTimeOff.mockResolvedValue([]);
  fetchServices.mockResolvedValue([{ id: SERVICE, name: 'Massage', isActive: true }]);
  fetchServiceStaff.mockResolvedValue([{ id: PRATICIENNE, displayName: 'Hanta R.' }]);
  fetchAdminAvailability.mockResolvedValue(VUE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('fiche praticien — aperçu des créneaux', () => {
  it('lit par la route gardée, avec le jeton de session', async () => {
    await ouvrirLaFiche();

    expect(fetchAdminAvailability).toHaveBeenCalledWith(TOKEN, {
      serviceId: SERVICE,
      staffId: PRATICIENNE,
      from: AUJOURDHUI,
      to: SEPTIEME_JOUR,
    });
  });

  it('n’appelle plus aucune route publique', async () => {
    await ouvrirLaFiche();

    expect(fetchAvailability).not.toHaveBeenCalled();
  });

  it('ne fait plus circuler le slug : l’établissement vient du jeton', async () => {
    await ouvrirLaFiche();

    expect(fetchAdminAvailability.mock.calls[0]).not.toContain(SLUG);
    expect(JSON.stringify(fetchAdminAvailability.mock.calls[0])).not.toContain(SLUG);
  });

  it('ne lit rien tant qu’aucune prestation active n’est affectée', async () => {
    fetchServiceStaff.mockResolvedValue([]);

    await ouvrirLaFiche();

    expect(fetchAdminAvailability).not.toHaveBeenCalled();
  });
});

describe('fiche praticien — les statuts de la route gardée', () => {
  /**
   * Les trois refus que l'aperçu absorbe. Sur la route publique, seul le 404
   * était possible ; la gardée y ajoute le 403, et le 422 n'a jamais dépendu de
   * la porte. Aucun des trois ne doit faire disparaître une fiche que
   * l'opérateur a le droit de voir.
   */
  it.each([
    ['404', new ApiClientError('NOT_FOUND', 'Prestation introuvable.', 404)],
    ['403', new ApiClientError('FORBIDDEN', 'Rang insuffisant.', 403)],
    ['422', new ApiClientError('AVAILABILITY_RANGE_TOO_WIDE', 'Plage trop large.', 422)],
  ])('un %s de l’aperçu laisse la fiche debout', async (_statut, refus) => {
    fetchAdminAvailability.mockRejectedValue(refus);

    await expect(ouvrirLaFiche()).resolves.not.toBeNull();

    expect(notFound).not.toHaveBeenCalled();
    expect(adminLoadFailure).not.toHaveBeenCalled();
  });

  /**
   * Le 401, lui, n'est pas un défaut d'aperçu : la session est morte, et les
   * panneaux d'écriture au-dessus le sont avec elle. Il remonte donc à la
   * cascade de la page, qui renvoie à la connexion.
   */
  it('un 401 de l’aperçu périme la page entière', async () => {
    const revoquee = new ApiClientError('UNAUTHORIZED', 'Session révoquée.', 401);
    fetchAdminAvailability.mockRejectedValue(revoquee);

    await ouvrirLaFiche();

    expect(adminLoadFailure).toHaveBeenCalledWith(revoquee, SLUG, expect.anything());
    expect(notFound).not.toHaveBeenCalled();
  });

  /**
   * Le 404 d'une **lecture d'ensemble** garde son sens d'origine : la fiche
   * n'existe pas, ou appartient à un autre établissement — indistinctement
   * (tenant-isolation §4). C'est ce que le `try` séparé de l'aperçu protège.
   */
  it('un 404 sur la fiche elle-même reste un 404', async () => {
    fetchStaffSchedule.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Praticien introuvable.', 404),
    );

    await expect(ouvrirLaFiche()).rejects.toThrow('NEXT_NOT_FOUND');

    expect(notFound).toHaveBeenCalled();
  });
});
