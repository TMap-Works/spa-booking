import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountPage from '@/app/(account)/[tenantSlug]/compte/(liste)/page';
import AccountHistoryPage from '@/app/(account)/[tenantSlug]/compte/historique/page';

import { service, tenant } from './fixtures';

/**
 * Les deux onglets de rendez-vous de l'espace client — #744, repris par #1053.
 *
 * ## Ce que la suite protégeait, et qui tient toujours (#744)
 *
 * Que la seconde moitié **ne soit pas nommée par un critère de créneau**. Elle
 * ne range pas « ce qui est passé » : elle range le complément exact de « à
 * venir », c'est-à-dire ce qui n'occupe plus son créneau — annulations et
 * reports compris, dont la date peut parfaitement être dans le futur
 * (`appointments.repository.ts` · `listForClient`). Le CDC §2.4 décrit le
 * rendez-vous par un statut **et** un créneau distincts ; un intitulé qui
 * annonce le second doit être peuplé selon le second.
 *
 * Le cas de l'audit est rejoué tel quel : un rendez-vous annulé daté de cinq
 * jours après le jour courant, rendu par `scope=past`. C'est la seule situation
 * où un renommage cosmétique se distingue d'une correction.
 *
 * ## Ce que #1053 y ajoute
 *
 * Les deux moitiés ne sont plus empilées sur un écran : « À venir d'abord,
 * Passés à part » (`BM-RDV-01`). La suite vérifie donc que **chaque onglet ne
 * sert que sa moitié** — un historique rendu sous les rendez-vous à venir
 * ramènerait le mur de neuf cartes que l'audit relève — et qu'**aucun paragraphe
 * d'explication ne suit un titre de section**, ce que le troisième critère
 * d'acceptation de #1053 exige.
 */

const fetchMyAppointments = vi.fn();
const fetchPublicServices = vi.fn();
const fetchPublicTenant = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : `tenant.ts`
// mémoïse `fetchPublicTenant` par `cache()` de React, et le doubler à ce
// niveau-là plutôt qu'au niveau du module laisse cette mémoïsation en place.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchMyAppointments: (...args: unknown[]) => fetchMyAppointments(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

// La garde de session lit `cookies()`, qui n'existe hors de Next qu'au prix d'un
// contexte de requête. Ce que la suite éprouve est ce que la page **affiche**
// une fois la session ouverte : la garde est donc réduite à ce qu'elle fait dans
// ce cas — passer le jeton à la lecture.
vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccountData: <T,>(_tenantSlug: string, _currentPath: string, read: (token: string) => Promise<T>) =>
    read('jeton-de-test'),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  cancelOwnAppointmentAction: vi.fn(),
  logoutAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

// L'établissement et la prestation sont ceux de `fixtures.ts`, honorés par le
// contrat partagé plutôt que par un transtypage : un champ qui apparaîtrait dans
// `publicTenantSchema` casserait ici la compilation, là où un objet partiel
// laisserait la suite verte contre une forme que l'API ne rend plus.
const TENANT = tenant;
const SERVICES = [service] as const;

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

/**
 * Le rendez-vous de la capture : annulé par la cliente, mais daté de cinq jours
 * après le jour de l'audit. L'API le range dans `scope=past` — il n'occupe plus
 * son créneau.
 */
function annuleAVenir(): BookedAppointment {
  return appointment({
    status: 'cancelled',
    cancelledAt: '2026-09-16T10:00:00.000Z',
    cancelledBy: 'client',
  });
}

/** Les deux moitiés, telles que l'API les sert selon le `scope` demandé. */
function servir(upcoming: readonly BookedAppointment[], past: readonly BookedAppointment[]): void {
  fetchPublicTenant.mockResolvedValue(TENANT);
  fetchPublicServices.mockResolvedValue([...SERVICES]);
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

describe('les intitulés des deux moitiés de l’espace client', () => {
  it('ne range plus rien sous un intitulé qui annonce le passé', async () => {
    servir([], [annuleAVenir()]);

    await rendreLHistorique();

    expect(screen.getByRole('region', { name: 'Historique' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /rendez-vous passés/i })).toBeNull();
  });

  it('verse un rendez-vous annulé à venir dans l’historique sans le dire passé', async () => {
    servir([], [annuleAVenir()]);

    await rendreLHistorique();

    const historique = screen.getByRole('region', { name: 'Historique' });

    // La date est bien postérieure au jour de l'audit : c'est tout l'objet du
    // ticket, et c'est ce qui rendait l'ancien intitulé faux. Le bloc date la
    // donne en toutes lettres aux lecteurs d'écran (`DateBlock`).
    expect(within(historique).getByText(/21 septembre 2026/)).toBeDefined();
    expect(within(historique).getByText('Annulé par vous')).toBeDefined();
  });

  it('laisse la moitié « à venir » intacte — elle, son intitulé est vrai', async () => {
    servir([appointment()], []);

    await rendreLesRendezVous();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });

    expect(within(aVenir).getByText(/21 septembre 2026/)).toBeDefined();
    // Les deux gestes ne subsistent que dans cette moitié (voir l'en-tête
    // d'`AppointmentCard`).
    expect(within(aVenir).getByRole('link', { name: 'Reporter' })).toBeDefined();
    expect(within(aVenir).getByRole('button', { name: 'Annuler' })).toBeDefined();
  });
});

describe('les deux onglets ne se mélangent plus (#1053, BM-RDV-01)', () => {
  it('ne rend aucune archive sous les rendez-vous à venir', async () => {
    servir([appointment()], [annuleAVenir()]);

    await rendreLesRendezVous();

    expect(screen.queryByRole('region', { name: 'Historique' })).toBeNull();
    expect(screen.queryByText('Annulé par vous')).toBeNull();
  });

  it('ne demande même pas l’historique quand un rendez-vous est à venir', async () => {
    // La seconde lecture ne sert qu'à nommer la dernière prestation honorée dans
    // l'état vide : la faire partir à chaque visite serait un appel d'API pour
    // rien.
    servir([appointment()], [annuleAVenir()]);

    await rendreLesRendezVous();

    const scopes = fetchMyAppointments.mock.calls.map((call) => (call[1] as { scope: string }).scope);
    expect(scopes).toEqual(['upcoming']);
  });

  it('ne rend aucun rendez-vous à venir sous l’historique', async () => {
    servir([appointment()], [annuleAVenir()]);

    await rendreLHistorique();

    expect(screen.queryByRole('region', { name: 'Rendez-vous à venir' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Reporter' })).toBeNull();
  });
});

describe('aucun paragraphe d’explication sous un titre de section (#1053)', () => {
  it.each([
    ['les rendez-vous à venir', rendreLesRendezVous],
    ['l’historique', rendreLHistorique],
  ])('n’en pose pas sur %s', async (_ecran, rendre) => {
    servir([appointment()], [annuleAVenir()]);

    const container = await rendre();

    // La légende de section est ce que l'audit `d20260918-1` relève comme « un
    // paragraphe de quatre lignes » avant le premier rendez-vous. Ce qu'elle
    // disait d'utile est passé sous la pastille du rendez-vous concerné.
    expect(container.querySelector('.spa-account__section-hint')).toBeNull();
    expect(screen.queryByText(/reporter ou annuler/i)).toBeNull();
    expect(screen.queryByText(/leur date n’est pas encore passée/i)).toBeNull();
  });
});
