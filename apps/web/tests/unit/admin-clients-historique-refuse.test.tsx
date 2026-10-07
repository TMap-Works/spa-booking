import type {
  Customer,
  CustomerPage,
  CustomerSummary,
  CustomerVisitHistory,
  PublicTenant,
} from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Les phrases sont **lues** au catalogue et jamais recopiées : une suite qui
// citerait le littéral resterait verte le jour où l'écran cesserait de consulter
// la table (même règle que `admin-client-picker-refus`).
import clientsFr from '@/messages/fr/admin-clients.json';

/**
 * Le fichier client devant un rang qui n'ouvre pas l'historique agrégé — #1416.
 *
 * ## Le défaut que cette suite ferme
 *
 * Les trois lectures de cet écran n'ont pas le même seuil : `GET /customers` et
 * `GET /customers/:id` s'ouvrent dès `customers:read:own`, quand
 * `GET /customers/:id/history` exige `customers:read:all`. Une praticienne —
 * rang `STAFF` — recevait donc 200, 200 puis **403**, et ce 403 passait par la
 * cascade commune : `adminLoadFailure` remplaçait l'écran entier par « Accès
 * refusé » alors que les deux tiers de la fiche venaient d'arriver.
 *
 * Quatre cas, et ils tiennent ensemble la frontière du rattrapage :
 *
 * 1. le 403 de l'historique **seul** ne ferme plus rien — la fiche reste, et le
 *    bloc d'historique porte un état explicite ;
 * 2. tout ce qui dérive de l'agrégat disparaît du même geste — compteurs, avis
 *    d'absences, légende du récapitulatif : les afficher à zéro aurait été plus
 *    faux que de ne pas les afficher ;
 * 3. un 403 sur la **fiche** reste un vrai refus d'accès, et l'écran de refus
 *    revient. C'est la régression que le correctif aurait pu introduire ;
 * 4. les autres statuts de l'historique — une panne de l'API — ne se déguisent
 *    pas en refus de rôle.
 *
 * La langue est celle de l'amorce des suites (`fr`) : ce qui est éprouvé ici est
 * la **branche de rendu**, et la variante anglaise de ces phrases l'est par
 * `admin-clients-i18n`.
 */

const fetchPublicTenant = vi.fn();
const searchCustomers = vi.fn();
const fetchCustomer = vi.fn();
const fetchCustomerHistory = vi.fn();
const adminLoadFailure = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
  searchCustomers: (...args: unknown[]) => searchCustomers(...args),
  fetchCustomer: (...args: unknown[]) => fetchCustomer(...args),
  fetchCustomerHistory: (...args: unknown[]) => fetchCustomerHistory(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/clients/actions', () => ({
  updateCustomerAction: vi.fn(),
}));

/**
 * La garde est doublée pour une seule raison : savoir si elle a été **appelée**.
 *
 * C'est exactement ce que le défaut faisait de travers, et aucune assertion sur
 * le texte rendu ne l'aurait dit aussi précisément — l'écran de refus et l'état
 * d'historique indisponible se seraient distingués par leurs phrases, pas par la
 * décision qui les a produits.
 */
vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-de-la-praticienne'),
  adminLoadFailure: (...args: unknown[]) => {
    adminLoadFailure(...args);

    return <p>écran de refus d’accès</p>;
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/clients',
}));

/**
 * Le shell du back-office, dont l'écran lit les permissions effectives depuis
 * #1423.
 *
 * Il rend ici la liste d'une **gérante**, et ce n'est pas une contradiction avec
 * la praticienne que cette suite met en scène : ce qu'elle éprouve est le
 * rattrapage du 403, c'est-à-dire le filet qui agit quand la liste et l'API ne
 * disent pas la même chose — liste illisible, droit retiré entre deux rendus,
 * seuil de route changé côté serveur. Avec une liste qui annonce déjà le refus,
 * l'appel ne partirait pas et il n'y aurait plus de 403 à rattraper : c'est
 * `admin-clients-ecriture-refusee` qui couvre ce chemin-là.
 */
