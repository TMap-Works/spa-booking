import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ce que le back-office montre quand l'API ne répond pas — #755.
 *
 * L'écart relevé par l'audit `d20260916-1` tenait en deux défauts qui se
 * cumulaient sur le même écran, et qui se décident tous les deux dans la coquille
 * partagée — d'où une suite unique :
 *
 * 1. `loadAdminShell` rattrapait **tout** échec et rendait `null`. Une API
 *    éteinte retirait donc le rail entier — navigation, salon, fuseau,
 *    « Se déconnecter » — en même temps que le contenu de la page, et l'opérateur
 *    n'avait plus aucun lien pour revenir au planning ;
 * 2. `adminLoadFailure` rendait un encart rouge **sans aucune action**, là où
 *    `docs/design/appointments/states.md` (« Règles générales ») exige d'un état
 *    d'erreur un message compréhensible et une action « Réessayer ».
 *
 * La contrepartie est éprouvée aussi, et elle compte autant : un **refus** — 401,
 * 403, 404 — ne doit pas se mettre à peindre un rail qui n'avait pas lieu d'être,
 * sans quoi l'écran de connexion, qui vit sous ce même layout, se retrouverait
 * avec un sommaire.
 */

const fetchOwnProfile = vi.fn();
const fetchPublicTenant = vi.fn();
const readAdminAccessToken = vi.fn();
const adminLogoutAction = vi.fn();
const refresh = vi.fn();
const replace = vi.fn();

// Le module réel est repris et seules les lectures sont remplacées :
// `ApiClientError` doit rester la vraie classe, faute de quoi les `instanceof`
// du layout et de la garde ne reconnaîtraient ni un refus ni une panne.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  fetchOwnProfile: (...args: unknown[]) => fetchOwnProfile(...args),
  fetchPublicTenant: (...args: unknown[]) => fetchPublicTenant(...args),
}));

// La session se lit par `cookies()`, que jsdom n'a pas : on remplace la lecture,
// pas le magasin.
vi.mock('@/app/(admin)/[tenantSlug]/admin/session', () => ({
  readAdminAccessToken: () => readAdminAccessToken(),
  readAdminRefreshToken: () => Promise.resolve(null),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/spa-lumiere/admin/encaissement',
  useRouter: () => ({ refresh, replace, push: vi.fn() }),
  // `redirect()` lève dans Next : le double lève aussi, sans quoi l'appelant
  // poursuivrait après une navigation qu'il croit terminée.
  redirect: (destination: string) => {
    throw new Error(`NEXT_REDIRECT:${destination}`);
  },
}));

import AdminLayout from '@/app/(admin)/[tenantSlug]/admin/layout';
import { adminLoadFailure } from '@/app/(admin)/[tenantSlug]/admin/guard';
import { ApiClientError } from '@/lib/api-client';

const SLUG = 'spa-lumiere';
const TOKEN = 'jeton-du-comptoir';

/** La panne du ticket : l'API n'a pas répondu du tout. */
const PANNE = new ApiClientError(
  'SERVICE_UNAVAILABLE',
  'Le service de réservation est momentanément injoignable. Merci de réessayer dans un instant.',
  503,
);

const DENIAL = {
  deniedTitle: 'Accès réservé',
  deniedHint: 'L’encaissement est réservé aux comptes du salon.',
  failedTitle: 'Encaissement indisponible',
};

async function ouvrirLaCoquille() {
  return AdminLayout({
    children: <p>contenu de l’écran</p>,
    params: Promise.resolve({ tenantSlug: SLUG }),
  });
}

