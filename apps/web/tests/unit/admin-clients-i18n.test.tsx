import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Customer,
  CustomerPage,
  CustomerSummary,
  CustomerVisitHistory,
  PublicTenant,
} from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nextIntlFixe, nextIntlServerFixe } from '../support/langue-figee';

/** Ce fichier, d'où part la racine d'`apps/web` lue par la garde de lint. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Le fichier client du back-office en français et en anglais — #852.
 *
 * ## Ce que cette suite protège, et que les suites françaises ne protègent pas
 *
 * - **L'écran se rend dans la langue de la session** : la recherche, la liste,
 *   la fiche, ses compteurs et son historique.
 * - **Les libellés comptés s'accordent selon la langue**, et non selon une
 *   bascule écrite en TypeScript. Le seuil du singulier n'est pas le même des
 *   deux côtés — « 0 visite honorée » en français, « 0 completed visits » en
 *   anglais —, et c'est ICU qui le sait : c'est exactement ce que `countedLabel`
 *   ne pouvait pas faire.
 * - **Les dates et les montants suivent la langue et la région**, sans changer
 *   d'instant ni d'entier : le fuseau reste celui de l'établissement (ADR 0006).
 * - **La langue préférée de la cliente est lue sur sa fiche**, et `null` s'y dit
 *   « non renseignée » plutôt que de se replier sur la langue du salon.
 * - **Le contenu saisi n'est pas traduit** : le nom d'une prestation, celui d'un
 *   praticien, la remarque écrite par la cliente.
 * - **Les refus de saisie viennent du catalogue et de `zodErrorMap`**, jamais
 *   des littéraux français du contrat partagé.
 *
 * Le rendu d'un écran en anglais demande de remplacer l'amorce de langue des
 * suites, qui les fixe toutes en français (`tests/support/next-intl.ts`) : les
 * deux doublures ci-dessous lisent le **vrai** catalogue anglais, côté crochet
 * comme côté serveur. Elles viennent de `tests/support/langue-figee.ts` (#1283),
 * où elles sont écrites une fois pour les trois suites anglaises — et sur le
 * formateur ICU que l'amorce elle-même emploie, mémoïsé par langue et par
 * namespace.
 */

vi.mock('next-intl', () => nextIntlFixe('en'));

vi.mock('next-intl/server', () => nextIntlServerFixe('en'));

const fetchPublicTenant = vi.fn();
const searchCustomers = vi.fn();
const fetchCustomer = vi.fn();
const fetchCustomerHistory = vi.fn();
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
  requireAdminAccessToken: () => Promise.resolve('jeton-de-session-du-comptoir'),
  adminLoadFailure: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/salon-lotus/admin/clients',
}));

import ClientsPage from '@/app/(admin)/[tenantSlug]/admin/clients/page';
import { ClientContactForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-contact-form';
import { ClientNoteForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-note-form';
import { ClientSearchForm } from '@/app/(admin)/[tenantSlug]/admin/clients/components/client-search-form';

const SLUG = 'salon-lotus';
const FICHE_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Un salon **montréalais** : c'est le pays, et non la langue, qui décide de
 * l'ordre des chiffres d'une date. `en-CA` écrit « 2026-03-04 » là où `en-US`
 * écrirait « 3/4/2026 », et les deux sont de l'anglais.
 */
const TENANT: PublicTenant = {
  id: '99999999-9999-4999-8999-999999999999',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'America/Toronto',
  defaultCurrency: 'EUR',
  defaultLocale: 'en',
  address: {
    line1: '12 rue Sainte-Catherine',
    city: 'Montréal',
    postalCode: 'H2X 1K4',
    country: 'CA',
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
  // La cliente parle français, l'écran est en anglais : les deux langues de cet
  // écran sont bien distinctes, et c'est le cas que la fiche doit savoir dire.
  locale: 'fr',
};

const PAGE: CustomerPage = {
  items: [RESUME],
  page: 1,
  pageSize: 20,
  totalItems: 1,
  totalPages: 1,
};

/**
 * Un historique d'une seule visite honorée, et **une** absence au compteur.
 *
 * Le « 1 » est délibéré : c'est la valeur sur laquelle le pluriel bascule d'une
 * langue à l'autre, et celle qui produisait « 1 Visites honorées » avant #763.
 */
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
      clientNote: 'Allergie aux agrumes.',
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
  updateCustomerAction.mockReset();
});

async function ouvrirFichier(
  searchParams: Record<string, string> = {},
): Promise<React.ReactElement> {
  return ClientsPage({
    params: Promise.resolve({ tenantSlug: SLUG }),
    searchParams: Promise.resolve(searchParams),
  }) as unknown as Promise<React.ReactElement>;
}

describe('la règle de lint anti-texte-en-dur couvre le périmètre du fichier client', () => {
  /**
   * Le premier critère de #852 ne demande pas seulement que les textes soient au
   * catalogue : il demande que la **règle soit active** sur ce périmètre. Sans
   * cette garde, retirer le marqueur ne ferait échouer aucun test — `eslint`
   * passerait simplement sans rien regarder, et le premier libellé réécrit en dur
   * reviendrait sans un mot.
   *
   * Le marqueur est **vide**, donc il couvre tout le sous-arbre : les trois
   * briques de cet écran vivent dans `clients/components/` et non dans le
   * `admin/components/` que trois tickets se partagent.
   */
  it('vise le sous-arbre de l’écran, briques comprises', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));

    expect(globs).toContain(
      'app/\\(admin\\)/\\[tenantSlug\\]/admin/clients/**/*.{ts,tsx}',
    );
  });
});