vi.mock('@/app/(admin)/[tenantSlug]/admin/layout', () => ({
  loadAdminShell: () =>
    Promise.resolve({
      permissions: ['customers:read:own', 'customers:read:all', 'customers:write'],
    }),
}));

import ClientsPage from '@/app/(admin)/[tenantSlug]/admin/clients/page';

const SLUG = 'salon-lotus';
const FICHE_ID = '11111111-1111-4111-8111-111111111111';

const TENANT: PublicTenant = {
  id: '99999999-9999-4999-8999-999999999999',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
  address: {
    line1: '12 rue des Orchidées',
    city: 'Antananarivo',
    postalCode: '101',
    country: 'MG',
  },
};

const RESUME: CustomerSummary = {
  id: FICHE_ID,
  firstName: 'Fara',
  lastName: 'Rakotoson',
  email: 'fara.rakotoson@example.mg',
  phone: '+261341234567',
  isActive: true,
};

const FICHE: Customer = {
  ...RESUME,
  internalNote: 'Peau réactive.',
  createdAt: '2026-03-04T08:00:00.000Z',
  anonymizedAt: null,
  emailSuppressedAt: null,
  emailSuppressionReason: null,
  locale: 'fr',
};

const PAGE: CustomerPage = {
  items: [RESUME],
  page: 1,
  pageSize: 20,
  totalItems: 1,
  totalPages: 1,
};

/** Une absence au compteur : c'est l'avis qui doit disparaître avec l'agrégat. */
const HISTORIQUE: CustomerVisitHistory = {
  summary: {
    totalVisits: 2,
    honoredVisits: 1,
    cancelledVisits: 0,
    rescheduledVisits: 0,
    noShowVisits: 1,
    upcomingVisits: 0,
    firstVisitAt: '2026-03-04T09:00:00.000Z',
    lastVisitAt: '2026-04-02T09:00:00.000Z',
    totalSpent: { amountMinor: 3500, currency: 'EUR' },
  },
  visits: [
    {
      appointmentId: '22222222-2222-4222-8222-222222222222',
      status: 'completed',
      startsAt: '2026-03-04T14:00:00.000Z',
      endsAt: '2026-03-04T15:00:00.000Z',
      serviceName: 'Massage suédois',
      staffName: 'Hanta',
      price: { amountMinor: 3500, currency: 'EUR' },
      clientNote: null,
      cancelledBy: null,
      rescheduledFromId: null,
    },
  ],
};

beforeEach(() => {
  fetchPublicTenant.mockResolvedValue(TENANT);
  searchCustomers.mockResolvedValue(PAGE);
  fetchCustomer.mockResolvedValue(FICHE);
  fetchCustomerHistory.mockResolvedValue(HISTORIQUE);
});

afterEach(() => {
  cleanup();
  fetchPublicTenant.mockReset();
  searchCustomers.mockReset();
  fetchCustomer.mockReset();
  fetchCustomerHistory.mockReset();
  adminLoadFailure.mockReset();
});

async function ouvrirFiche(): Promise<React.ReactElement> {
  return ClientsPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({ fiche: FICHE_ID }),
  }) as unknown as Promise<React.ReactElement>;
}

/** Le refus que l'API oppose à `customers:read:all` sur une praticienne. */
async function refusDeRole(): Promise<Error> {
  const { ApiClientError } = await import('@/lib/api-client');

  return new ApiClientError('FORBIDDEN', 'permission manquante', 403);
}

