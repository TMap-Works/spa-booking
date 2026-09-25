import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixerLangue, nextIntlMobile } from '../support/langue-mobile';

/** Ce fichier, d'où part la racine d'`apps/web` lue par la garde de lint. */
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * « Se déconnecter » dans la langue de la session — #1124.
 *
 * ## Ce que la suite protège
 *
 * Le rail du back-office et le menu de l'espace client sont traduits depuis
 * #845 ; leur bouton de déconnexion, lui, a longtemps affiché « Se déconnecter »
 * en dur au milieu d'une coquille anglaise. #1180 et #1134 l'ont mis au
 * catalogue, chacun dans le sien — `admin-auth.logout` et `account.nav` —, et
 * #1124 le range là où la coquille lit ses propres mots : `shell.admin.rail` et
 * `shell.account`.
 *
 * Trois choses se vérifient donc ici, et chacune répond à un critère du ticket :
 *
 * 1. **les deux libellés viennent du namespace `shell`** — la suite lit les
 *    catalogues du dépôt, si bien qu'une clé rangée ailleurs la fait échouer ;
 * 2. **les deux langues** : « Se déconnecter » / « Sign out », et la phrase
 *    d'attente que les lecteurs d'écran annoncent pendant que la session se
 *    ferme ;
 * 3. **la règle de lint anti-texte-en-dur couvre les deux fichiers**, sans quoi
 *    un littéral pourrait y revenir sans qu'aucun outil ne le dise.
 *
 * ## Pourquoi une doublure de langue commutable
 *
 * L'amorce des suites fixe la langue à `fr` pour toutes
 * (`tests/support/next-intl.ts`). Rendre le même bouton dans les deux langues
 * demande de la remplacer par une doublure **commutable** : elle lit les vrais
 * catalogues, langue par langue, et c'est `fixerLangue()` qui choisit laquelle
 * avant chaque rendu. Cette doublure est écrite une fois pour toutes les suites
 * qui en ont besoin, dans `tests/support/langue-mobile.ts` (#1287).
 */

vi.mock('next-intl', () => nextIntlMobile());

const adminLogoutAction = vi.fn();
const logoutAction = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, refresh, push: vi.fn() }),
}));

vi.mock('@/app/(admin)/[tenantSlug]/admin/actions', () => ({
  adminLogoutAction: (...args: unknown[]) => adminLogoutAction(...args),
}));

vi.mock('@/app/(account)/[tenantSlug]/compte/actions', () => ({
  logoutAction: (...args: unknown[]) => logoutAction(...args),
}));

import { LogoutButton } from '@/app/(account)/[tenantSlug]/compte/components/logout-button';
import { AdminLogoutButton } from '@/app/(admin)/[tenantSlug]/admin/components/admin-logout-button';
import { loadMessages, type MessageTree } from '@/i18n/messages';

const SLUG = 'maison-lotus';

/**
 * Le message rangé à cette clé, ou l'échec de la clé manquante.
 *
 * Le catalogue est un arbre de chaînes sans forme connue de `tsc` : descendre
 * « à la main » demanderait une assertion de type par niveau, et une clé
 * déplacée s'y lirait `undefined` au lieu de nommer le chemin fautif.
 */
function message(tree: MessageTree, chemin: string): string {
  let courant: MessageTree | string = tree;

  for (const segment of chemin.split('.')) {
    if (typeof courant === 'string') {
      throw new Error(`« ${chemin} » traverse un message, pas un groupe`);
    }

    const suivant: MessageTree | string | undefined = courant[segment];

    if (suivant === undefined) {
      throw new Error(`« ${chemin} » manque au catalogue`);
    }

    courant = suivant;
  }

  if (typeof courant !== 'string') {
    throw new Error(`« ${chemin} » désigne un groupe, pas un message`);
  }

  return courant;
}

/** Les deux libellés attendus, langue par langue. */
const ATTENDU = {
  fr: { signOut: 'Se déconnecter', signingOut: 'Déconnexion en cours…' },
  en: { signOut: 'Sign out', signingOut: 'Signing out…' },
} as const;

beforeEach(() => {
  adminLogoutAction.mockResolvedValue(undefined);
  logoutAction.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  fixerLangue('fr');
});

