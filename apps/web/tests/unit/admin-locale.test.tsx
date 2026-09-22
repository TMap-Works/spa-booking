import type { ApiSession } from '@/lib/api-client';
import type { SessionUser, Tenant } from '@spa/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantSettingsForm } from '@/app/(admin)/[tenantSlug]/admin/components/tenant-settings-form';
import { MemberLocaleForm } from '@/app/(admin)/[tenantSlug]/admin/reglages/components/member-locale-form';
import { attachAdminSession, clearAdminSession } from '@/app/(admin)/[tenantSlug]/admin/session';
import { ACCOUNT_LOCALE_COOKIE, LOCALE_COOKIE } from '@/i18n/cookies';

/**
 * La langue dans le back-office — #853, deuxième, troisième et quatrième
 * critères d'acceptation.
 *
 * Trois choses y sont tenues, et chacune répond à un critère :
 *
 * 1. **les réglages proposent la langue par défaut de l'établissement**, avec la
 *    phrase qui dit à quoi elle sert, et un salon qui n'a rien choisi ouvre
 *    l'écran sur `en` — la valeur par défaut de la colonne (#844) ;
 * 2. **un membre de l'équipe enregistre sa langue préférée**, et « aucune » en
 *    est une valeur : le contrat lit `locale: null` comme « la langue de
 *    l'établissement tranche » ;
 * 3. **après sa connexion, le back-office s'affiche dans cette langue** : la
 *    session recopie la préférence du compte dans le miroir que lit l'ordre de
 *    résolution (`i18n/resolve.ts`, étape « compte »).
 *
 * Le troisième point porte aussi ce qu'il ne fait **pas**, et c'est ce qui
 * distingue le back-office de l'espace client : le cookie du sélecteur de langue
 * n'est jamais effacé à l'ouverture de session. Ce geste-là est juste une fois,
 * au moment où la personne enregistre sa préférence ; rejoué à chaque
 * renouvellement silencieux — toutes les quelques minutes sur un poste de
 * comptoir —, il ferait disparaître tout seul le choix fait au sélecteur du rail.
 */

const updateTenantSettingsAction = vi.fn();
const saveMemberLocaleAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  updateTenantSettingsAction: (...args: unknown[]) => updateTenantSettingsAction(...args),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/reglages/actions', () => ({
  saveMemberLocaleAction: (...args: unknown[]) => saveMemberLocaleAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: vi.fn() }),
}));

/** Un salon qui n'a jamais choisi sa langue : la colonne vaut son défaut, `en`. */
const tenant: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'spa-lumiere',
  name: 'Spa Lumière',
  timezone: 'Indian/Antananarivo',
  defaultCurrency: 'MGA',
  defaultLocale: 'en',
  isActive: true,
  receiptPrefix: 'TIC',
  taxRateBps: 0,
  openingHours: [{ weekday: 1, opensAt: '09:00', closesAt: '12:00' }],
};

const member: SessionUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'adele@spa-lumiere.mg',
  role: 'staff',
  firstName: 'Adèle',
  lastName: 'Andria',
  phone: null,
  locale: null,
};

afterEach(() => {
  cleanup();
  updateTenantSettingsAction.mockReset();
  saveMemberLocaleAction.mockReset();
  refresh.mockReset();
});

/**
 * Un magasin de cookies qui retient ce qu'on lui pose — même doublure que
 * `account-locale.test.tsx`, et pour la même raison : ces fonctions écrivent des
 * cookies et ne font rien d'autre, ce qui se vérifie sans serveur.
 */
function magasin(): {
  readonly set: ReturnType<typeof vi.fn>;
  pose(nom: string): boolean;
  valeur(nom: string): string | undefined;
  duree(nom: string): number | undefined;
} {
  const set = vi.fn();
  const dernier = (nom: string): unknown[] | undefined =>
    [...(set.mock.calls as unknown[][])].reverse().find((call) => call[0] === nom);

  return {
    set,
    pose: (nom) => dernier(nom) !== undefined,
    valeur: (nom) => dernier(nom)?.[1] as string | undefined,
    duree: (nom) => (dernier(nom)?.[2] as { maxAge: number } | undefined)?.maxAge,
  };
}

/** Une session ouverte par l'API, pour un compte dont la langue est celle-ci. */
function ouverte(locale: SessionUser['locale']): ApiSession {
  return {
    session: {
      accessToken: 'jeton-d-acces',
      expiresIn: 900,
      user: { ...member, locale },
    },
    refreshToken: 'jeton-de-rafraichissement',
    refreshTokenMaxAge: 604_800,
  };
}

describe('les réglages proposent la langue par défaut de l’établissement (#844)', () => {
  it('présente `en` pour un salon qui n’a rien choisi', () => {
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    const champ = screen.getByRole<HTMLSelectElement>('combobox', {
      name: /Langue de l’établissement/,
    });

    // La valeur affichée est celle du contrat, et la colonne est `NOT NULL` avec
    // `en` pour défaut : un salon qui n'a jamais choisi ouvre donc l'écran sur
    // l'anglais, et non sur un champ vide qui laisserait croire à un réglage
    // manquant.
    expect(champ.value).toBe('en');
    // Chaque langue est nommée dans sa propre langue — les valeurs de
    // `locale.names`, communes aux deux catalogues (#845).
    expect([...champ.options].map((option) => option.textContent)).toEqual([
      'Français',
      'English',
    ]);
  });

  it('dit à quoi elle sert, faute de quoi rien ne le laisse deviner', () => {
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    // Les deux emplois que #844 lui donne, et les seuls : les notifications des
    // clientes sans préférence, et les visiteurs dont le navigateur ne demande
    // ni l'une ni l'autre des deux langues (quatrième étape de l'ordre de
    // résolution). Ce n'est pas la langue de cet écran-ci.
    const aide = screen.getByText(/notifications envoyées aux clientes sans préférence/);

    expect(aide.textContent).toContain('ni le français ni l’anglais');
  });

  it('envoie la langue choisie avec le reste des réglages', async () => {
    const user = userEvent.setup();
    updateTenantSettingsAction.mockResolvedValue({ ok: true });
    render(<TenantSettingsForm tenant={tenant} tenantSlug="spa-lumiere" />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Langue de l’établissement/ }),
      'fr',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      expect(updateTenantSettingsAction).toHaveBeenCalledTimes(1);
    });

    const [, changes] = updateTenantSettingsAction.mock.calls[0] as [
      string,
      { defaultLocale?: string },
    ];

    expect(changes.defaultLocale).toBe('fr');
  });
});

