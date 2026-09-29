// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_LOCALE_COOKIE,
  ADMIN_WORKSPACE,
  LOCALE_COOKIE,
  TENANT_SLUG_HEADER,
  TENANT_WORKSPACE_HEADER,
} from '@/i18n/cookies';
// Le middleware ne lit ni cookie ni en-tête de `next/headers` : il s'importe donc
// avant la doublure posée plus bas, contrairement à `i18n/server.ts`.
import { middleware } from '@/middleware';

/**
 * Le back-office s'affiche dans la langue de l'établissement — #1326, second
 * critère d'acceptation.
 *
 * ## Ce que cette suite tient
 *
 * Le constat du ticket : une gérante qui choisit « Langue de l'établissement »
 * dans le bloc « Ma langue » de ses réglages voyait le back-office repasser en
 * français — la langue de son navigateur — alors que son salon est déclaré en
 * `en`, à côté d'un texte d'aide qui promet *« sans choix de votre part, c'est la
 * langue de l'établissement qui s'applique »*.
 *
 * « Langue de l'établissement » vaut `users.locale = null` (#844) : la préférence
 * du compte est retirée, ses deux cookies sont effacés, et il ne reste que
 * l'`Accept-Language` et le salon. L'ordre de #845 mettait le premier avant le
 * second **partout** ; il l'y met encore sur les pages du visiteur, et plus sur
 * le back-office (`i18n/resolve.ts`, « Les deux derniers signaux s'échangent sur
 * le back-office »).
 *
 * Trois choses sont donc éprouvées ici, et la première conditionne les deux
 * autres :
 *
 * 1. le **middleware** dit où l'on est, et ne croit pas le client sur parole ;
 * 2. `requestLocale()` échange les deux dernières étapes sur le back-office, et
 *    là seulement ;
 * 3. les deux étapes qui précèdent — le sélecteur, le compte — gagnent toujours,
 *    et sans coûter d'appel réseau.
 *
 * L'ordre des cinq étapes pris isolément, lui, est éprouvé sur les fonctions
 * pures de `i18n/resolve.ts` par `i18n-resolve.test.ts`.
 *
 * Environnement Node et non jsdom : le middleware manipule des `Request` et des
 * `Headers` du standard, que jsdom ne fournit pas.
 */

const SLUG = 'maison-lotus';

/**
 * Le salon visité, tel que `GET /public/{slug}` le rend. Seule sa langue compte
 * ici — et elle est **l'anglais**, quand le navigateur des cas ci-dessous
 * annonce le français : sans cela, la suite ne distinguerait pas les deux
 * signaux.
 */
const SALON = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: SLUG,
  name: 'Maison Lotus',
  timezone: 'America/Toronto',
  defaultCurrency: 'CAD',
  defaultLocale: 'en',
};

/* -------------------------------------------------------------------------- */
/* 1. Le middleware — ce qu'il pose, et ce qu'il refuse de recopier            */
/* -------------------------------------------------------------------------- */

/**
 * Les en-têtes que le middleware a posés **sur la requête**.
 *
 * `NextResponse.next({ request: { headers } })` ne les renvoie pas au
 * navigateur : il les transporte sur la réponse interne, un en-tête
 * `x-middleware-request-<nom>` par valeur, et la liste de leurs noms dans
 * `x-middleware-override-headers`. C'est le seul point d'observation d'un
 * middleware sans monter Next en entier ; le jour où ce transport change, c'est
 * cette fonction qui bouge, et elle seule.
 */
function requestHeaders(pathname: string, incoming: Readonly<Record<string, string>> = {}) {
  const response = middleware(
    new NextRequest(new URL(pathname, 'https://reservations.example'), { headers: incoming }),
  );

  return {
    slug: response.headers.get(`x-middleware-request-${TENANT_SLUG_HEADER}`),
    workspace: response.headers.get(`x-middleware-request-${TENANT_WORKSPACE_HEADER}`),
    overridden: (response.headers.get('x-middleware-override-headers') ?? '').split(','),
  };
}