describe('le 403 de l’historique agrégé est un refus partiel', () => {
  it('laisse la fiche à l’écran — coordonnées, langue, note interne', async () => {
    fetchCustomerHistory.mockRejectedValue(await refusDeRole());
    render(await ouvrirFiche());

    // La garde n'a pas été consultée : ce n'est pas un échec de chargement de
    // l'écran, et c'est précisément ce que le défaut en faisait.
    expect(adminLoadFailure).not.toHaveBeenCalled();
    // Le titre du volet nomme la fiche ouverte : il n'est rendu que par une
    // fiche réellement chargée, là où le nom seul se lit aussi dans la liste.
    expect(screen.getByRole('heading', { level: 2, name: /Fara Rakotoson/ })).toBeDefined();
    // L'adresse et le numéro sont rendus chacun dans son propre élément sur la
    // fiche ; la liste, elle, les réunit dans une seule ligne de coordonnées.
    expect(screen.getByText(RESUME.email)).toBeDefined();
    const { formatPhoneForDisplay } = await import('@/lib/phone');
    expect(screen.getByText(formatPhoneForDisplay(RESUME.phone ?? ''))).toBeDefined();
    // La note interne est bien chargée, pas seulement le nom : la fiche entière
    // a survécu au refus de l'autre lecture.
    const note = screen.getByLabelText(new RegExp(clientsFr.note.label)) as HTMLTextAreaElement;
    expect(note.value).toBe('Peau réactive.');
  });

  it('remplace le seul bloc d’historique par un état explicite', async () => {
    fetchCustomerHistory.mockRejectedValue(await refusDeRole());
    render(await ouvrirFiche());

    // Le titre de la section reste : c'est là que l'historique se cherche, et
    // l'escamoter aurait laissé croire que cet écran n'en montre jamais.
    expect(screen.getByRole('heading', { name: clientsFr.record.history.title })).toBeDefined();
    expect(screen.getByText(clientsFr.record.history.restrictedTitle)).toBeDefined();
    expect(screen.getByText(clientsFr.record.history.restrictedDescription)).toBeDefined();
    // Ni l'historique vide, ni l'historique rempli : l'absence de droit n'est
    // pas l'absence de visite.
    expect(screen.queryByText(clientsFr.record.history.emptyTitle)).toBeNull();
    expect(screen.queryByText('Massage suédois')).toBeNull();
  });

  it('retire tout ce que l’agrégat alimentait, plutôt que de l’afficher à zéro', async () => {
    fetchCustomerHistory.mockRejectedValue(await refusDeRole());
    render(await ouvrirFiche());

    // Les compteurs, la légende qui les explique et l'avis d'absences viennent
    // tous de `summary` : « 0 visite honorée · Total honoré — » sur une cliente
    // qui en compte deux aurait été un chiffre faux, pas une donnée manquante.
    expect(screen.queryByText(clientsFr.record.metrics.upcoming)).toBeNull();
    expect(screen.queryByText(clientsFr.record.metrics.totalSpent)).toBeNull();
    // La légende partage son paragraphe avec le récapitulatif compté : c'est
    // donc une inclusion qu'on cherche, pas une égalité de texte normalisé.
    expect(screen.queryByText((texte) => texte.includes(clientsFr.record.summary.caption))).toBeNull();
    expect(screen.queryByText(clientsFr.record.noShow.body)).toBeNull();
  });
});

describe('les refus que le rattrapage ne couvre pas', () => {
  it('rend l’écran de refus quand c’est la fiche elle-même qui est fermée', async () => {
    // Le rattrapage est borné à la lecture de l'historique : un 403 sur
    // `GET /customers/:id` ferme bien toute la fiche, et le masquer aurait fait
    // d'un refus d'accès une fiche vide sans explication.
    fetchCustomer.mockRejectedValue(await refusDeRole());
    fetchCustomerHistory.mockRejectedValue(await refusDeRole());
    render(await ouvrirFiche());

    expect(adminLoadFailure).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(clientsFr.record.history.restrictedTitle)).toBeNull();
  });

  it('ne déguise pas une panne de l’historique en refus de rôle', async () => {
    const { ApiClientError } = await import('@/lib/api-client');
    fetchCustomerHistory.mockRejectedValue(new ApiClientError('INTERNAL_ERROR', 'panne', 500));
    render(await ouvrirFiche());

    // Un 500 n'est pas un seuil de permission : l'écran doit dire la panne et
    // offrir une reprise, ce que seule la cascade commune sait faire.
    expect(adminLoadFailure).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(clientsFr.record.history.restrictedTitle)).toBeNull();
  });
});