describe('un membre de l’équipe enregistre sa langue préférée (#853)', () => {
  it('offre les deux langues et « aucune », qui rend la main à l’établissement', () => {
    render(<MemberLocaleForm profile={member} tenantSlug="spa-lumiere" />);

    const champ = screen.getByRole<HTMLSelectElement>('combobox', {
      name: /Langue du back-office/,
    });

    // Un compte sans préférence ouvre l'écran sur « Langue de l'établissement » :
    // `locale: null` se lit « aucune préférence » et non « anglais » (#844).
    expect(champ.value).toBe('');
    expect([...champ.options].map((option) => option.value)).toEqual(['', 'fr', 'en']);
  });

  it('n’enregistre rien tant que rien n’a changé', () => {
    render(<MemberLocaleForm profile={{ ...member, locale: 'en' }} tenantSlug="spa-lumiere" />);

    // Le même « rien à enregistrer » que l'écran des coordonnées obtient
    // d'`isDirty` : un bouton actif qui ne changerait rien promet un effet qui
    // n'existe pas.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Enregistrer ma langue' }).disabled,
    ).toBe(true);
  });

  it('enregistre la langue choisie et le dit', async () => {
    const user = userEvent.setup();
    saveMemberLocaleAction.mockResolvedValue({ ok: true, data: { ...member, locale: 'en' } });
    render(<MemberLocaleForm profile={member} tenantSlug="spa-lumiere" />);

    await user.selectOptions(
      screen.getByRole('combobox', { name: /Langue du back-office/ }),
      'en',
    );
    await user.click(screen.getByRole('button', { name: 'Enregistrer ma langue' }));

    await waitFor(() => {
      expect(saveMemberLocaleAction).toHaveBeenCalledWith('spa-lumiere', 'en');
    });

    // Le choix s'applique tout de suite : la coquille et l'écran sont rendus
    // côté serveur, et sans ce rafraîchissement la page resterait peinte dans la
    // langue d'avant — un réglage qui semblerait n'avoir pas pris.
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('Langue enregistrée')).toBeTruthy();
  });

  it('retire la préférence quand on repose « Langue de l’établissement »', async () => {
    const user = userEvent.setup();
    saveMemberLocaleAction.mockResolvedValue({ ok: true, data: member });
    render(<MemberLocaleForm profile={{ ...member, locale: 'fr' }} tenantSlug="spa-lumiere" />);

    await user.selectOptions(screen.getByRole('combobox', { name: /Langue du back-office/ }), '');
    await user.click(screen.getByRole('button', { name: 'Enregistrer ma langue' }));

    // La chaîne vide est ce qu'un `<select>` transporte pour « rien » ; c'est
    // l'action qui la convertit en `null`, la valeur par laquelle le contrat
    // **retire** la préférence.
    await waitFor(() => {
      expect(saveMemberLocaleAction).toHaveBeenCalledWith('spa-lumiere', '');
    });
  });

  it('ne promet rien quand le compte n’a pas pu être lu', () => {
    render(<MemberLocaleForm profile={null} tenantSlug="spa-lumiere" />);

    // Un sélecteur pré-rempli à « aucune » aurait affirmé une préférence qu'on
    // ignore, et l'enregistrer aurait effacé celle de la personne.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Préférence indisponible')).toBeTruthy();
  });
});

describe('la session du back-office recopie la langue du compte (#853)', () => {
  it('pose le miroir que lit l’ordre de résolution', () => {
    const cookies = magasin();

    attachAdminSession(cookies, 'spa-lumiere', ouverte('en'));

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('en');
  });

  it('efface le miroir d’un compte sans préférence, plutôt que d’en inventer une', () => {
    const cookies = magasin();

    attachAdminSession(cookies, 'spa-lumiere', ouverte(null));

    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('');
    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
  });

  it('ne touche jamais au choix du sélecteur — il survit aux renouvellements', () => {
    const cookies = magasin();

    attachAdminSession(cookies, 'spa-lumiere', ouverte('en'));

    // C'est ce qui sépare cette surface de l'espace client : `attachAdminSession`
    // est rejouée à chaque renouvellement silencieux, et effacer le cookie du
    // sélecteur ferait disparaître tout seul, en cours de journée, le choix fait
    // au rail.
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });

  it('emporte le miroir à la déconnexion, et lui seul', () => {
    const cookies = magasin();

    clearAdminSession(cookies, 'spa-lumiere');

    // Le miroir décrit le compte connecté : le laisser en place ferait servir la
    // langue de la personne du matin sur un poste de comptoir partagé. Le choix
    // du sélecteur, lui, appartient au navigateur — qui se déconnecte garde la
    // langue qu'il lisait.
    expect(cookies.valeur(ACCOUNT_LOCALE_COOKIE)).toBe('');
    expect(cookies.duree(ACCOUNT_LOCALE_COOKIE)).toBe(0);
    expect(cookies.pose(LOCALE_COOKIE)).toBe(false);
  });
});
