import type { PublicTenant } from '@spa/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SalonAuthScreen } from '@/components/auth/salon-auth-screen';
import { PLATFORM_NAME } from '@/lib/platform';

import { tenant } from './fixtures';

/**
 * #1052 — le salon d'abord sur la connexion et l'inscription clientes.
 *
 * Audit `d20260918-1`, critère `ds:mobile`. Ce que la suite protège :
 *
 * - **le salon est le premier élément lu**, et la plateforme n'est plus nommée
 *   dans le cadre du tout — elle vit dans le pied du gabarit (#1045) ;
 * - **les deux écrans ne disent pas la même chose** : « Bienvenue chez … »
 *   accueille qui revient, « Créez votre compte … » s'adresse à qui arrive. Ce
 *   titre-là est précisément ce qui a fait sortir le cadre du gabarit ;
 * - **le volet dit ce que ce salon est** — son adresse, son état d'ouverture à
 *   son horloge à lui (ADR 0006) — là où trois puces valaient pour tous ;
 * - **le mot de passe s'affiche et se masque au clavier** (WCAG 2.2, 3.3.8) ;
 * - **une panne de la fiche n'emporte pas l'écran** : le formulaire reste servi.
 *
 * Ce que la feuille de style seule tient — la bande de 96 px à 360 px — est
 * vérifié par `tests/auth-salon-mise-en-page.test.mjs` : jsdom ne peint rien.
 */

const accountTenant = vi.fn();
const readAccessToken = vi.fn();
const readRefreshToken = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/tenant', () => ({
  accountTenant: (...args: unknown[]) => accountTenant(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/session', () => ({
  readAccessToken: () => readAccessToken(),
  readRefreshToken: () => readRefreshToken(),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  loginAction: vi.fn(),
  registerAction: vi.fn(),
}));

import LoginPage from '@/app/(account)/[tenantSlug]/compte/connexion/page';
import RegisterPage from '@/app/(account)/[tenantSlug]/compte/inscription/page';

/** Un salon qui a publié son adresse et sa semaine — de quoi peupler le volet. */
const SALON: PublicTenant = {
  ...tenant,
  address: {
    line1: '12 rue des Lilas',
    postalCode: '101',
    city: 'Antananarivo',
    country: 'MG',
  },
  openingHours: [
    { weekday: 1, opensAt: '09:00', closesAt: '19:00' },
    { weekday: 6, opensAt: '10:00', closesAt: '18:00' },
  ],
};

/** Un lundi, 12 h à Antananarivo (UTC+3) : le salon est ouvert, il ferme à 19:00. */
const LUNDI_MIDI = new Date('2026-09-21T09:00:00.000Z');

