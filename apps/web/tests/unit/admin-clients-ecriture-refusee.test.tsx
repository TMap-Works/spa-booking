import type {
  Customer,
  CustomerPage,
  CustomerSummary,
  CustomerVisitHistory,
  Permission,
  PublicTenant,
} from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Les phrases sont **lues** au catalogue et jamais recopiées : une suite qui
// citerait le littéral resterait verte le jour où l'écran cesserait de consulter
// la table (même règle que `admin-clients-historique-refuse`).
import clientsFr from '@/messages/fr/admin-clients.json';

/**
 * La fiche cliente devant un rang qui lit sans écrire — #1423.
 *
 * ## Le défaut que cette suite ferme
 *
 * Depuis #1416, la fiche survit au refus de l'historique agrégé : elle est donc
 * atteignable au rang `STAFF` pour la première fois. Du même coup, les deux
 * formulaires d'écriture de cet écran le sont devenus — « Modifier les
 * coordonnées » et « Enregistrer la note » —, et tous deux postent
 * `updateCustomerAction` → `PATCH /api/v1/customers/:id`, au seuil
 * `customers:write` que l'ADR 0013 réserve à `MANAGER` et `ADMIN`. Une
 * praticienne saisissait, cliquait, et ne récoltait qu'un refus.
 *
 * ## Ce qui est éprouvé, et dans les deux sens
 *
 * 1. sans `customers:write`, **aucun des deux formulaires n'est rendu** — et pas
 *    seulement désactivé : ni champ, ni bouton dans le DOM. Un `textarea` grisé
 *    se réactive d'un clic dans les outils de développement, et promettrait
 *    encore un geste ;
 * 2. la **note reste lisible** pour autant : c'est ce que `customers:read:own`
 *    existe pour donner, et la masquer aurait retiré l'information qu'une
 *    praticienne vient chercher. Vide, elle se dit en toutes lettres plutôt que
 *    de laisser un bloc muet ;
 * 3. avec `customers:write`, **rien ne change** : les deux formulaires sont là,
 *    et la non-régression du rang gérante fait partie du ticket ;
 * 4. l'appel d'historique dont le 403 est acquis d'avance **ne part plus** quand
 *    la liste dit déjà le refus ;
 * 5. une liste **illisible** — panne de `GET /auth/me` — ferme les écritures et
 *    laisse partir les lectures : on ne propose pas un geste sur un doute, et on
 *    ne prive pas une gérante de son agrégat pour une panne voisine.
 *
 * La garde d'affichage ne remplace pas celle de l'API, et cette suite ne le
 * prétend pas : `PATCH /customers/:id` continue d'exiger `customers:write` pour
 * tout le monde (`apps/api/src/modules/identity/permissions.ts`, éprouvé par
 * `identity/__tests__/route-permissions.spec.ts`).
 *
 * La langue est celle de l'amorce des suites (`fr`) : ce qui est éprouvé ici est
 * la **branche de rendu**, et la variante anglaise de ces phrases l'est par
 * `admin-clients-i18n`.
 */

const fetchPublicTenant = vi.fn();
const searchCustomers = vi.fn();
const fetchCustomer = vi.fn();
const fetchCustomerHistory = vi.fn();
const loadAdminShell = vi.fn();
const updateCustomerAction = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
  searchCustomers: (...args: unknown[]) => searchCustomers(...args),
  fetchCustomer: (...args: unknown[]) => fetchCustomer(...args),
  fetchCustomerHistory: (...args: unknown[]) => fetchCustomerHistory(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/clients/actions', () => ({
  updateCustomerAction: (...args: unknown[]) => updateCustomerAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/guard', () => ({
  requireAdminAccessToken: () => Promise.resolve('jeton-de-la-praticienne'),
  adminLoadFailure: () => <p>écran de refus d’accès</p>,
}));

/**
 * Le shell du back-office — la seule source des permissions effectives.
 *
 * Doublé plutôt que reconstitué : la vraie fonction lit le cookie de session et
 * appelle trois routes, et c'est `cache` qui la mémoïse. Ce que cette suite doit
 * pouvoir varier est sa **sortie**, rang par rang.
 */
