import type { BookedAppointment, PublicTenant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountPage from '@/app/(account)/[tenantSlug]/compte/(liste)/page';

import { service, tenant } from './fixtures';

/**
 * La carte du **prochain** rendez-vous — #1053.
 *
 * ## Le constat qu'elle corrige
 *
 * Audit `d20260918-1`, critère `ds:standard` : « la carte du prochain
 * rendez-vous a l'habillage exact des neuf cartes d'historique : ni praticien,
 * ni adresse, ni heure de fin ». Quatre motifs du benchmark tombaient avec elle,
 * et ce sont eux que la suite tient — un par `describe` :
 *
 * | Motif | Ce qu'il exige |
 * |---|---|
 * | `BM-RDV-01` | le prochain rendez-vous d'abord, et lui seul en tête |
 * | `BM-RDV-02` | quoi, avec qui, quand, où, combien, et son statut |
 * | `BM-RDV-03` | le rendez-vous s'ajoute à l'agenda personnel |
 * | `BM-RDV-04` | l'adresse et l'itinéraire à un geste |
 *
 * ## Et le premier critère d'acceptation du ticket
 *
 * « À 360 px, le prochain rendez-vous (date, heure, prestation, statut) est
 * lisible au premier écran. » Une suite jsdom ne mesure pas des pixels — elle
 * tient ce qui en décide : que ces quatre informations soient **dans la première
 * carte de l'écran**, et qu'aucune archive ne s'intercale avant elle.
 */

const fetchMyAppointments = vi.fn();
const fetchPublicServices = vi.fn();
const fetchPublicTenant = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchMyAppointments: (...args: unknown[]) => fetchMyAppointments(...args),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccountData: <T,>(
    _tenantSlug: string,
    _currentPath: string,
    read: (token: string) => Promise<T>,
  ) => read('jeton-de-test'),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  cancelOwnAppointmentAction: vi.fn(),
  logoutAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

/** Le salon de la fixture, complété de ce que la carte héros affiche. */
const SALON: PublicTenant = {
  ...tenant,
  contactPhone: '+261 34 12 345 67',
  address: {
    line1: '12 rue des Lilas',
    postalCode: '101',
    city: 'Antananarivo',
    country: 'MG',
  },
};

function appointment(overrides: Partial<BookedAppointment> = {}): BookedAppointment {
  return {
    id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
    reference: 'RDV-8F3K-27',
    status: 'confirmed',
    serviceId: service.id,
    staffId: service.staff[0]?.id ?? '',
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

/** Un second rendez-vous, une semaine plus tard — celui qui n'est pas le prochain. */
function suivant(): BookedAppointment {
  return appointment({
    id: '5c2d4b8a-1e6f-4a90-b3c7-2d8e9f0a1b2c',
    reference: 'RDV-9K2M-31',
    startsAt: '2026-09-28T08:00:00.000Z',
    endsAt: '2026-09-28T09:00:00.000Z',
  });
}

function servir(upcoming: readonly BookedAppointment[]): void {
  fetchPublicTenant.mockResolvedValue(SALON);
  fetchPublicServices.mockResolvedValue([service]);
  fetchMyAppointments.mockImplementation((_token: string, query: { scope?: string }) =>
    Promise.resolve(query.scope === 'past' ? [] : [...upcoming]),
  );
}

async function rendre(): Promise<HTMLElement> {
  const { container } = render(
    await AccountPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }),
  );

  return container;
}

/** La carte héros, désignée par sa classe — elle n'a pas de rôle qui lui soit propre. */
function hero(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('.spa-rdv-hero');

  if (found === null) {
    throw new Error('aucune carte de prochain rendez-vous');
  }

  return found;
}

afterEach(() => {
  cleanup();
  fetchMyAppointments.mockReset();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
});

describe('le prochain rendez-vous est lisible d’abord (BM-RDV-01)', () => {
  it('n’élève en carte héros que le premier, les suivants restant compacts', async () => {
    servir([appointment(), suivant()]);

    const container = await rendre();

    expect(container.querySelectorAll('.spa-rdv-hero')).toHaveLength(1);
    expect(container.querySelectorAll('.spa-appointment')).toHaveLength(1);
    // La carte héros précède la liste des suivants dans le document : c'est ce
    // qui la met au premier écran à 360 px.
    const liste = container.querySelector('.spa-appointment-list');
    expect(
      hero(container).compareDocumentPosition(liste as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('annonce les suivants pour ce qu’ils sont, sans paragraphe d’explication', async () => {
    servir([appointment(), suivant()]);

    const container = await rendre();

    expect(screen.getByRole('heading', { name: 'Ensuite' })).toBeDefined();
    expect(container.querySelector('.spa-account__section-hint')).toBeNull();
  });

  it('ne rend aucune liste quand il n’y a qu’un rendez-vous', async () => {
    servir([appointment()]);

    const container = await rendre();

    expect(container.querySelector('.spa-appointment-list')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ensuite' })).toBeNull();
  });
});

describe('BM-RDV-02 — la carte dit quoi, avec qui, quand, où, combien et son statut', () => {
  it('porte les quatre informations du premier critère d’acceptation', async () => {
    servir([appointment()]);

    const carte = within(hero(await rendre()));

    // La date, en toutes lettres pour les lecteurs d'écran (`DateBlock`).
    expect(carte.getByText('lundi 21 septembre 2026')).toBeDefined();
    // L'heure, **avec sa fin** — ce que la ligne d'historique taisait.
    expect(carte.getByText(/11:00 – 12:00/)).toBeDefined();
    expect(carte.getByRole('heading', { name: 'Massage suédois' })).toBeDefined();
    expect(carte.getByText('Confirmé')).toBeDefined();
  });

  it('nomme le praticien et le prix', async () => {
    servir([appointment()]);

    const carte = within(hero(await rendre()));

    expect(carte.getByText('Hery')).toBeDefined();
    expect(carte.getByText('35,00 €')).toBeDefined();
  });

  it('dit sous la pastille ce que « À confirmer par le salon » laisse ouvert', async () => {
    servir([appointment({ status: 'pending' })]);

    const carte = within(hero(await rendre()));

    expect(carte.getByText('À confirmer par le salon')).toBeDefined();
    expect(carte.getByText(/Votre créneau est retenu/)).toBeDefined();
  });
});

describe('BM-RDV-04 — l’adresse et l’itinéraire à un geste', () => {
  it('écrit l’adresse du salon et mène à un itinéraire', async () => {
    servir([appointment()]);

    const carte = within(hero(await rendre()));

    expect(carte.getByText('12 rue des Lilas')).toBeDefined();
    const itineraire = carte.getByRole('link', { name: /Itinéraire/ });
    expect(itineraire.getAttribute('href')).toContain('destination=');
    expect(decodeURIComponent(itineraire.getAttribute('href') ?? '')).toContain('12 rue des Lilas');
  });

  it('rend le téléphone du salon composable', async () => {
    servir([appointment()]);

    const carte = within(hero(await rendre()));

    // `tel:` sans les espaces du numéro affiché — RFC 3966 ne les autorise pas.
    expect(carte.getByRole('link', { name: '+261 34 12 345 67' }).getAttribute('href')).toBe(
      'tel:+261341234567',
    );
  });

  it('se tait quand le salon n’a rien publié, plutôt que de promettre', async () => {
    fetchPublicTenant.mockResolvedValue(tenant);
    fetchPublicServices.mockResolvedValue([service]);
    fetchMyAppointments.mockResolvedValue([appointment()]);

    const carte = within(hero(await rendre()));

    expect(carte.queryByRole('link', { name: /Itinéraire/ })).toBeNull();
  });
});

describe('BM-RDV-03 — le rendez-vous s’ajoute à l’agenda personnel', () => {
  it('offre un fichier iCalendar nommé par la référence du rendez-vous', async () => {
    servir([appointment()]);

    const lien = within(hero(await rendre())).getByRole('link', { name: 'Ajouter à mon agenda' });

    expect(lien.getAttribute('download')).toBe('rendez-vous-RDV-8F3K-27.ics');
    expect(lien.getAttribute('href')?.startsWith('data:text/calendar')).toBe(true);
  });
});

describe('les gestes de la carte héros', () => {
  it('propose reporter et annuler tant que le rendez-vous est actionnable', async () => {
    servir([appointment()]);

    const carte = within(hero(await rendre()));

    expect(carte.getByRole('link', { name: 'Reporter' }).getAttribute('href')).toBe(
      `/${tenant.slug}/compte/rendez-vous/3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60/report`,
    );
    expect(carte.getByRole('button', { name: 'Annuler' })).toBeDefined();
  });
});
