import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountLayout from '@/app/(account)/[tenantSlug]/compte/layout';
import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';

import { tenant } from './fixtures';

/*
 * Le gabarit de l'espace client — navigation, en-tête et pied (#747, #749, #1045).
 *
 * Ce que la suite protège, depuis que l'espace client porte le gabarit du salon :
 *
 * - la navigation de l'espace (« Mes rendez-vous · Mes coordonnées ») est servie
 *   par le gabarit sur **tous** ses écrans, hors de `<main>` et avant lui ;
 * - « Se déconnecter » est dans le menu du compte, sur tous les écrans connectés
 *   — c'est lui qui manquait sur deux écrans sur trois avant #747 ;
 * - rien de tout cela sur la connexion sans session, où ces entrées
 *   proposeraient de fermer une session qui n'est pas ouverte ;
 * - une session renouvelable garde l'en-tête, pour qu'il ne clignote pas à
 *   chaque expiration ;
 * - aucun lien ne ramène la connexion à elle-même (#749).
 */

const readAccessToken = vi.fn();
const readRefreshToken = vi.fn();
const accountTenant = vi.fn();
const readAccountPresence = vi.fn();

const COMPTE = `/${tenant.slug}/compte`;
const COORDONNEES = `${COMPTE}/coordonnees`;
const REPORT = `${COMPTE}/rendez-vous/3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60/report`;
const CONNEXION = `${COMPTE}/connexion`;

let pathname = COMPTE;

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw new Error('notFound');
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
}));

vi.mock('@/lib/account-presence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-presence')>()),
  readAccountPresence: () => readAccountPresence(),
}));

type Session = 'ouverte' | 'a-renouveler' | 'absente';

async function rendreLeGabarit(
  session: Session,
  ecran: string = COMPTE,
  presence: { firstName: string; lastName: string } | null = { firstName: 'Alice', lastName: 'Marchand' },
): Promise<HTMLElement> {
  pathname = ecran;
  accountTenant.mockResolvedValue(tenant);
  readAccessToken.mockResolvedValue(session === 'ouverte' ? 'jeton-de-test' : null);
  readRefreshToken.mockResolvedValue(session === 'absente' ? null : 'jeton-de-rafraichissement');
  readAccountPresence.mockResolvedValue(session === 'absente' ? null : presence);

  const { container } = render(
    await AccountLayout({
      children: (<p>contenu de l’écran</p>) as ReactNode,
      params: Promise.resolve({ tenantSlug: tenant.slug }),
    }),
  );

  return container;
}

/** Ouvre le menu du compte et rend son panneau. */
function ouvrirLeMenu(): HTMLElement {
  const bouton = screen.getByRole('button', { name: /Mon compte/ });
  fireEvent.click(bouton);
  const panneau = document.getElementById(bouton.getAttribute('aria-controls') ?? '');
  if (panneau === null) {
    throw new Error('le bouton du compte doit commander un panneau');
  }
  return panneau;
}

afterEach(() => {
  cleanup();
  pathname = COMPTE;
  readAccessToken.mockReset();
  readRefreshToken.mockReset();
  accountTenant.mockReset();
  readAccountPresence.mockReset();
});

