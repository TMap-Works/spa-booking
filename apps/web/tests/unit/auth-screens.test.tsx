import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';
import { PLATFORM_NAME } from '@/lib/platform';

import { tenant } from './fixtures';

/**
 * #927 — le cadre d'accueil des écrans d'identification.
 *
 * Ce que la refonte doit montrer — le salon, l'espace, des chemins de retour —
 * et ce qu'elle ne doit pas changer : le formulaire reste celui que les deux
 * écrans avaient, et la redirection d'une session ouverte (#760) passe avant
 * tout le reste.
 */

const readAccessToken = vi.fn();
const readRefreshToken = vi.fn();
const accountTenant = vi.fn();
const loadAdminShell = vi.fn();
const readSalonIdentity = vi.fn();

class NavigationSignal extends Error {}

vi.mock('next/navigation', () => ({
  usePathname: () => `/${tenant.slug}/compte/connexion`,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw new NavigationSignal('notFound');
  },
  redirect: (destination: string) => {
    throw new NavigationSignal(`redirect ${destination}`);
  },
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccessToken: () => readAccessToken(),
  readRefreshToken: () => readRefreshToken(),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/tenant', () => ({
  accountTenant: (...args: unknown[]) => accountTenant(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  logoutAction: vi.fn(),
  loginAction: vi.fn(),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/layout', () => ({
  loadAdminShell: (...args: unknown[]) => loadAdminShell(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: vi.fn(),
  adminLogoutAction: vi.fn(),
}));

vi.mock('@/lib/salon-identity', () => ({
  readSalonIdentity: (...args: unknown[]) => readSalonIdentity(...args),
}));

import AccountLayout from '@/app/(account)/[tenantSlug]/compte/layout';
import AdminLoginPage from '@/app/(admin)/[tenantSlug]/admin/connexion/page';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('espace client, sans session', () => {
  async function rendre(): Promise<HTMLElement> {
    accountTenant.mockResolvedValue(tenant);
    readAccessToken.mockResolvedValue(null);
    readRefreshToken.mockResolvedValue(null);

    const { container } = render(
      await AccountLayout({
        children: (<p>formulaire de connexion</p>) as ReactNode,
        params: Promise.resolve({ tenantSlug: tenant.slug }),
      }),
    );
    return container;
  }

  it('sert l’écran dans le gabarit du salon, sans cadre à lui (#1052)', async () => {
    const page = await rendre();

    // Le gabarit porte l'identité du salon — en-tête et pied (#1045).
    const entete = page.querySelector<HTMLElement>('header.spa-shell__header');
    expect(within(entete as HTMLElement).getByText(tenant.name)).toBeDefined();

    // Le cadre d'accueil, lui, n'est plus posé ici : son titre nomme l'écran
    // autant que le salon (« Bienvenue chez … » / « Créez votre compte … »), et
    // un layout de l'App Router ne sait pas quelle route il enveloppe. Chaque
    // page le porte désormais — voir `salon-auth-screen.test.tsx`.
    expect(page.querySelector('.spa-auth')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    // L'écran reste servi, dans le repère du contenu que le lien d'évitement vise.
    const main = page.querySelector('main#contenu');
    expect(main?.textContent).toContain('formulaire de connexion');
  });

  it('propose des chemins de retour, et non l’espace qui ramène ici', async () => {
    await rendre();

    // Depuis #1045, les chemins de retour sont ceux du pied de page du salon, et
    // non plus une rangée de liens soulignés sous le cadre.
    const sorties = screen.getByRole('navigation', { name: 'Pages du salon' });
    expect(
      within(sorties)
        .getByRole('link', { name: PUBLIC_EXIT_LABELS.reservation })
        .getAttribute('href'),
    ).toBe(`/${tenant.slug}/reservation`);
    expect(
      within(sorties).getByRole('link', { name: 'Prestations et tarifs' }).getAttribute('href'),
    ).toBe(`/${tenant.slug}`);
    const pied = document.querySelector<HTMLElement>('footer.spa-shell__footer');
    expect(within(pied as HTMLElement).getByRole('link', { name: PLATFORM_NAME }).getAttribute('href')).toBe('/');
    // La sortie qu'on n'offre pas est celle de l'espace client lui-même, quel que
    // soit son nom — elle ramènerait à cet écran même (#749). L'en-tête efface
    // « Se connecter » sur la connexion, et le pied ne nomme pas l'espace.
    expect(screen.queryByRole('link', { name: PUBLIC_EXIT_LABELS.compte })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Se connecter' })).toBeNull();
  });

  it('ne peint toujours pas la barre du compte', async () => {
    await rendre();

    expect(screen.queryByRole('navigation', { name: 'Mon compte' })).toBeNull();
  });
});

describe('back-office, écran de connexion', () => {
  async function rendre(): Promise<HTMLElement> {
    const { container } = render(
      await AdminLoginPage({
        params: Promise.resolve({ tenantSlug: tenant.slug }),
        searchParams: Promise.resolve({}),
      }),
    );
    return container;
  }

  it('pose le formulaire, inchangé, dans le cadre du salon', async () => {
    loadAdminShell.mockResolvedValue(null);
    readSalonIdentity.mockResolvedValue({ status: 'found', slug: tenant.slug, name: tenant.name });

    const page = await rendre();

    // `.spa-auth` nu : le cadre ne porte plus de modificateur d'espace depuis
    // #1080 — il ne sert que les espaces de travail, et la variante cliente a le
    // sien (`.spa-auth--salon`).
    const cadre = page.querySelector('.spa-auth');
    expect(cadre).not.toBeNull();
    // La classe **exacte**, et non l'absence de `.spa-auth--salon` : celle-ci
    // laisserait revenir n'importe quel autre modificateur d'espace sans rien
    // dire, alors que c'est précisément ce que le ticket retire.
    expect(cadre?.className).toBe('spa-auth');
    expect(screen.getByText(tenant.name)).toBeDefined();
    // Un seul titre de premier niveau : celui du formulaire, qui nomme la carte.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const carte = screen.getByRole('form', { name: /back-office — se connecter/i });
    expect(carte.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['spa-admin__section', 'spa-admin-form']),
    );

    const sorties = screen.getByRole('navigation', { name: 'Autres pages' });
    expect(
      within(sorties).getByRole('link', { name: 'Voir toutes les prestations' }).getAttribute('href'),
    ).toBe(`/${tenant.slug}`);
  });

  it('se passe du nom du salon quand l’API ne répond pas', async () => {
    loadAdminShell.mockResolvedValue(null);
    readSalonIdentity.mockResolvedValue({ status: 'unavailable' });

    await rendre();

    expect(screen.queryByText(tenant.name)).toBeNull();
    expect(screen.getByRole('form', { name: /back-office — se connecter/i })).toBeDefined();
  });

  it('rend 404 pour un salon qui n’existe pas', async () => {
    loadAdminShell.mockResolvedValue(null);
    readSalonIdentity.mockResolvedValue({ status: 'unknown' });

    await expect(rendre()).rejects.toThrow('notFound');
  });

  it('redirige une session ouverte avant de lire quoi que ce soit du salon (#760)', async () => {
    loadAdminShell.mockResolvedValue({
      establishments: [],
      timeZone: null,
      userName: 'Adèle A.',
      role: 'admin',
    });

    // Une administratrice arrive sur le tableau de bord, sa première section.
    await expect(rendre()).rejects.toThrow(`redirect /${tenant.slug}/admin/tableau-de-bord`);
    expect(readSalonIdentity).not.toHaveBeenCalled();
  });
});
