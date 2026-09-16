import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountLayout from '@/app/(account)/[tenantSlug]/compte/layout';

import { tenant } from './fixtures';

/**
 * La navigation de l'espace client, servie par **tous** ses écrans connectés —
 * #747.
 *
 * ## La référence, et l'écart qu'elle nomme
 *
 * Audit de conception `d20260916-1`, critère `ds:coherence` : *la même action se
 * trouve au même endroit d'un écran à l'autre d'un même espace*. Le CDC §2.4 ne
 * connaît qu'une entité `User` pour les trois écrans du compte — pas une par
 * page.
 *
 * Le constat : « Modifier mes coordonnées | Se déconnecter » était rendue par
 * `page.tsx`. Elle n'existait donc que sur `/{slug}/compte`. Sur
 * `/{slug}/compte/coordonnees` et sur `/{slug}/compte/rendez-vous/{id}/report`,
 * « Se déconnecter » n'existait **nulle part** : fermer sa session depuis
 * l'écran de ses coordonnées demandait de revenir d'abord en arrière.
 *
 * ## Ce que cette suite protège, et qui est plus étroit que « la barre existe »
 *
 * - elle est servie par le **gabarit**, donc par les trois écrans connectés à la
 *   fois. L'assertion porte sur `layout.tsx` et non sur un écran : c'est le seul
 *   endroit d'où une barre peut être commune, et la reposer un jour dans une
 *   page rouvrirait l'écart sur les deux autres ;
 * - **les deux entrées** y sont, le lien et le bouton. Une barre qui ne
 *   porterait que le lien laisserait intact le défaut relevé — c'est
 *   « Se déconnecter » qui manquait ;
 * - elle est **hors de `<main>`**, et avant lui. `<main>` porte le contenu de
 *   l'écran, pas sa navigation : rendue dedans, la barre récupère le geste
 *   « aller au contenu principal » d'un lecteur d'écran, et l'ordre du document
 *   cesse d'énoncer d'abord où aller puis ce qu'on lit (WCAG 1.3.2) ;
 * - elle **ne se peint pas sans session**. Connexion et inscription partagent ce
 *   gabarit ; leur offrir « Se déconnecter » proposerait de fermer une session
 *   qui n'est pas ouverte ;
 * - un cookie d'accès expiré mais **rafraîchissable** garde la barre : sans
 *   cela, elle clignoterait à chaque expiration, juste avant le renouvellement
 *   qui la ramène ;
 * - le lien reste présent sur l'écran qu'il désigne, `aria-current="page"` en
 *   plus. Le retirer là rendrait la barre différente d'un écran à l'autre,
 *   c'est-à-dire l'écart qu'on corrige.
 */

const readAccessToken = vi.fn();
const readRefreshToken = vi.fn();
const accountTenant = vi.fn();

const COMPTE = `/${tenant.slug}/compte`;
const COORDONNEES = `${COMPTE}/coordonnees`;
const REPORT = `${COMPTE}/rendez-vous/3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60/report`;
const CONNEXION = `${COMPTE}/connexion`;

/**
 * Le chemin courant, piloté par le test — `AccountNav` le lit pour marquer son
 * entrée, et le gabarit n'est pas rejoué d'un écran à l'autre du segment.
 */
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

/** La session telle que la voient les deux lectures de cookie du gabarit. */
type Session = 'ouverte' | 'a-renouveler' | 'absente';

async function rendreLeGabarit(
  session: Session,
  ecran: string = COMPTE,
): Promise<HTMLElement> {
  pathname = ecran;
  accountTenant.mockResolvedValue(tenant);
  readAccessToken.mockResolvedValue(session === 'ouverte' ? 'jeton-de-test' : null);
  readRefreshToken.mockResolvedValue(session === 'absente' ? null : 'jeton-de-rafraichissement');

  const { container } = render(
    await AccountLayout({
      children: (<p>contenu de l’écran</p>) as ReactNode,
      params: Promise.resolve({ tenantSlug: tenant.slug }),
    }),
  );

  return container;
}