describe('la navigation de l’espace client', () => {
  it.each([
    ['la liste des rendez-vous', COMPTE],
    ['les coordonnées', COORDONNEES],
    ['le report d’un rendez-vous', REPORT],
  ])('est servie par le gabarit sur %s, déconnexion comprise', async (_ecran, chemin) => {
    await rendreLeGabarit('ouverte', chemin);

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });
    expect(within(nav).getByRole('link', { name: 'Mes rendez-vous' })).toBeDefined();
    expect(within(nav).getByRole('link', { name: 'Mes coordonnées' })).toBeDefined();

    // « Se déconnecter » manquait sur deux écrans sur trois avant #747 : il est
    // maintenant dans le menu du compte, que le gabarit pose partout.
    expect(within(ouvrirLeMenu()).getByRole('button', { name: 'Se déconnecter' })).toBeDefined();
  });

  it('mène aux écrans de cet établissement, et pas d’un autre', async () => {
    await rendreLeGabarit('ouverte', REPORT);

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });
    expect(within(nav).getByRole('link', { name: 'Mes coordonnées' }).getAttribute('href')).toBe(
      COORDONNEES,
    );
    expect(within(nav).getByRole('link', { name: 'Mes rendez-vous' }).getAttribute('href')).toBe(
      COMPTE,
    );
  });

  it('se tient hors de <main>, et avant lui', async () => {
    const container = await rendreLeGabarit('ouverte');

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });
    const main = container.querySelector('main#contenu');

    if (main === null) {
      throw new Error('le gabarit doit rendre le contenu de l’écran');
    }

    // `<main>` porte le contenu de l'écran, pas sa navigation : rendue dedans,
    // la barre récupérerait le geste « aller au contenu principal ».
    expect(main.contains(nav)).toBe(false);
    expect(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it.each([
    ['les coordonnées', COORDONNEES, 'Mes coordonnées'],
    ['la liste', COMPTE, 'Mes rendez-vous'],
    ['le report, qui appartient aux rendez-vous', REPORT, 'Mes rendez-vous'],
  ])('marque l’onglet courant sur %s', async (_ecran, chemin, courant) => {
    await rendreLeGabarit('ouverte', chemin);

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });
    const actifs = within(nav)
      .getAllByRole('link')
      .filter((lien) => lien.getAttribute('aria-current') === 'page');
    expect(actifs.map((lien) => lien.textContent)).toEqual([courant]);
  });

  it('ne se peint pas sur l’écran de connexion, qui partage ce gabarit', async () => {
    await rendreLeGabarit('absente', CONNEXION);

    // « Se déconnecter » y offrirait de fermer une session qui n'est pas
    // ouverte, et « Mes coordonnées » mènerait à un écran qui renvoie ici.
    expect(screen.queryByRole('navigation', { name: 'Mon compte' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mon compte/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Se déconnecter', hidden: true })).toBeNull();
  });

  it('survit à un cookie d’accès expiré que le rafraîchissement va relever', async () => {
    await rendreLeGabarit('a-renouveler', COORDONNEES);

    // Sans cela l'en-tête clignoterait à chaque expiration, juste avant le
    // renouvellement qui le ramène.
    expect(screen.getByRole('navigation', { name: 'Mon compte' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Mon compte : Alice/ })).toBeDefined();
  });

  it('salue la cliente par son prénom, et laisse le contenu intact', async () => {
    await rendreLeGabarit('ouverte');

    expect(screen.getByText('contenu de l’écran')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Bonjour Alice' })).toBeDefined();
  });

  it('se titre « Mon compte » quand la session précède le cookie de présence', async () => {
    await rendreLeGabarit('ouverte', COMPTE, null);

    expect(screen.getByRole('heading', { level: 1, name: 'Mon compte' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Mon compte/ })).toBeDefined();
  });
});

describe('le pied de page du salon', () => {
  function pied(container: HTMLElement): HTMLElement {
    const footer = container.querySelector<HTMLElement>('footer.spa-shell__footer');

    if (footer === null) {
      throw new Error('le gabarit doit rendre le pied de page du salon');
    }

    return footer;
  }

  it.each([
    ['la liste', 'ouverte', COMPTE],
    ['la connexion', 'absente', CONNEXION],
  ] as const)('garde en toutes circonstances la sortie vers le tunnel — %s', async (_e, session, chemin) => {
    const container = await rendreLeGabarit(session, chemin);

    expect(
      within(pied(container))
        .getByRole('link', { name: PUBLIC_EXIT_LABELS.reservation })
        .getAttribute('href'),
    ).toBe(`/${tenant.slug}/reservation`);
  });

  it('ne nomme pas l’espace client, que l’en-tête porte déjà (#749)', async () => {
    const container = await rendreLeGabarit('absente', CONNEXION);

    // Depuis la connexion, un lien « Mon compte » ramenait à l'écran qu'on lisait :
    // `/compte` redirige vers la connexion quand aucune session n'est ouverte.
    expect(
      within(pied(container)).queryByRole('link', { name: PUBLIC_EXIT_LABELS.compte }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: 'Se connecter' })).toBeNull();
  });
});
