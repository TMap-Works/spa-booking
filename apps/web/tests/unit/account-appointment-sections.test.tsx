import type { BookedAppointment } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountPage from '@/app/(account)/[tenantSlug]/compte/page';

import { service, tenant } from './fixtures';

/**
 * Les deux moitiés de l'accueil de l'espace client, et ce que leurs intitulés
 * promettent — #744.
 *
 * Ce que la suite protège : que la seconde moitié **ne soit pas nommée par un
 * critère de créneau**. Elle ne range pas « ce qui est passé » : elle range le
 * complément exact de « à venir », c'est-à-dire ce qui n'occupe plus son créneau
 * — annulations et reports compris, dont la date peut parfaitement être dans le
 * futur (`appointments.repository.ts` · `listForClient`). Le CDC §2.4 décrit le
 * rendez-vous par un statut **et** un créneau distincts ; un intitulé qui
 * annonce le second doit être peuplé selon le second.
 *
 * Le cas de l'audit est rejoué tel quel : un rendez-vous annulé daté de cinq
 * jours après le jour courant, rendu par `scope=past`. C'est la seule situation
 * où un renommage cosmétique se distingue d'une correction — sur un historique
 * uniquement composé de visites échues, « passés » et « Historique » se valent.
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

/** Les deux moitiés, dans l'ordre où la page les demande : `upcoming` puis `past`. */
function servir(upcoming: readonly BookedAppointment[], past: readonly BookedAppointment[]): void {
  fetchPublicTenant.mockResolvedValue(TENANT);
  fetchPublicServices.mockResolvedValue([...SERVICES]);
  fetchMyAppointments.mockImplementation((_token: string, query: { scope?: string }) =>
    Promise.resolve(query.scope === 'past' ? [...past] : [...upcoming]),
  );
}

async function rendreLaPage(): Promise<void> {
  render(await AccountPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }));
}

afterEach(() => {
  cleanup();
  fetchMyAppointments.mockReset();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
});

describe("les intitulés des deux moitiés de l'espace client", () => {
  it('ne range plus rien sous un intitulé qui annonce le passé', async () => {
    servir([], [annuleAVenir()]);

    await rendreLaPage();

    expect(screen.getByRole('heading', { name: 'Historique' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /rendez-vous passés/i })).toBeNull();
  });

  it("verse un rendez-vous annulé à venir dans l'historique sans le dire passé", async () => {
    servir([], [annuleAVenir()]);

    await rendreLaPage();

    const historique = screen.getByRole('region', { name: 'Historique' });

    // La date est bien postérieure au jour de l'audit : c'est tout l'objet du
    // ticket, et c'est ce qui rendait l'ancien intitulé faux.
    expect(within(historique).getByText(/21 septembre 2026/)).toBeDefined();
    expect(within(historique).getByText('Annulé par vous')).toBeDefined();
  });

  it('dit le critère de chaque moitié plutôt que de le laisser deviner', async () => {
    servir([appointment()], [annuleAVenir()]);

    await rendreLaPage();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });
    const historique = screen.getByRole('region', { name: 'Historique' });

    expect(within(aVenir).getByText(/reporter ou annuler/i)).toBeDefined();
    // La légende de l'historique doit nommer le cas qui surprend — une date qui
    // n'est pas encore passée —, sans quoi la carte de l'audit se lit encore
    // comme une erreur de tri.
    expect(within(historique).getByText(/leur date n’est pas encore passée/i)).toBeDefined();
  });

  it("nomme le vide de l'historique par la section, et non par la visite", async () => {
    servir([], []);

    await rendreLaPage();

    const historique = screen.getByRole('region', { name: 'Historique' });

    expect(within(historique).getByText('Votre historique est vide')).toBeDefined();
    expect(within(historique).queryByText(/aucune visite/i)).toBeNull();
    // Le vide dit quand la section se remplira ; ce qu'elle rangera est déjà dit
    // par la légende, juste au-dessus (web-frontend §6). Et il ne le dit pas par
    // la **visite** : un rendez-vous annulé ou déplacé remplit l'historique sans
    // qu'aucune visite ait eu lieu — ce serait le défaut même que #744 corrige.
    expect(within(historique).queryByText(/première visite/i)).toBeNull();
    expect(
      within(historique).getByText(/quittera la liste « Rendez-vous à venir »/i),
    ).toBeDefined();
  });

  it('laisse la moitié « à venir » intacte — elle, son intitulé est vrai', async () => {
    servir([appointment()], []);

    await rendreLaPage();

    const aVenir = screen.getByRole('region', { name: 'Rendez-vous à venir' });

    expect(within(aVenir).getByText(/21 septembre 2026/)).toBeDefined();
    // Les deux gestes ne subsistent que dans cette moitié (voir l'en-tête
    // d'`AppointmentCard`) : le renommage de l'autre n'y touche pas.
    expect(within(aVenir).getByRole('link', { name: 'Reporter' })).toBeDefined();
    expect(within(aVenir).getByRole('button', { name: 'Annuler' })).toBeDefined();
  });
});