beforeEach(() => {
  readAdminAccessToken.mockResolvedValue(TOKEN);
  fetchOwnProfile.mockResolvedValue({
    id: 'compte-1',
    firstName: 'Hasina',
    lastName: 'Rakotoarisoa',
    role: 'manager',
  });
  fetchPublicTenant.mockResolvedValue({
    slug: SLUG,
    name: 'Spa Lumière',
    timezone: 'Indian/Antananarivo',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('coquille du back-office — une panne ne retire plus le rail', () => {
  it('garde la navigation et la déconnexion quand l’API entière est éteinte', async () => {
    // La reproduction du ticket : les deux appels du layout tombent, comme ils
    // tombent quand l'API ne répond plus.
    fetchOwnProfile.mockRejectedValue(PANNE);
    fetchPublicTenant.mockRejectedValue(PANNE);

    render(await ouvrirLaCoquille());

    // Ce qui manquait à l'opérateur : un lien pour revenir au planning.
    expect(screen.getByRole('link', { name: 'Planning' }).getAttribute('href')).toBe(
      `/${SLUG}/admin/calendrier`,
    );
    expect(screen.getByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Sections du tableau de bord' })).toBeTruthy();
    // Et le contenu de la page reste rendu : la coquille ne s'y substitue pas.
    expect(screen.getByText('contenu de l’écran')).toBeTruthy();
  });

  it('n’invente ni fuseau ni compte, et dit la panne plutôt que de la taire', async () => {
    fetchOwnProfile.mockRejectedValue(PANNE);
    fetchPublicTenant.mockRejectedValue(PANNE);

    render(await ouvrirLaCoquille());

    // Un fuseau de repli ferait lire la journée dans celui de personne.
    expect(screen.queryByText(/Fuseau du salon/)).toBeNull();
    // Un nom inventé annoncerait quelqu'un d'autre sur un poste partagé.
    expect(screen.queryByText(/Connecté·e/)).toBeNull();
    expect(screen.getByText(/Compte non vérifié/)).toBeTruthy();
    // Le rang retombe au plus bas : les réglages, réservés à `admin`, ne sont
    // pas promis à qui ne les a peut-être pas.
    expect(screen.queryByText('Réglages')).toBeNull();
  });

  it('ne perd pas le compte quand seule la vitrine publique tombe', async () => {
    // Les deux appels ne dépendent pas l'un de l'autre : l'un qui échoue ne doit
    // pas effacer ce que l'autre a rendu.
    fetchPublicTenant.mockRejectedValue(PANNE);

    render(await ouvrirLaCoquille());

    expect(screen.getByText(/Hasina R\., gérant·e/)).toBeTruthy();
    expect(screen.queryByText(/Fuseau du salon/)).toBeNull();
    // Le salon se nomme alors par le slug de l'URL, la seule chose qu'on en
    // sache vraie — en tête de rail comme au pied, d'où le pluriel.
    expect(screen.getAllByText(SLUG).length).toBeGreaterThan(0);
  });

  it('ne perd pas le salon quand seul le profil tombe', async () => {
    fetchOwnProfile.mockRejectedValue(PANNE);

    render(await ouvrirLaCoquille());

    expect(screen.getAllByText('Spa Lumière').length).toBeGreaterThan(0);
    expect(screen.getByText(/Fuseau du salon : Indian\/Antananarivo/)).toBeTruthy();
    expect(screen.getByText(/Compte non vérifié/)).toBeTruthy();
  });
});

describe('coquille du back-office — un refus n’est pas une panne', () => {
  it.each([
    ['401, session révoquée', 401],
    ['403, rang refusé', 403],
    ['404, salon inconnu', 404],
  ])('ne peint aucun rail sur un %s', async (_cas, status) => {
    fetchOwnProfile.mockRejectedValue(new ApiClientError('FORBIDDEN', 'Refusé.', status));

    render(await ouvrirLaCoquille());

    expect(screen.queryByRole('navigation', { name: 'Sections du tableau de bord' })).toBeNull();
    expect(screen.getByText('contenu de l’écran')).toBeTruthy();
  });

  it('ne peint aucun rail sans session — l’écran de connexion n’a nulle part où aller', async () => {
    readAdminAccessToken.mockResolvedValue(null);

    render(await ouvrirLaCoquille());

    expect(screen.queryByRole('navigation', { name: 'Sections du tableau de bord' })).toBeNull();
    expect(fetchOwnProfile).not.toHaveBeenCalled();
  });

  it('ne peint aucun rail à un compte client, même si la vitrine publique tombe', async () => {
    // Le repli du rang ne doit pas devenir une porte dérobée : un compte `client`
    // reconnu reste sans sommaire, quoi qu'il arrive à l'autre appel.
    fetchOwnProfile.mockResolvedValue({
      id: 'compte-2',
      firstName: 'Noro',
      lastName: 'Andria',
      role: 'client',
    });
    fetchPublicTenant.mockRejectedValue(PANNE);

    render(await ouvrirLaCoquille());

    expect(screen.queryByRole('navigation', { name: 'Sections du tableau de bord' })).toBeNull();
  });
});

describe('encart d’échec — la reprise que l’écran n’offrait pas', () => {
  it('offre « Réessayer », et la reprise relance la page sans la quitter', async () => {
    render(adminLoadFailure(PANNE, SLUG, DENIAL));

    const reprise = screen.getByRole('button', { name: 'Réessayer' });
    await userEvent.click(reprise);

    // `router.refresh()` et non une navigation : l'URL ne bouge pas, et l'état
    // des composants clients déjà montés — donc les saisies en cours — survit,
    // comme l'exige `docs/design/appointments/states.md`.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('annonce l’échec aux lecteurs d’écran sans attendre une pause', () => {
    render(adminLoadFailure(PANNE, SLUG, DENIAL));

    expect(screen.getByRole('alert').textContent).toContain(DENIAL.failedTitle);
  });

  it('ne parle plus « du service de réservation » sur un écran de comptoir', () => {
    render(adminLoadFailure(PANNE, SLUG, DENIAL));

    expect(document.body.textContent).not.toContain('service de réservation');
    expect(document.body.textContent).toContain('Le serveur du salon est momentanément injoignable.');
  });

  it('laisse tel quel le message d’une erreur que l’API a nommée', () => {
    // La réécriture ne vise que la panne, reconnue à son `code` : tout autre
    // échec garde le message que l'API a écrit pour lui.
    render(
      adminLoadFailure(
        new ApiClientError('INTERNAL_ERROR', 'Une erreur inattendue est survenue.', 500),
        SLUG,
        DENIAL,
      ),
    );

    expect(document.body.textContent).toContain('Une erreur inattendue est survenue.');
  });

  it('n’offre pas de reprise sur un refus de rôle, qui rendrait le même refus', () => {
    render(adminLoadFailure(new ApiClientError('FORBIDDEN', 'Accès refusé.', 403), SLUG, DENIAL));

    expect(screen.getByText(DENIAL.deniedHint)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
  });

  it('renvoie toujours à la connexion sur un 401, sans rien peindre', () => {
    expect(() =>
      adminLoadFailure(new ApiClientError('UNAUTHORIZED', 'Session expirée.', 401), SLUG, DENIAL),
    ).toThrow(`NEXT_REDIRECT:/${SLUG}/admin/connexion`);
  });
});