vi.mock('@/app/(admin)/[tenantSlug]/admin/layout', () => ({
  loadAdminShell: (...args: unknown[]) => loadAdminShell(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/clients',
}));

import ClientsPage from '@/app/(admin)/[tenantSlug]/admin/clients/page';

const SLUG = 'salon-lotus';
const FICHE_ID = '11111111-1111-4111-8111-111111111111';

/** Ce que l'API sert à une praticienne : la fiche, jamais l'écriture dessus. */
const PERMISSIONS_PRATICIENNE: readonly Permission[] = [
  'agenda:read:own',
  'appointment:write:own',
  'customers:read:own',
];

/** Et ce qu'elle sert à une gérante — l'écran d'avant #1423, inchangé. */
const PERMISSIONS_GERANTE: readonly Permission[] = [
  ...PERMISSIONS_PRATICIENNE,
  'agenda:read:all',
  'appointment:write:all',
  'customers:read:all',
  'customers:write',
  'checkout:collect',
  'reporting:read',
];

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
  internalNote: 'Peau réactive — huiles neutres uniquement.',
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

const HISTORIQUE: CustomerVisitHistory = {
  summary: {
    totalVisits: 1,
    honoredVisits: 1,
    cancelledVisits: 0,
    rescheduledVisits: 0,
    noShowVisits: 0,
    upcomingVisits: 0,
    firstVisitAt: '2026-03-04T09:00:00.000Z',
    lastVisitAt: '2026-03-04T09:00:00.000Z',
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
  loadAdminShell.mockResolvedValue({ permissions: PERMISSIONS_PRATICIENNE });
});

afterEach(() => {
  cleanup();
  fetchPublicTenant.mockReset();
  searchCustomers.mockReset();
  fetchCustomer.mockReset();
  fetchCustomerHistory.mockReset();
  loadAdminShell.mockReset();
  updateCustomerAction.mockReset();
});

async function ouvrirFiche(): Promise<React.ReactElement> {
  return ClientsPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve({ fiche: FICHE_ID }),
  }) as unknown as Promise<React.ReactElement>;
}

describe('sans customers:write, la fiche ne propose aucune écriture', () => {
  it('ne rend pas l’édition des coordonnées, et garde les coordonnées lisibles', async () => {
    render(await ouvrirFiche());

    // Le geste disparaît, pas la donnée : c'est l'en-tête de la fiche qui porte
    // le numéro et l'adresse, et il ne vient pas du formulaire.
    expect(screen.queryByRole('button', { name: clientsFr.contact.edit })).toBeNull();
    expect(screen.getByText(RESUME.email)).toBeDefined();
    const { formatPhoneForDisplay } = await import('@/lib/phone');
    expect(screen.getByText(formatPhoneForDisplay(RESUME.phone ?? ''))).toBeDefined();
  });

  it('ne rend ni champ ni bouton pour la note, mais en montre le texte', async () => {
    render(await ouvrirFiche());

    // Pas de champ **du tout** : `queryByLabelText` couvre le `textarea`
    // désactivé autant que le champ actif, et c'est bien l'absence qu'on exige.
    expect(screen.queryByLabelText(new RegExp(clientsFr.note.label))).toBeNull();
    expect(screen.queryByRole('button', { name: clientsFr.note.save })).toBeNull();
    expect(screen.queryByRole('textbox', { name: new RegExp(clientsFr.note.label) })).toBeNull();

    // La note elle-même reste là — titre, mention de confidentialité, contenu.
    expect(screen.getByRole('heading', { name: new RegExp(clientsFr.note.title) })).toBeDefined();
    expect(screen.getByText(clientsFr.note.private)).toBeDefined();
    expect(screen.getByText(FICHE.internalNote ?? '')).toBeDefined();
    expect(screen.getByText(clientsFr.note.readOnly.hint)).toBeDefined();
  });

  it('dit l’absence de note en toutes lettres, plutôt qu’un bloc muet', async () => {
    fetchCustomer.mockResolvedValue({ ...FICHE, internalNote: null });
    render(await ouvrirFiche());

    expect(screen.getByText(clientsFr.note.readOnly.emptyTitle)).toBeDefined();
    expect(screen.getByText(clientsFr.note.readOnly.emptyDescription)).toBeDefined();
    // L'état vide porte déjà l'explication : la légende de lecture seule ne s'y
    // ajoute pas, et le champ n'est pas revenu par la porte du vide.
    expect(screen.queryByText(clientsFr.note.readOnly.hint)).toBeNull();
    expect(screen.queryByLabelText(new RegExp(clientsFr.note.label))).toBeNull();
  });

  it('traite une note blanche comme une note absente', async () => {
    // Le formulaire n'envoie jamais la chaîne vide — il la convertit en `null`
    // pour effacer —, mais `longTextSchema` l'accepte à l'API : une fiche peut
    // donc porter une note qui ne contient rien. Un cadre vide serait exactement
    // le bloc muet que l'état vide existe pour éviter.
    fetchCustomer.mockResolvedValue({ ...FICHE, internalNote: '   \n  ' });
    render(await ouvrirFiche());

    expect(screen.getByText(clientsFr.note.readOnly.emptyTitle)).toBeDefined();
    expect(screen.queryByText(clientsFr.note.readOnly.hint)).toBeNull();
  });

  it('n’appelle pas l’historique agrégé, dont le refus est acquis d’avance', async () => {
    render(await ouvrirFiche());

    // L'aller-retour évité est celui d'une requête dont on connaissait la
    // réponse ; le bloc rendu est exactement celui de #1416.
    expect(fetchCustomerHistory).not.toHaveBeenCalled();
    expect(screen.getByText(clientsFr.record.history.restrictedTitle)).toBeDefined();
  });
});