beforeEach(() => {
  // Sans session : c'est l'état ordinaire des deux écrans.
  readAccessToken.mockResolvedValue(null);
  readRefreshToken.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('le volet d’accueil — l’identité du salon, et non celle de l’éditeur', () => {
  function rendre(tenantLu: PublicTenant | null, now = LUNDI_MIDI): HTMLElement {
    const { container } = render(
      <SalonAuthScreen tenant={tenantLu} intent="connexion" now={now}>
        <p>le formulaire</p>
      </SalonAuthScreen>,
    );
    return container;
  }

  it('ouvre sur le salon, jamais sur la plateforme', () => {
    const page = rendre(SALON);

    const cadre = page.querySelector<HTMLElement>('.spa-auth--salon');
    expect(cadre).not.toBeNull();
    expect(within(cadre as HTMLElement).getByText(SALON.name)).toBeDefined();
    // La marque de l'éditeur est descendue en mention « propulsé par », dans le
    // pied du gabarit : elle n'a plus rien à faire dans le cadre.
    expect(within(cadre as HTMLElement).queryByText(PLATFORM_NAME)).toBeNull();
  });

  it('dit où est le salon et s’il est ouvert, à son horloge à lui', () => {
    rendre(SALON);

    const faits = screen.getByRole('list', { name: 'Le salon en bref' });

    expect(within(faits).getByText('12 rue des Lilas')).toBeDefined();
    expect(within(faits).getByText('101 Antananarivo')).toBeDefined();
    expect(within(faits).getByText('Ouvert — ferme à 19:00')).toBeDefined();
  });

  it('se tait plutôt que d’inventer quand le salon n’a rien publié', () => {
    rendre(tenant);

    // Ni adresse ni horaires sur la fiche : aucun fait. Trois puces génériques
    // valaient moins que le silence — c'est le constat même de l'audit.
    expect(screen.queryByRole('list', { name: 'Le salon en bref' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      `Bienvenue chez ${tenant.name}`,
    );
  });

  it('sert quand même l’écran quand la fiche n’a pas pu être lue', () => {
    rendre(null);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bienvenue');
    expect(screen.getByText('le formulaire')).toBeDefined();
  });
});

describe('les deux écrans ne s’adressent pas à la même personne', () => {
  it('« Bienvenue chez … » sur la connexion', async () => {
    accountTenant.mockResolvedValue(SALON);

    render(
      await LoginPage({
        params: Promise.resolve({ tenantSlug: SALON.slug }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      `Bienvenue chez ${SALON.name}`,
    );
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDefined();
  });

  it('« Créez votre compte … » sur l’inscription', async () => {
    accountTenant.mockResolvedValue(SALON);

    render(await RegisterPage({ params: Promise.resolve({ tenantSlug: SALON.slug }) }));

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      `Créez votre compte ${SALON.name}`,
    );
    expect(screen.getByRole('button', { name: /Créer mon compte/ })).toBeDefined();
  });

  it('descend son titre d’un rang quand le gabarit en porte déjà un', async () => {
    // `session/refresh` **conserve** les cookies quand le renouvellement échoue
    // sans être refusé, et renvoie ici avec `?motif=renouvellement-indisponible`
    // (#860). Le gabarit prend alors sa branche « connecté·e » et écrit
    // « Bonjour … » en `h1` : un second `h1` ferait deux titres de premier
    // niveau sur le même écran.
    accountTenant.mockResolvedValue(SALON);
    readRefreshToken.mockResolvedValue('un-jeton-de-rafraichissement');

    render(
      await LoginPage({
        params: Promise.resolve({ tenantSlug: SALON.slug }),
        searchParams: Promise.resolve({ motif: 'renouvellement-indisponible' }),
      }),
    );

    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByText(`Bienvenue chez ${SALON.name}`)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDefined();
  });

  it('garde le formulaire de connexion quand la fiche du salon tombe', async () => {
    accountTenant.mockRejectedValue(new Error('API indisponible'));

    render(
      await LoginPage({
        params: Promise.resolve({ tenantSlug: SALON.slug }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bienvenue');
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeDefined();
  });
});

describe('le mot de passe s’affiche et se masque au clavier (WCAG 2.2, 3.3.8)', () => {
  async function connexion(): Promise<void> {
    accountTenant.mockResolvedValue(SALON);

    render(
      await LoginPage({
        params: Promise.resolve({ tenantSlug: SALON.slug }),
        searchParams: Promise.resolve({}),
      }),
    );
  }

  it('bascule au clavier, et le bouton change de nom avec son effet', async () => {
    const user = userEvent.setup();
    await connexion();

    const champ = screen.getByLabelText(/Mot de passe/);
    expect(champ.getAttribute('type')).toBe('password');
    expect(champ.getAttribute('autocomplete')).toBe('current-password');

    // Depuis le champ, la bascule est la cible suivante : on n'a besoin ni de
    // souris ni de savoir qu'elle existe.
    await user.click(champ);
    await user.tab();
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/Mot de passe/).getAttribute('type')).toBe('text');
    expect(screen.getByRole('button', { name: 'Masquer le mot de passe' })).toBeDefined();

    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/Mot de passe/).getAttribute('type')).toBe('password');
    expect(screen.getByRole('button', { name: 'Afficher le mot de passe' })).toBeDefined();
  });
});

describe('l’inscription coche le critère de longueur en direct (#1044)', () => {
  it('change l’aide du champ dès la douzième frappe, sans soumettre', async () => {
    accountTenant.mockResolvedValue(SALON);
    const user = userEvent.setup();

    render(await RegisterPage({ params: Promise.resolve({ tenantSlug: SALON.slug }) }));

    const champ = screen.getByLabelText(/Mot de passe/);
    expect(screen.getByText('12 caractères au minimum.')).toBeDefined();
    // L'aide est bien celle du champ : un lecteur d'écran l'annonce en y
    // arrivant (web-frontend §4), et non un texte posé à côté.
    expect(champ.getAttribute('aria-describedby')).toContain('register-password-hint');

    await user.type(champ, 'onze-carac');
    expect(screen.getByText('12 caractères au minimum.')).toBeDefined();

    await user.type(champ, 'tères');
    expect(screen.getByText('12 caractères : c’est bon.')).toBeDefined();
    expect(screen.queryByText('12 caractères au minimum.')).toBeNull();
  });
});