describe('le fichier client, rendu en anglais', () => {
  it('nomme l’écran, sa recherche et sa pagination dans la langue de la session', async () => {
    render(await ouvrirFichier());

    expect(screen.getByRole('heading', { name: 'Client file', level: 1 })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Search', level: 2 })).toBeDefined();
    expect(screen.getByLabelText(/Search for a client/)).toBeDefined();
  });

  it('dit le fichier vide dans la langue, et garde le lien vers le planning', async () => {
    searchCustomers.mockResolvedValue({ ...PAGE, items: [], totalItems: 0, totalPages: 0 });
    render(await ouvrirFichier());

    expect(screen.getByText('No client records yet')).toBeDefined();
    // Le lien est **dans** la phrase, et non une clé à part : c'est ce que
    // `t.rich` préserve, et ce qu'une découpe en deux clés aurait figé dans
    // l'ordre du français.
    expect(screen.getByRole('link', { name: 'the calendar' })).toBeDefined();
  });

  it('accorde les libellés comptés selon la langue, et non selon une bascule écrite en dur', async () => {
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    // Une visite honorée, une absence : l'anglais met le pluriel dès qu'il n'y
    // en a pas exactement une, le français à partir de deux. « Completed visit »
    // au singulier est donc juste ici — et « 1 Visites honorées » de l'ancienne
    // version ne l'était dans aucune des deux langues.
    expect(screen.getByText('Completed visit')).toBeDefined();
    expect(screen.getByText('No-show')).toBeDefined();
    expect(screen.getByText('Upcoming')).toBeDefined();
    expect(screen.getByText('Total completed')).toBeDefined();
  });

  it('met dates et montants en forme selon la langue et le pays, sans changer l’instant ni l’entier', async () => {
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    // « Wednesday, March 4, 2026 » — la langue vient de la session, la région
    // du pays de l'établissement, et le fuseau reste celui du salon. La même
    // fiche rendue en français écrit « mercredi 4 mars 2026 » : c'est `Intl`
    // qui sait cela, jamais le catalogue.
    expect(screen.getByText(/Record created on Wednesday, March 4, 2026/)).toBeDefined();
    // 3500 centimes d'euro, mis en forme en anglais : le montant n'a pas bougé.
    expect(screen.getAllByText('€35.00').length).toBeGreaterThan(0);
  });

  it('dit la langue préférée de la cliente, qui n’est pas celle de l’écran', async () => {
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    // L'endonyme vient du namespace `locale`, partagé avec le sélecteur de
    // langue : « Français » s'écrit en français, sur un écran anglais.
    expect(screen.getByText('Speaks Français')).toBeDefined();
  });

  it('écrit l’absence de préférence en toutes lettres, sans la replier sur la langue du salon', async () => {
    // `null` se lit « aucune préférence enregistrée » (#844). Afficher
    // « Speaks English » parce que le salon est anglophone aurait fait paraître
    // choisie une langue que personne n'a demandée.
    fetchCustomer.mockResolvedValue({ ...FICHE, locale: null });
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    expect(screen.getByText('Language not recorded')).toBeDefined();
    expect(screen.queryByText(/^Speaks /)).toBeNull();
  });

  it('traduit l’historique et ses dates, sans toucher à ce que le salon et la cliente ont écrit', async () => {
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    expect(screen.getByRole('heading', { name: 'Visit history' })).toBeDefined();
    expect(screen.getByText('Client note, written when booking')).toBeDefined();
    // Le nom de la prestation, celui du praticien et la remarque de la cliente
    // sont des saisies : ils ne se traduisent pas.
    expect(screen.getByText('Massage suédois')).toBeDefined();
    expect(screen.getByText('with Hanta')).toBeDefined();
    expect(screen.getByText('Allergie aux agrumes.')).toBeDefined();
  });

  it('dit l’historique vide dans la langue', async () => {
    fetchCustomerHistory.mockResolvedValue({ ...HISTORIQUE, visits: [] });
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    expect(screen.getByText('No visit yet')).toBeDefined();
  });

  it('dit la fiche introuvable sans jamais dire qu’elle existe ailleurs', async () => {
    const { ApiClientError } = await import('@/lib/api-client');
    fetchCustomer.mockRejectedValue(new ApiClientError('NOT_FOUND', 'introuvable', 404));
    fetchCustomerHistory.mockRejectedValue(new ApiClientError('NOT_FOUND', 'introuvable', 404));
    render(await ouvrirFichier({ fiche: FICHE_ID }));

    expect(screen.getByText('Record not found')).toBeDefined();
    // Le message est le même pour un identifiant inconnu et pour celui du salon
    // voisin : le traduire n'y change rien (tenant-isolation §4).
    expect(screen.getByText(/No record in this salon carries that identifier/)).toBeDefined();
  });
});

describe('la recherche du fichier client, rendue en anglais', () => {
  it('refuse un terme trop court dans la langue, sur le champ', async () => {
    render(<ClientSearchForm tenantSlug={SLUG} term="" hint="Name, phone or email." />);

    await userEvent.type(screen.getByLabelText(/Search for a client/), 'a');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    // Le message est **sur le champ**, pas en bloc en haut de page
    // (web-frontend §4), et il porte la borne du contrat.
    expect(screen.getByText(/Searching needs at least 2 characters/)).toBeDefined();
  });
});

describe('les deux formulaires d’écriture de la fiche, rendus en anglais', () => {
  it('nomme la note interne, sa mention de confidentialité et son bouton', () => {
    render(<ClientNoteForm tenantSlug={SLUG} customerId={FICHE_ID} internalNote={null} />);

    expect(screen.getByText('Internal note')).toBeDefined();
    // « Interne au salon » est la garantie qui décide si l'on ose écrire : elle
    // est écrite en toutes lettres, dans la langue, jamais portée par une teinte.
    expect(screen.getByText('Salon only')).toBeDefined();
    expect(screen.getByLabelText(/What the salon should know/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save the note' })).toBeDefined();
  });

  it('nomme les coordonnées et dit pourquoi l’adresse ne se modifie pas', async () => {
    render(<ClientContactForm tenantSlug={SLUG} customer={FICHE} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit contact details' }));

    expect(screen.getByLabelText(/First name/)).toBeDefined();
    expect(screen.getByLabelText(/Last name/)).toBeDefined();
    expect(screen.getByText(/The record’s identifier in this salon/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
  });

  it('dit les bornes du contrat dans la langue de l’écran, et non dans celle de zod', async () => {
    render(<ClientContactForm tenantSlug={SLUG} customer={FICHE} />);

    await userEvent.click(screen.getByRole('button', { name: 'Edit contact details' }));
    await userEvent.clear(screen.getByLabelText(/First name/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Le refus se lit en anglais, sur le champ. Le schéma du formulaire reprend
    // la **règle** du contrat — plancher à un caractère après découpe des blancs,
    // plafond à `NAME_MAX_LENGTH` — mais emprunte sa **phrase** au catalogue :
    // les messages de `nameSchema` sont des littéraux français que `zodErrorMap`
    // ne traduit pas, et « ce champ est obligatoire » s'affichait tel quel sous
    // ce formulaire anglais. Et l'action ne part pas.
    expect(updateCustomerAction).not.toHaveBeenCalled();
    expect(screen.getByText('this field is required')).toBeDefined();
    expect(screen.queryByText(/caractères/)).toBeNull();
    expect(screen.queryByText(/obligatoire/)).toBeNull();
  });
});
