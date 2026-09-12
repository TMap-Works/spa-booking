import { ERROR_CODES, type SessionUser, type UserRole } from '@spa/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminLoginForm } from '@/app/(admin)/[tenantSlug]/admin/components/admin-login-form';

/**
 * Où la connexion au back-office dépose chaque rôle (#618).
 *
 * Ce qui se vérifie ici est ce qu'aucun test de `navigation.ts` ne peut voir :
 * que le formulaire **suit** le sommaire au lieu de choisir sa propre
 * destination. Le défaut corrigé était précisément là — un `router.replace` vers
 * les réglages, écran `@AuthAtLeast('ADMIN')`, quel que soit le rang — et il
 * n'apparaissait ni au typecheck ni dans les tests du sommaire, qui étaient
 * verts pendant que l'écran envoyait une praticienne sur un refus.
 */

const replace = vi.fn();
const refresh = vi.fn();
const adminLoginAction = vi.fn();
const adminLogoutAction = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLoginAction: (...args: unknown[]) => adminLoginAction(...args),
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

const SLUG = 'maison-lotus';

/** Le compte que l'API rend, à un rang près. */
const account = (role: UserRole): SessionUser => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'claire@maison-lotus.test',
  role,
  firstName: 'Claire',
  lastName: 'Ravelo',
  phone: null,
});

/** Saisit des identifiants valides et soumet — le geste que toutes ces vérifications partagent. */
const signIn = async (): Promise<void> => {
  await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'claire@maison-lotus.test');
  await userEvent.type(screen.getByLabelText(/mot de passe/i), 'MotDePasse123!');
  await userEvent.click(screen.getByRole('button', { name: /se connecter/i }));
};

afterEach(() => {
  cleanup();
  replace.mockReset();
  refresh.mockReset();
  adminLoginAction.mockReset();
  adminLogoutAction.mockReset();
});

describe('la destination après connexion', () => {
  it('dépose une praticienne sur le planning, jamais sur les réglages', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('staff') });
    render(<AdminLoginForm tenantSlug={SLUG} />);

    await signIn();

    expect(replace).toHaveBeenCalledWith(`/${SLUG}/admin/calendrier`);
    expect(replace).not.toHaveBeenCalledWith(`/${SLUG}/admin/reglages`);
    // Les pages sont rendues côté serveur : sans ce rafraîchissement, la
    // navigation servirait le rendu fait avant que le cookie n'existe.
    expect(refresh).toHaveBeenCalled();
  });

  it('dépose aussi la gérante et l’administratrice sur leur première section', async () => {
    for (const role of ['manager', 'admin'] as const) {
      adminLoginAction.mockResolvedValue({ ok: true, data: account(role) });
      render(<AdminLoginForm tenantSlug={SLUG} />);

      await signIn();

      expect(replace, `rang ${role}`).toHaveBeenCalledWith(`/${SLUG}/admin/calendrier`);
      cleanup();
      replace.mockReset();
    }
  });

  it('encode le slug de la destination', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('admin') });
    render(<AdminLoginForm tenantSlug="salon/lilas" />);

    await signIn();

    expect(replace).toHaveBeenCalledWith('/salon%2Flilas/admin/calendrier');
  });
});

describe('un compte client sur l’écran du back-office', () => {
  it('ne l’emmène nulle part, et le lui dit sans parler d’identifiants', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('client') });
    adminLogoutAction.mockResolvedValue({ ok: true, data: null });
    render(<AdminLoginForm tenantSlug={SLUG} />);

    await signIn();

    expect(replace).not.toHaveBeenCalled();
    // Le mot de passe était bon : annoncer un refus d'identité enverrait
    // chercher une faute de frappe qui n'existe pas.
    expect(screen.getByText(/aucune section/i)).toBeTruthy();
    expect(screen.queryByText(/mot de passe incorrect/i)).toBeNull();
  });

  it('referme la session qu’il vient d’ouvrir', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('client') });
    adminLogoutAction.mockResolvedValue({ ok: true, data: null });
    render(<AdminLoginForm tenantSlug={SLUG} />);

    await signIn();

    // Annoncer l'absence d'accès tout en laissant vivre sept jours un cookie de
    // session sur `/{slug}/admin` serait dire une chose et en faire une autre.
    expect(adminLogoutAction).toHaveBeenCalledWith(SLUG);
  });

  it('dit quand même ce qui se passe si la fermeture échoue', async () => {
    // Sans filet autour de cette attente, le rejet sortait du gestionnaire de
    // soumission : l'écran revenait au repos **sans aucun message**, alors qu'une
    // session venait d'être ouverte. Le pire des deux mondes.
    adminLoginAction.mockResolvedValue({ ok: true, data: account('client') });
    adminLogoutAction.mockRejectedValue(new Error('action serveur injoignable'));
    render(<AdminLoginForm tenantSlug={SLUG} />);

    await signIn();

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(/aucune section/i)).toBeTruthy();
    // Et l'on ne prétend pas avoir refermé ce qu'on n'a pas refermé.
    expect(screen.queryByText(/vient d’être refermée/i)).toBeNull();
  });
});

describe('un refus de l’API', () => {
  it('reste sur l’écran et nomme la cause', async () => {
    adminLoginAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: 'Identifiants invalides.',
    });
    render(<AdminLoginForm tenantSlug={SLUG} />);

    await signIn();

    expect(replace).not.toHaveBeenCalled();
    expect(adminLogoutAction).not.toHaveBeenCalled();
    expect(screen.getByText(/mot de passe incorrect/i)).toBeTruthy();
  });
});
