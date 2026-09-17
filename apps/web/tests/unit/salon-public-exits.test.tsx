import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SalonPage from '@/app/(booking)/[tenantSlug]/(vitrine)/page';
import BookingLayout from '@/app/(booking)/[tenantSlug]/reservation/layout';
import { ApiClientError } from '@/lib/api-client';

import { service, tenant } from './fixtures';

/**
 * L'accès à l'espace client depuis les écrans publics — #739.
 *
 * ## La référence
 *
 * CDC §1.4, « Réservation client » : le périmètre MVP inclut le *compte client
 * avec historique*. La porte d'entrée publique de l'établissement doit donc y
 * mener, comme elle mène à la réservation.
 *
 * L'audit de conception a relevé l'écart à 360, 768 et 1 280 px : la vitrine
 * n'avait qu'un seul lien sortant, « Prendre rendez-vous ». Une cliente déjà
 * inscrite qui arrivait sur `/{slug}` n'atteignait son compte qu'en connaissant
 * l'URL, ou en entrant d'abord dans le tunnel — dont le pied de page, lui,
 * portait le lien.
 *
 * ## Ce que la suite protège, au-delà de « il y a un lien »
 *
 * - **Le même mot d'un écran à l'autre** : le tunnel et la vitrine passent par
 *   le même composant, donc par le même libellé. C'est ce qui empêche « Mon
 *   compte » ici et « Mes rendez-vous » là pour la même page.
 * - **L'appel à l'action reste unique sur la vitrine** : y ajouter un second
 *   « Prendre rendez-vous » casserait le sélecteur du parcours E2E
 *   (`tests/e2e/support/scene.ts`), qui clique ce lien par son nom.
 * - **La sortie survit à la panne** : l'écran d'erreur du catalogue garde le
 *   lien, sans quoi une API injoignable enfermerait la visiteuse.
 */

const fetchPublicServices = vi.fn();
const fetchPublicTenant = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : `salon-data`
// mémoïse par `cache()` de React, et `ApiClientError` doit rester la vraie classe
// — c'est sur `instanceof` que la page distingue le 404 de la panne.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

function servir(): void {
  fetchPublicTenant.mockResolvedValue(tenant);
  fetchPublicServices.mockResolvedValue([service]);
}

async function rendreLaVitrine(): Promise<void> {
  render(await SalonPage({ params: Promise.resolve({ tenantSlug: tenant.slug }) }));
}

afterEach(() => {
  cleanup();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
});

describe("l'accès à l'espace client depuis la vitrine", () => {
  it('offre « Mes rendez-vous » vers le compte de l’établissement', async () => {
    servir();

    await rendreLaVitrine();

    const acces = screen.getByRole('link', { name: 'Mes rendez-vous' });

    // `/compte` redirige lui-même vers la connexion sans session : un seul
    // libellé sert la cliente inscrite et celle qui ne l'est pas.
    expect(acces.getAttribute('href')).toBe(`/${tenant.slug}/compte`);
  });

  it('en fait un repère de navigation, posé hors du contenu', async () => {
    servir();

    await rendreLaVitrine();

    const navigation = screen.getByRole('navigation');

    expect(within(navigation).getByRole('link', { name: 'Mes rendez-vous' })).toBeDefined();
    // Hors du `<main>` : c'est une navigation de site, pas une ligne du
    // catalogue, et un lecteur d'écran doit l'atteindre par sa liste de repères.
    expect(
      within(screen.getByRole('main')).queryByRole('link', { name: 'Mes rendez-vous' }),
    ).toBeNull();
  });

  it('laisse un seul « Prendre rendez-vous » — le parcours E2E clique celui-là', async () => {
    servir();

    await rendreLaVitrine();

    expect(screen.getAllByRole('link', { name: 'Prendre rendez-vous' })).toHaveLength(1);
  });

  it('garde la sortie quand le catalogue ne se charge pas', async () => {
    // Une panne, et non un 404 : le 404 rend la page « introuvable » de Next,
    // qui n'appartient pas à cet établissement.
    fetchPublicTenant.mockRejectedValue(
      new ApiClientError('UPSTREAM_UNAVAILABLE', 'API injoignable', 503),
    );
    fetchPublicServices.mockRejectedValue(
      new ApiClientError('UPSTREAM_UNAVAILABLE', 'API injoignable', 503),
    );

    await rendreLaVitrine();

    expect(screen.getByRole('link', { name: 'Mes rendez-vous' }).getAttribute('href')).toBe(
      `/${tenant.slug}/compte`,
    );
  });
});

describe('le tunnel nomme les mêmes sorties', () => {
  it('rend le pied de page par le composant partagé, libellés compris', async () => {
    servir();

    render(
      await BookingLayout({
        children: <p>étape en cours</p>,
        params: Promise.resolve({ tenantSlug: tenant.slug }),
      }),
    );

    expect(screen.getByRole('link', { name: 'Mes rendez-vous' }).getAttribute('href')).toBe(
      `/${tenant.slug}/compte`,
    );
    expect(
      screen.getByRole('link', { name: 'Voir toutes les prestations' }).getAttribute('href'),
    ).toBe(`/${tenant.slug}`);
  });
});