describe('le bouton de déconnexion du rail du back-office', () => {
  it.each(['fr', 'en'] as const)('se nomme dans la langue de la session — %s', (locale) => {
    fixerLangue(locale);
    render(<AdminLogoutButton tenantSlug={SLUG} />);

    expect(screen.getByRole('button', { name: ATTENDU[locale].signOut })).toBeDefined();
  });

  it.each(['fr', 'en'] as const)('dit l’attente dans la même langue — %s', async (locale) => {
    // L'action ne se résout jamais : le bouton reste sur son état d'attente, qui
    // est justement ce qu'on vient lire.
    adminLogoutAction.mockImplementation(() => new Promise<void>(() => {}));
    fixerLangue(locale);
    render(<AdminLogoutButton tenantSlug={SLUG} />);

    await userEvent.click(screen.getByRole('button', { name: ATTENDU[locale].signOut }));

    expect(await screen.findByText(ATTENDU[locale].signingOut)).toBeDefined();
  });

  it('ferme la session du salon qu’on lui donne, quelle que soit la langue', async () => {
    fixerLangue('en');
    render(<AdminLogoutButton tenantSlug={SLUG} />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    // Traduire un libellé ne doit rien changer au geste qu'il déclenche.
    expect(adminLogoutAction).toHaveBeenCalledWith(SLUG);
    expect(replace).toHaveBeenCalledWith(`/${SLUG}/admin/connexion`);
  });
});

describe('le bouton de déconnexion du menu de l’espace client', () => {
  it.each(['fr', 'en'] as const)('se nomme dans la langue de la session — %s', (locale) => {
    fixerLangue(locale);
    render(<LogoutButton tenantSlug={SLUG} />);

    expect(screen.getByRole('button', { name: ATTENDU[locale].signOut })).toBeDefined();
  });

  it.each(['fr', 'en'] as const)('dit l’attente dans la même langue — %s', async (locale) => {
    logoutAction.mockImplementation(() => new Promise<void>(() => {}));
    fixerLangue(locale);
    render(<LogoutButton tenantSlug={SLUG} />);

    await userEvent.click(screen.getByRole('button', { name: ATTENDU[locale].signOut }));

    expect(await screen.findByText(ATTENDU[locale].signingOut)).toBeDefined();
  });

  it('ferme la session du salon qu’on lui donne, quelle que soit la langue', async () => {
    fixerLangue('en');
    render(<LogoutButton tenantSlug={SLUG} />);

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(logoutAction).toHaveBeenCalledWith(SLUG);
    expect(replace).toHaveBeenCalledWith(`/${SLUG}/compte/connexion`);
  });
});

describe('les libellés viennent du namespace de la coquille', () => {
  /**
   * Le premier critère de #1124 porte sur le **rangement** des clés, et non
   * seulement sur le fait qu'elles existent : les deux boutons rendent les mêmes
   * mots qu'avant, si bien qu'une suite qui ne lirait que l'écran passerait au
   * vert avec les clés restées au catalogue des écrans d'authentification.
   */
  it.each(['fr', 'en'] as const)('porte les quatre clés dans « %s »', (locale) => {
    const catalog = loadMessages(locale);

    expect(message(catalog, 'shell.admin.rail.signOut')).toBe(ATTENDU[locale].signOut);
    expect(message(catalog, 'shell.admin.rail.signingOut')).toBe(ATTENDU[locale].signingOut);
    expect(message(catalog, 'shell.account.signOut')).toBe(ATTENDU[locale].signOut);
    expect(message(catalog, 'shell.account.signingOut')).toBe(ATTENDU[locale].signingOut);
  });
});

describe('la règle de lint anti-texte-en-dur couvre les deux boutons', () => {
  /**
   * Le deuxième critère de #1124. Sans cette garde, retirer la ligne du marqueur
   * ne ferait échouer aucun test : `eslint` passerait sans rien regarder, et le
   * premier « Se déconnecter » réécrit en dur reviendrait sans un mot.
   */
  it('vise le bouton du rail et le sous-arbre de l’espace client', async () => {
    const { i18nLintedGlobs } = await import('../../eslint-rules/i18n-markers.mjs');
    const globs: readonly string[] = i18nLintedGlobs(path.join(here, '..', '..'));

    expect(globs).toContain(
      'app/\\(admin\\)/\\[tenantSlug\\]/admin/components/admin-logout-button.tsx',
    );
    // Le marqueur de l'espace client est vide depuis #847 : il couvre tout le
    // sous-arbre, `components/logout-button.tsx` compris.
    expect(globs).toContain('app/\\(account\\)/\\[tenantSlug\\]/compte/**/*.{ts,tsx}');
  });
});
