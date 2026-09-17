import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AccountLayout from '@/app/(account)/[tenantSlug]/compte/layout';
import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';

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
 *
 * ## Le pied de page du même gabarit — #749
 *
 * Il ne range pas ce qui se fait dans l'espace, il en **sort** : deux liens, le
 * tunnel et le compte. L'audit `d20260916-1` y relève deux écarts `ds:libelles`,
 * et la seconde moitié de ce fichier les tient :
 *
 * - **le libellé est celui de la destination** : le pied réécrivait « Mes
 *   rendez-vous » pour une page titrée « Mon compte ». Il lit maintenant le
 *   registre des sorties du parcours public, et l'assertion porte sur
 *   l'**identité** entre ce registre et le `<h1>` du gabarit — la seule forme
 *   qu'une réécriture d'un seul des deux côtés ne peut pas satisfaire ;
 * - **une sortie qui ramène à l'écran courant n'est pas une sortie** : sur la
 *   connexion, le lien menait à `/{slug}/compte`, qui redirige aussitôt vers la
 *   connexion (`session.ts`, cas 3). Il s'efface donc là, comme sur la liste
 *   elle-même — et reste partout où il mène réellement ailleurs, l'inscription
 *   comprise.
 *
 * Contrairement à la barre, ce n'est pas la session qui décide mais la
 * **destination effective** : c'est ce qui distingue la connexion, où le lien
 * boucle, de l'inscription, où il n'y boucle pas. Et la destination se lit sur
 * le **cookie d'accès** seul — une session renouvelable déposée sur la connexion
 * par un renouvellement refusé sans révocation y bouclerait tout autant.
 *
 * ## Là où #927 a déplacé la frontière
 *
 * Le cadre d'accueil des écrans d'identification remplace désormais ce pied
 * quand **aucun** cookie n'est là : ses sorties nomment le tunnel, la vitrine et
 * l'accueil de la plateforme, jamais l'espace qu'on est en train d'ouvrir. La
 * boucle est donc fermée deux fois, et cette suite le dit des deux côtés : par
 * l'absence de sortie « compte » dans le cadre, et par son effacement dans le
 * pied — qui reste le seul rendu sur la connexion tant qu'une session est
 * renouvelable.
 */

const readAccessToken = vi.fn();
const readRefreshToken = vi.fn();
const accountTenant = vi.fn();

const COMPTE = `/${tenant.slug}/compte`;
const COORDONNEES = `${COMPTE}/coordonnees`;
const REPORT = `${COMPTE}/rendez-vous/3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60/report`;
const CONNEXION = `${COMPTE}/connexion`;
const INSCRIPTION = `${COMPTE}/inscription`;

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

describe('les sorties du pied de page', () => {
  /** Le pied de page du gabarit, où qu'il soit dans l'arbre. */
  function pied(container: HTMLElement): HTMLElement {
    const footer = container.querySelector<HTMLElement>('footer.spa-account__footer');

    if (footer === null) {
      throw new Error('le gabarit doit rendre le pied de page de l’espace client');
    }

    return footer;
  }

  it('nomme la sortie du compte comme la destination se titre elle-même', async () => {
    const container = await rendreLeGabarit('ouverte', COORDONNEES);

    const titre = screen.getByRole('heading', { level: 1 }).textContent;

    // Un `toBe` d'identité entre le registre et le titre, et non deux littéraux
    // écrits côte à côte : c'est la seule forme qu'une réécriture d'un seul des
    // deux côtés ne peut pas satisfaire (#749).
    expect(PUBLIC_EXIT_LABELS.compte).toBe(titre);
    expect(
      within(pied(container))
        .getByRole('link', { name: PUBLIC_EXIT_LABELS.compte })
        .getAttribute('href'),
    ).toBe(COMPTE);
  });

  it.each([
    ['les coordonnées', COORDONNEES],
    ['le report d’un rendez-vous', REPORT],
  ])('garde la sortie du compte sur %s, d’où elle mène ailleurs', async (_ecran, chemin) => {
    const container = await rendreLeGabarit('ouverte', chemin);

    expect(
      within(pied(container)).getByRole('link', { name: PUBLIC_EXIT_LABELS.compte }),
    ).toBeDefined();
  });

  it('efface la sortie du compte sur la liste, qui est déjà cet écran', async () => {
    const container = await rendreLeGabarit('ouverte', COMPTE);

    expect(
      within(pied(container)).queryByRole('link', { name: PUBLIC_EXIT_LABELS.compte }),
    ).toBeNull();
  });

  it('n’offre nulle part la sortie du compte sur la connexion, où elle boucle', async () => {
    const container = await rendreLeGabarit('absente', CONNEXION);

    // Sans session, `/{slug}/compte` redirige vers la connexion : le lien
    // ramenait la visiteuse à l'écran qu'elle lisait déjà (#749). Depuis #927,
    // cet état ne rend plus le pied du tout — c'est le cadre d'accueil qui porte
    // les sorties —, et l'assertion vaut donc pour l'écran entier : aucune des
    // deux barres ne propose l'espace qu'on essaie précisément d'ouvrir.
    expect(container.querySelector('footer.spa-account__footer')).toBeNull();
    expect(screen.queryByRole('link', { name: PUBLIC_EXIT_LABELS.compte })).toBeNull();
  });

  it('efface la sortie du compte sur la connexion même quand la session est renouvelable', async () => {
    const container = await rendreLeGabarit('a-renouveler', CONNEXION);

    // C'est l'état où un renouvellement **refusé sans révocation** — limiteur,
    // API injoignable — dépose la visiteuse ici, ses deux cookies intacts
    // (`session/refresh/route.ts`). Compter cette session comme « mène à la
    // liste » y rouvrirait la boucle : `/compte` repartirait au renouvellement,
    // qui échouerait de nouveau et ramènerait à cet écran.
    expect(
      within(pied(container)).queryByRole('link', { name: PUBLIC_EXIT_LABELS.compte }),
    ).toBeNull();
    // La barre, elle, reste peinte : elle ne tranche pas la même question, et la
    // retirer la ferait clignoter à chaque expiration (#747).
    expect(screen.getByRole('navigation', { name: 'Mon compte' })).toBeDefined();
  });

  it('la garde sur l’inscription, d’où elle mène bien à la connexion', async () => {
    const container = await rendreLeGabarit('a-renouveler', INSCRIPTION);

    // C'est la destination effective qui décide, pas la session : d'ici, le lien
    // mène ailleurs, et un seul libellé sert la cliente inscrite et l'autre.
    // La session est dite renouvelable parce que c'est le seul état où
    // l'inscription porte encore ce pied depuis #927 — sans aucun cookie, c'est
    // le cadre d'accueil qui rend les sorties. La règle testée, elle, ne change
    // pas : le cookie d'accès manque des deux côtés.
    expect(
      within(pied(container)).getByRole('link', { name: PUBLIC_EXIT_LABELS.compte }),
    ).toBeDefined();
  });

  it('garde en toutes circonstances la sortie vers le tunnel', async () => {
    const container = await rendreLeGabarit('a-renouveler', CONNEXION);

    // Le tunnel n'appartient pas à cet espace : aucun de ses écrans ne peut être
    // celui qu'on lit, et la sortie ne boucle donc jamais — pas même sur l'écran
    // où l'autre sortie, elle, vient de s'effacer.
    expect(
      within(pied(container))
        .getByRole('link', { name: 'Prendre un nouveau rendez-vous' })
        .getAttribute('href'),
    ).toBe(`/${tenant.slug}/reservation`);
  });
});
