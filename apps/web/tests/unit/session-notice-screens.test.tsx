import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminLoginForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-login-form';
import { LoginForm } from '@/app/(account)/[tenantSlug]/compte/components/login-form';

/**
 * Ce que les deux écrans de connexion disent du chemin qui y mène (#860).
 *
 * Le défaut corrigé n'était pas dans les cookies — #856 les avait déjà mis à
 * l'abri — mais dans la phrase affichée : un renouvellement refusé par le
 * limiteur menait à « Votre session a expiré » côté espace client, et à rien du
 * tout côté back-office. Les deux disent la même chose à qui les lit : « on m'a
 * déconnecté, il faut ressaisir mon mot de passe. » C'est faux, et c'était faux
 * pour tout le monde en même temps, puisque le quota était partagé.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  // L'écran de connexion cliente lit le paramètre de retour (#1087) ; aucun
  // motif de session n'en porte, et ces cas-ci n'en fournissent donc pas.
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: vi.fn(),
  adminLogoutAction: vi.fn(),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  loginAction: vi.fn(),
}));

const SLUG = 'maison-lotus';

afterEach(cleanup);

const surfaces = [
  {
    name: 'back-office',
    render: (notice: 'session-expiree' | 'renouvellement-indisponible' | null) =>
      render(<AdminLoginForm tenantSlug={SLUG} notice={notice} />),
    retry: `/${SLUG}/admin/calendrier`,
  },
  {
    name: 'espace client',
    render: (notice: 'session-expiree' | 'renouvellement-indisponible' | null) =>
      render(<LoginForm tenantSlug={SLUG} notice={notice} />),
    retry: `/${SLUG}/compte`,
  },
] as const;

describe.each(surfaces)('l’écran de connexion — $name', (surface) => {
  it('n’affiche aucun encart quand rien n’a renvoyé ici', () => {
    surface.render(null);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('annonce l’expiration quand l’API a refusé le jeton', () => {
    surface.render('session-expiree');

    expect(screen.getByText(/votre session a expiré/i)).toBeTruthy();
    // Et surtout pas de reprise : réessayer un jeton révoqué rejouerait le même
    // refus, et le lien promettrait une issue qui n'existe pas.
    expect(screen.queryByRole('link', { name: /réessayer/i })).toBeNull();
  });

  it('dit que la session n’est pas fermée quand le renouvellement n’a pas abouti', () => {
    surface.render('renouvellement-indisponible');

    expect(screen.getByText(/session non renouvelée/i)).toBeTruthy();
    expect(screen.getByText(/n’avez pas été déconnecté·e/i)).toBeTruthy();
    // Ce mot-là ne doit pas apparaître : c'est exactement ce que l'écran disait
    // à tort, et ce que ce ticket lui retire.
    expect(screen.queryByText(/a expiré/i)).toBeNull();
  });

  it('offre une reprise qui repasse par la garde, et non un rechargement de cet écran', () => {
    surface.render('renouvellement-indisponible');

    const retry = screen.getByRole('link', { name: /réessayer/i });

    // La destination est une page **gardée** : c'est elle qui repartira vers la
    // route de renouvellement, avec les cookies qu'on vient de ne pas effacer.
    expect(retry.getAttribute('href')).toBe(surface.retry);
  });
});