describe('le middleware dit de quel côté de l’établissement on se trouve', () => {
  it.each([
    ['/maison-lotus/admin', ADMIN_WORKSPACE],
    ['/maison-lotus/admin/reglages', ADMIN_WORKSPACE],
    ['/maison-lotus/admin/connexion', ADMIN_WORKSPACE],
    // Next apparie ses routes sur des segments décodés : cette adresse sert bien
    // le back-office, et l'en-tête doit le dire comme pour la précédente.
    ['/maison-lotus/%61dmin/reglages', ADMIN_WORKSPACE],
  ])('pose l’espace de travail sur %s', (pathname, expected) => {
    const headers = requestHeaders(pathname);

    expect(headers.slug).toBe(SLUG);
    expect(headers.workspace).toBe(expected);
  });

  it.each([
    ['/maison-lotus', 'la vitrine du salon'],
    ['/maison-lotus/reservation', 'le tunnel de réservation'],
    ['/maison-lotus/compte', 'l’espace client'],
    ['/inscription', 'l’inscription d’un salon'],
    ['/plateforme/connexion', 'la connexion à la console'],
    ['/', 'l’accueil de la plateforme'],
  ])('ne le pose pas sur %s — %s', (pathname) => {
    expect(requestHeaders(pathname).workspace).toBeNull();
  });

  it('efface l’espace qu’une requête forgée prétendrait', () => {
    // L'en-tête vient du chemin et de nulle part ailleurs : sans cet
    // effacement, n'importe qui ferait rendre la vitrine d'un salon dans la
    // langue de son back-office en ajoutant un en-tête à la main.
    const headers = requestHeaders('/maison-lotus', {
      [TENANT_WORKSPACE_HEADER]: ADMIN_WORKSPACE,
      [TENANT_SLUG_HEADER]: 'un-autre-salon',
    });

    expect(headers.workspace).toBeNull();
    expect(headers.slug).toBe(SLUG);
  });

  it('efface les deux en-têtes quand le chemin ne désigne aucun salon', () => {
    const headers = requestHeaders('/', {
      [TENANT_WORKSPACE_HEADER]: ADMIN_WORKSPACE,
      [TENANT_SLUG_HEADER]: SLUG,
    });

    expect(headers.slug).toBeNull();
    expect(headers.workspace).toBeNull();
    // Effacés, donc surchargés : la requête servie ne les porte pas, même si
    // celle qui est entrée les portait.
    expect(headers.overridden).not.toContain(TENANT_SLUG_HEADER);
    expect(headers.overridden).not.toContain(TENANT_WORKSPACE_HEADER);
  });

  it('n’attribue pas le back-office d’un salon à un slug qui n’en a pas la forme', () => {
    // `Headers.set` lève sur une valeur hors de l'octet, et un segment qui n'a
    // pas la forme d'un label DNS ne désigne de toute façon aucun salon.
    const headers = requestHeaders('/%E6%97%A5%E6%9C%AC/admin');

    expect(headers.slug).toBeNull();
    expect(headers.workspace).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* 2. La résolution de la langue sur la requête en cours                      */
/* -------------------------------------------------------------------------- */

/** La requête que la résolution voit — reposée avant chaque cas. */
const requete: { cookies: Record<string, string>; headers: Record<string, string> } = {
  cookies: {},
  headers: {},
};

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = requete.cookies[name];

        return value === undefined ? undefined : { value };
      },
    }),
  headers: () => Promise.resolve(new Headers(requete.headers)),
}));

// Après la doublure, comme le fait `i18n-signaux-partages.test.ts` : ce module
// lit `next/headers` dès son chargement.
import { requestLocale } from '@/i18n/server';

/** `GET /public/{slug}` rend le salon ci-dessus, et compte ses appels. */
function apiDebout() {
  const appel = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SALON) }),
  );
  vi.stubGlobal('fetch', appel);

  return appel;
}

/** `GET /public/{slug}` ne répond pas — API éteinte, slug inconnu, peu importe. */
function apiEteinte() {
  const appel = vi.fn(() => Promise.reject(new Error('API éteinte')));
  vi.stubGlobal('fetch', appel);

  return appel;
}