afterEach(() => {
  cleanup();
  pathname = COMPTE;
  readAccessToken.mockReset();
  readRefreshToken.mockReset();
  accountTenant.mockReset();
});

describe('la navigation de l’espace client', () => {
  it.each([
    ['la liste des rendez-vous', COMPTE],
    ['les coordonnées', COORDONNEES],
    ['le report d’un rendez-vous', REPORT],
  ])('est servie par le gabarit sur %s', async (_ecran, chemin) => {
    await rendreLeGabarit('ouverte', chemin);

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });

    // Les deux entrées, et pas seulement le lien : c'est « Se déconnecter » qui
    // manquait sur deux écrans sur trois.
    expect(within(nav).getByRole('link', { name: 'Modifier mes coordonnées' })).toBeDefined();
    expect(within(nav).getByRole('button', { name: 'Se déconnecter' })).toBeDefined();
  });

  it('mène aux coordonnées de cet établissement, et pas d’un autre', async () => {
    await rendreLeGabarit('ouverte', REPORT);

    const nav = screen.getByRole('navigation', { name: 'Mon compte' });

    expect(
      within(nav).getByRole('link', { name: 'Modifier mes coordonnées' }).getAttribute('href'),
    ).toBe(COORDONNEES);
  });

  it('se tient hors de <main>, et avant lui', async () => {
    const container = await rendreLeGabarit('ouverte');

    const nav = container.querySelector('nav.spa-account__nav');
    const main = container.querySelector('main#contenu');

    if (nav === null || main === null) {
      throw new Error('le gabarit doit rendre la barre du compte et le contenu');
    }

    // `<main>` porte le contenu de l'écran, pas sa navigation : rendue dedans,
    // la barre récupérerait le geste « aller au contenu principal ».
    expect(main.contains(nav)).toBe(false);
    // Et elle précède le contenu, plutôt que de le suivre : c'est l'ordre dans
    // lequel un lecteur d'écran et une tabulation la rencontrent.
    expect(
      nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('marque l’entrée courante sur l’écran qu’elle désigne', async () => {
    await rendreLeGabarit('ouverte', COORDONNEES);

    // Le lien n'est pas retiré : le retirer là rendrait la barre différente d'un
    // écran à l'autre — l'écart même que le ticket corrige.
    expect(
      screen.getByRole('link', { name: 'Modifier mes coordonnées' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('ne marque rien sur les écrans qu’elle ne désigne pas', async () => {
    await rendreLeGabarit('ouverte', REPORT);

    expect(
      screen.getByRole('link', { name: 'Modifier mes coordonnées' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('ne se peint pas sur l’écran de connexion, qui partage ce gabarit', async () => {
    await rendreLeGabarit('absente', CONNEXION);

    // « Se déconnecter » y offrirait de fermer une session qui n'est pas
    // ouverte, et « Modifier mes coordonnées » mènerait à un écran qui renvoie
    // aussitôt ici.
    expect(screen.queryByRole('navigation', { name: 'Mon compte' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Se déconnecter' })).toBeNull();
  });

  it('survit à un cookie d’accès expiré que le rafraîchissement va relever', async () => {
    await rendreLeGabarit('a-renouveler', COORDONNEES);

    // Sans cela la barre clignoterait à chaque expiration, juste avant le
    // renouvellement qui la ramène.
    expect(screen.getByRole('navigation', { name: 'Mon compte' })).toBeDefined();
  });

  it('laisse le contenu de l’écran intact', async () => {
    await rendreLeGabarit('ouverte');

    // La barre s'ajoute au gabarit, elle ne se substitue à rien : `children`
    // reste servi, et le titre de l'espace avec lui.
    expect(screen.getByText('contenu de l’écran')).toBeDefined();
    expect(screen.getByRole('heading', { level: 1, name: 'Mon compte' })).toBeDefined();
  });
});
