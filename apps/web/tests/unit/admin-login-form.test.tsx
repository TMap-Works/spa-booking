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
  locale: null,
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
  it('dépose une praticienne sur son propre planning, jamais sur les réglages', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('staff') });
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

    await signIn();

    // « Mon planning » (#813) : le planning du salon lui répond 403 depuis #812.
    expect(replace).toHaveBeenCalledWith(`/${SLUG}/admin/mon-planning`);
    expect(replace).not.toHaveBeenCalledWith(`/${SLUG}/admin/reglages`);
    // Les pages sont rendues côté serveur : sans ce rafraîchissement, la
    // navigation servirait le rendu fait avant que le cookie n'existe.
    expect(refresh).toHaveBeenCalled();
  });

  it('dépose la gérante et l’administratrice sur le tableau de bord, leur première section', async () => {
    for (const role of ['manager', 'admin'] as const) {
      adminLoginAction.mockResolvedValue({ ok: true, data: account(role) });
      render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

      await signIn();

      expect(replace, `rang ${role}`).toHaveBeenCalledWith(`/${SLUG}/admin/tableau-de-bord`);
      cleanup();
      replace.mockReset();
    }
  });

  it('encode le slug de la destination', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('admin') });
    render(<AdminLoginForm tenantSlug="salon/lilas" notice={null} />);

    await signIn();

    expect(replace).toHaveBeenCalledWith('/salon%2Flilas/admin/tableau-de-bord');
  });
});

describe('un compte client sur l’écran du back-office', () => {
  it('ne l’emmène nulle part, et le lui dit sans parler d’identifiants', async () => {
    adminLoginAction.mockResolvedValue({ ok: true, data: account('client') });
    adminLogoutAction.mockResolvedValue({ ok: true, data: null });
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

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
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

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
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

    await signIn();

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(/aucune section/i)).toBeTruthy();
    // Et l'on ne prétend pas avoir refermé ce qu'on n'a pas refermé.
    expect(screen.queryByText(/vient d’être refermée/i)).toBeNull();
  });
});

describe('la mise en forme de l’écran (#699)', () => {
  /** La carte rendue par le composant — c'est le `<form>`, et c'est le sujet. */
  const carte = (): HTMLFormElement => {
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);
    const form = screen.getByRole('form', { name: /back-office — se connecter/i });
    return form as HTMLFormElement;
  };

  it('fait du `<form>` la carte, et n’en remet pas une autour', () => {
    const form = carte();

    // `.spa-admin__section` est ce qui empile les enfants en colonne avec une
    // gouttière. Sous un `<form>` nu, elle n'écartait que le titre, la
    // notification et le formulaire : à l'intérieur, le bouton « Se connecter »
    // touchait le champ « Mot de passe » à 0 px, aux quatre largeurs mesurées.
    expect(form.className.split(/\s+/)).toContain('spa-admin__section');

    // Deux cartes emboîtées ramèneraient le défaut : la gouttière de
    // l'enveloppe ne porterait plus que sur le `<form>` unique qu'elle
    // contient, et les champs se rejoindraient de nouveau.
    expect(form.closest('.spa-admin__section')).toBe(form);

    // Le titre est dans la carte, sans quoi il resterait hors de ce qu'il nomme.
    expect(form.querySelector('#admin-connexion-titre')).not.toBeNull();
  });

  it('borne la colonne de saisie', () => {
    // 44 rem, la mesure que #630 a posée sur les formulaires du back-office.
    // Sans elle, les champs prenaient toute la zone de contenu — qui vaut ici
    // la fenêtre entière, l'écran de connexion étant le seul servi sans rail :
    // environ 1 400 px mesurés à 1920 contre 470 px sur /compte/connexion.
    expect(carte().className.split(/\s+/)).toContain('spa-admin-form');
  });

  it('ne rend que la carte, ce dont dépend son centrage', () => {
    const { container } = render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

    // `admin/shell.css` centre une colonne de saisie qui est l'unique enfant de
    // `.spa-admin__content` — la condition qui distingue cet écran des cinq
    // autres écrans bornés, où la colonne s'aligne sur une barre d'outils ou une
    // liste. Une enveloppe, un fragment à deux blocs, et le centrage tombe sans
    // que rien d'autre ne le signale.
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('FORM');
  });

  it('garde le bouton de soumission en pleine largeur de sa colonne', () => {
    const form = carte();
    const bouton = screen.getByRole('button', { name: /se connecter/i });

    // Le `block` n'est juste que sous une colonne bornée : il finit la colonne
    // qu'il vient de remplir (`styles/README.md` §2). Retirer l'une des deux
    // sans l'autre rendrait un bouton de bout en bout de la fenêtre.
    expect(bouton.className).toContain('spa-button--block');
    expect(form.contains(bouton)).toBe(true);
  });
});

describe('un refus de l’API', () => {
  it('reste sur l’écran et nomme la cause', async () => {
    adminLoginAction.mockResolvedValue({
      ok: false,
      code: ERROR_CODES.INVALID_CREDENTIALS,
      message: 'Identifiants invalides.',
    });
    render(<AdminLoginForm tenantSlug={SLUG} notice={null} />);

    await signIn();

    expect(replace).not.toHaveBeenCalled();
    expect(adminLogoutAction).not.toHaveBeenCalled();
    expect(screen.getByText(/mot de passe incorrect/i)).toBeTruthy();
  });
});