/** Pose les signaux de la requête en cours. */
function poser(signaux: {
  readonly cookies?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
}): void {
  requete.cookies = { ...signaux.cookies };
  requete.headers = { ...signaux.headers };
}

/** Les en-têtes d'une page du back-office de ce salon. */
const BACK_OFFICE = {
  [TENANT_SLUG_HEADER]: SLUG,
  [TENANT_WORKSPACE_HEADER]: ADMIN_WORKSPACE,
} as const;

/** Les en-têtes d'une page publique de ce même salon. */
const VITRINE = { [TENANT_SLUG_HEADER]: SLUG } as const;

/** Un navigateur réglé en français, comme celui de la gérante du constat. */
const NAVIGATEUR_FR = { 'accept-language': 'fr-CA,fr;q=0.9,en-US;q=0.8' } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  poser({});
});

describe('« Langue de l’établissement », le cas du constat', () => {
  it('sert la langue du salon sur son back-office, contre l’avis du navigateur', async () => {
    poser({ headers: { ...BACK_OFFICE, ...NAVIGATEUR_FR } });
    const appel = apiDebout();

    // Le compte n'a aucune préférence : c'est exactement ce que « Langue de
    // l'établissement » enregistre, et les deux cookies de langue sont absents.
    await expect(requestLocale()).resolves.toBe('en');
    expect(appel).toHaveBeenCalledTimes(1);
  });

  it('sert la langue du navigateur sur la vitrine du même salon', async () => {
    poser({ headers: { ...VITRINE, ...NAVIGATEUR_FR } });
    const appel = apiDebout();

    // La page appartient au visiteur : l'ordre d'ADR 0017 y tient, et l'appel
    // réseau n'a même pas lieu.
    await expect(requestLocale()).resolves.toBe('fr');
    expect(appel).not.toHaveBeenCalled();
  });

  it('sert la langue du salon sur son back-office quand le navigateur se tait', async () => {
    poser({ headers: BACK_OFFICE });
    apiDebout();

    await expect(requestLocale()).resolves.toBe('en');
  });
});

describe('les étapes qui précèdent l’établissement gagnent toujours', () => {
  it('le choix du sélecteur l’emporte sur le back-office, sans appel réseau', async () => {
    poser({ cookies: { [LOCALE_COOKIE]: 'fr' }, headers: BACK_OFFICE });
    const appel = apiDebout();

    // C'est ce qui empêche la règle d'enfermer qui que ce soit : le sélecteur est
    // désormais présent sur tous les écrans, et son cookie reste la première
    // étape de l'ordre.
    await expect(requestLocale()).resolves.toBe('fr');
    expect(appel).not.toHaveBeenCalled();
  });

  it('la préférence du compte l’emporte sur le back-office, sans appel réseau', async () => {
    poser({ cookies: { [ACCOUNT_LOCALE_COOKIE]: 'fr' }, headers: BACK_OFFICE });
    const appel = apiDebout();

    await expect(requestLocale()).resolves.toBe('fr');
    expect(appel).not.toHaveBeenCalled();
  });

  it('un cookie trafiqué ne gèle pas la résolution sur une langue qui n’existe pas', async () => {
    poser({ cookies: { [LOCALE_COOKIE]: 'klingon' }, headers: BACK_OFFICE });
    apiDebout();

    await expect(requestLocale()).resolves.toBe('en');
  });
});

describe('aucune panne de l’établissement n’empêche la page de s’afficher', () => {
  it('retombe sur le navigateur quand l’API ne répond pas', async () => {
    poser({ headers: { ...BACK_OFFICE, ...NAVIGATEUR_FR } });
    apiEteinte();

    // L'ordre échangé ne veut pas dire « l'établissement ou rien » : un salon qui
    // n'a rien dit laisse la main au signal suivant, comme à toutes les étapes.
    await expect(requestLocale()).resolves.toBe('fr');
  });

  it('retombe sur l’anglais quand ni le salon ni le navigateur ne disent rien', async () => {
    poser({ headers: { ...BACK_OFFICE, 'accept-language': '*;q=0.5' } });
    apiEteinte();

    await expect(requestLocale()).resolves.toBe('en');
  });
});
