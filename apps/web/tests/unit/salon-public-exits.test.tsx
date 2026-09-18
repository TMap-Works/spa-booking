import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import VitrineLayout from '@/app/(booking)/[tenantSlug]/(vitrine)/layout';
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
 * - **Et ce mot est celui de la destination** : « Mon compte », le titre que
 *   porte l'espace client (#749, `ds:libelles` de l'audit `d20260916-1`). Un
 *   lien porte le nom de l'écran qu'il ouvre — WCAG 2.4.4, et 3.2.4 pour la
 *   constance. L'assertion d'identité entre le libellé et le titre est tenue
 *   là où le gabarit du compte se rend, `account-nav.test.tsx`.
 * - **L'appel à l'action reste unique sur la vitrine** : y ajouter un second
 *   « Prendre rendez-vous » casserait le sélecteur du parcours E2E
 *   (`tests/e2e/support/scene.ts`), qui clique ce lien par son nom.
 * - **La sortie survit à la panne** : l'écran d'erreur du catalogue garde le
 *   lien, sans quoi une API injoignable enfermerait la visiteuse.
 *
 * ## Depuis #1045 : l'en-tête du salon
 *
 * La vitrine ne rend plus sa propre barre « Mon compte » : l'accès au compte
 * est dans l'en-tête du gabarit du salon, posé par le layout — « Se connecter »
 * sans session, le prénom et son menu avec. C'est donc le layout et la page,
 * ensemble, que cette suite rend.
 */

const fetchPublicServices = vi.fn();
const fetchPublicTenant = vi.fn();
const readAccountPresence = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées : `salon-data`
// mémoïse par `cache()` de React, et `ApiClientError` doit rester la vraie classe
// — c'est sur `instanceof` que la page distingue le 404 de la panne.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchPublicServices: (...args: unknown[]) => fetchPublicServices(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

vi.mock('@/lib/account-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-presence')>()),
  readAccountPresence: () => readAccountPresence(),
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => `/${tenant.slug}`,
}));

function servir(): void {
  fetchPublicTenant.mockResolvedValue(tenant);
  fetchPublicServices.mockResolvedValue([service]);
}

/** L'en-tête du gabarit du salon — la page a aussi son `<header>`, dans `<main>`. */
function enTete(): HTMLElement {
  const header = document.querySelector<HTMLElement>('header.spa-shell__header');
  if (header === null) {
    throw new Error('le layout de la vitrine doit poser l’en-tête du salon');
  }
  return header;
}

async function rendreLaVitrine(): Promise<void> {
  const params = Promise.resolve({ tenantSlug: tenant.slug });
  render(await VitrineLayout({ children: await SalonPage({ params }), params }));
}

afterEach(() => {
  cleanup();
  fetchPublicServices.mockReset();
  fetchPublicTenant.mockReset();
  readAccountPresence.mockReset();
});

describe("l'accès à l'espace client depuis la vitrine", () => {
  it('offre « Se connecter » dans l’en-tête du salon, hors du contenu', async () => {
    servir();
    readAccountPresence.mockResolvedValue(null);

    await rendreLaVitrine();

    const acces = within(enTete()).getByRole('link', { name: 'Se connecter' });
    expect(acces.getAttribute('href')).toBe(`/${tenant.slug}/compte/connexion`);
    // Hors du `<main>` : c'est une navigation de site, pas une ligne du
    // catalogue, et un lecteur d'écran l'atteint par le repère de l'en-tête.
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Se connecter' })).toBeNull();
  });

  it('salue la cliente connectée, sans lire ses jetons', async () => {
    servir();
    readAccountPresence.mockResolvedValue({ firstName: 'Alice', lastName: 'Marchand' });

    await rendreLaVitrine();

    expect(
      within(enTete()).getByRole('button', { name: /Mon compte : Alice/ }),
    ).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Se connecter' })).toBeNull();
  });

  it('laisse un seul « Prendre rendez-vous » dans le contenu — le parcours E2E clique celui-là', async () => {
    servir();
    readAccountPresence.mockResolvedValue(null);

    await rendreLaVitrine();

    expect(
      within(screen.getByRole('main')).getAllByRole('link', { name: 'Prendre rendez-vous' }),
    ).toHaveLength(1);
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
    readAccountPresence.mockResolvedValue(null);

    await rendreLaVitrine();

    expect(screen.getByRole('link', { name: 'Se connecter' }).getAttribute('href')).toBe(
      `/${tenant.slug}/compte/connexion`,
    );
  });
});

/**
 * Le tunnel, lui, n'a plus de sorties publiques — #1047.
 *
 * Il en a eu deux successivement : les siennes (#623), puis celles-ci, partagées
 * avec la vitrine (#739). `BM-TUNNEL-10` les écarte l'une comme l'autre — *« la
 * navigation du site disparaît au profit d'un "←" (étape précédente) et d'un "×"
 * (quitter) »*, pour que *« l'attention reste sur la réservation »*. Sa seule
 * sortie est « ✕ Quitter », dans son en-tête, et
 * `booking-tunnel.test.tsx` l'éprouve là où elle se trouve désormais.
 *
 * Ce qui reste à garder ici, c'est qu'elles n'y reviennent pas : un pied de page
 * remis sous le tunnel rouvrirait l'écart sans qu'aucune autre suite le voie.
 */
describe('le tunnel n’a plus de sorties publiques (#1047)', () => {
  it('n’enveloppe l’étape d’aucun pied de page', async () => {
    servir();

    render(
      await BookingLayout({
        children: <p>étape en cours</p>,
        params: Promise.resolve({ tenantSlug: tenant.slug }),
      }),
    );

    expect(screen.queryByRole('link', { name: 'Mon compte' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Voir toutes les prestations' })).toBeNull();
    expect(screen.getByText('étape en cours')).toBeDefined();
  });
});