describe('avec customers:write, l’écran est inchangé', () => {
  beforeEach(() => {
    loadAdminShell.mockResolvedValue({ permissions: PERMISSIONS_GERANTE });
  });

  it('rend les deux formulaires d’écriture et l’historique complet', async () => {
    render(await ouvrirFiche());

    expect(screen.getByRole('button', { name: clientsFr.contact.edit })).toBeDefined();
    const note = screen.getByLabelText(
      new RegExp(clientsFr.note.label),
    ) as HTMLTextAreaElement;
    expect(note.value).toBe(FICHE.internalNote);
    expect(note.disabled).toBe(false);
    expect(screen.getByRole('button', { name: clientsFr.note.save })).toBeDefined();

    // L'agrégat est demandé, et la lecture seule ne s'affiche nulle part.
    expect(fetchCustomerHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(clientsFr.note.readOnly.hint)).toBeNull();
    expect(screen.queryByText(clientsFr.record.history.restrictedTitle)).toBeNull();
  });
});

describe('quand la liste des permissions n’a pas pu être lue', () => {
  it('ferme les écritures sans priver l’écran de ses lectures', async () => {
    // Une panne de `GET /auth/me` pendant que les autres lectures passent :
    // `loadAdminShell` rend un shell sans permissions, voire rien du tout.
    loadAdminShell.mockResolvedValue({ permissions: null });
    render(await ouvrirFiche());

    // Pas de formulaire sur un doute — proposer « Enregistrer » sur une liste
    // qu'on n'a pas lue reposerait le défaut de #1423 sur un autre incident.
    expect(screen.queryByRole('button', { name: clientsFr.contact.edit })).toBeNull();
    expect(screen.queryByLabelText(new RegExp(clientsFr.note.label))).toBeNull();
    // La note est lisible, mais la légende se tait : « en lecture seule pour
    // votre rôle » serait faux pour une gérante que seule une panne prive de ses
    // formulaires — elle lit l'agrégat juste en dessous.
    expect(screen.getByText(FICHE.internalNote ?? '')).toBeDefined();
    expect(screen.queryByText(clientsFr.note.readOnly.hint)).toBeNull();
    // Mais la lecture part quand même : son refus est déjà rattrapé, et
    // s'abstenir priverait une gérante de son agrégat pour une panne voisine.
    expect(fetchCustomerHistory).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Massage suédois')).toBeDefined();
  });

  it('se passe entièrement du shell quand il n’y en a pas', async () => {
    loadAdminShell.mockResolvedValue(null);
    render(await ouvrirFiche());

    expect(screen.queryByRole('button', { name: clientsFr.contact.edit })).toBeNull();
    expect(screen.getByText(FICHE.internalNote ?? '')).toBeDefined();
    expect(fetchCustomerHistory).toHaveBeenCalledTimes(1);
  });
});
