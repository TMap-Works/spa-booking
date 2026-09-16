// @vitest-environment node
import { NextRequest, type NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as refreshAdmin } from '@/app/(admin)/[tenantSlug]/admin/session/refresh/route';
import { GET as refreshAccount } from '@/app/(account)/[tenantSlug]/compte/session/refresh/route';
import { ApiClientError, type ApiSession } from '@/lib/api-client';

/**
 * Les deux routes de renouvellement, et ce qu'elles font des cookies (#856).
 *
 * Le constat du ticket tient en une ligne : une réponse qui efface les cookies
 * alors que la session est valide déconnecte pour de bon. Ce qui est tenu ici :
 * seul un refus du jeton les efface ; ni le limiteur, ni une panne, ni une
 * coupure, ni la réponse qui a perdu une course contre un autre renouvellement
 * n'y touchent.
 *
 * Environnement Node et non jsdom : la route manipule des `Request` et des
 * `Response` du standard, que jsdom ne fournit pas.
 */

const refreshSession = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, refreshSession: (...args: unknown[]) => refreshSession(...args) };
});

/** Les cookies que le navigateur envoie avec la requête. */
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: vi.fn(),
    }),
}));

const SLUG = 'maison-lotus';

const RENEWED: ApiSession = {
  session: {
    accessToken: 'jeton-d-acces-neuf',
    expiresIn: 900,
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'gerante@example.test',
      role: 'admin',
      firstName: 'Hasina',
      lastName: 'Rakoto',
      phone: null,
    },
  },
  refreshToken: 'jeton-de-rafraichissement-neuf',
  refreshTokenMaxAge: 604_800,
};

/** Ce que la réponse du perdant d'une course porte : un jeton d'accès, rien d'autre. */
const LOST_RACE: ApiSession = { ...RENEWED, refreshToken: null, refreshTokenMaxAge: null };

const REFUSALS: readonly [string, unknown][] = [
  ['le limiteur de débit (429)', new ApiClientError('TOO_MANY_REQUESTS', 'Trop de requêtes.', 429)],
  ['une panne de l’API (500)', new ApiClientError('INTERNAL_ERROR', 'Erreur.', 500)],
  [
    'une coupure réseau',
    new ApiClientError('SERVICE_UNAVAILABLE', 'Injoignable.', 503, { cause: 'ECONNREFUSED' }),
  ],
];

afterEach(() => {
  refreshSession.mockReset();
  jar.clear();
});

/** Les `Set-Cookie` d'une réponse, par nom. */
function setCookies(
  response: NextResponse,
): Map<string, { value: string; maxAge: number | undefined }> {
  return new Map(
    response.cookies
      .getAll()
      .map((cookie) => [cookie.name, { value: cookie.value, maxAge: cookie.maxAge }]),
  );
}

const surfaces = [
  {
    name: 'back-office',
    handler: refreshAdmin,
    access: 'spa_admin_access',
    refresh: 'spa_admin_refresh',
    next: `/${SLUG}/admin/reglages`,
    login: `/${SLUG}/admin/connexion`,
    base: `/${SLUG}/admin/session/refresh`,
  },
  {
    name: 'espace client',
    handler: refreshAccount,
    access: 'spa_account_access',
    refresh: 'spa_account_refresh',
    next: `/${SLUG}/compte/coordonnees`,
    login: `/${SLUG}/compte/connexion`,
    base: `/${SLUG}/compte/session/refresh`,
  },
] as const;

describe.each(surfaces)('la route de renouvellement — $name', (surface) => {
  const call = (): Promise<NextResponse> =>
    surface.handler(
      new NextRequest(
        `http://127.0.0.1:3000${surface.base}?next=${encodeURIComponent(surface.next)}`,
      ),
      { params: Promise.resolve({ tenantSlug: SLUG }) },
    );

  /**
   * La destination, **relative** : Next construit `request.nextUrl` sur l'adresse
   * d'écoute du serveur — `localhost` en développement, `0.0.0.0` dans l'image —,
   * et une redirection absolue emmenait le navigateur sur un autre hôte, sans
   * ses cookies. La requête ci-dessus vise `127.0.0.1` pour cette raison.
   */
  const location = (response: NextResponse): string => {
    const raw = response.headers.get('location') ?? '';
    expect(raw).toMatch(/^\/(?![/\\])/);
    return new URL(raw, 'http://127.0.0.1:3000').pathname;
  };

  it('pose les deux cookies neufs et rend la main sur la page quittée', async () => {
    jar.set(surface.refresh, 'jeton-de-rafraichissement');
    refreshSession.mockResolvedValue(RENEWED);

    const response = await call();
    const cookies = setCookies(response);

    expect(refreshSession).toHaveBeenCalledWith('jeton-de-rafraichissement');
    expect(location(response)).toBe(surface.next);
    expect(cookies.get(surface.access)?.value).toBe('jeton-d-acces-neuf');
    expect(cookies.get(surface.refresh)?.value).toBe('jeton-de-rafraichissement-neuf');
  });

  it('ne touche pas au cookie de rafraîchissement quand la course est perdue', async () => {
    jar.set(surface.refresh, 'jeton-de-rafraichissement');
    refreshSession.mockResolvedValue(LOST_RACE);

    const response = await call();
    const cookies = setCookies(response);

    // La page s'affiche avec un jeton d'accès valide…
    expect(location(response)).toBe(surface.next);
    expect(cookies.get(surface.access)?.value).toBe('jeton-d-acces-neuf');
    // …et le cookie posé par le gagnant n'est ni réécrit, ni effacé.
    expect(cookies.has(surface.refresh)).toBe(false);
  });

  it('efface les deux cookies quand l’API refuse le jeton (401)', async () => {
    jar.set(surface.refresh, 'jeton-de-rafraichissement');
    refreshSession.mockRejectedValue(
      new ApiClientError('INVALID_REFRESH_TOKEN', 'Session invalide ou expirée.', 401),
    );

    const response = await call();
    const cookies = setCookies(response);

    expect(location(response)).toBe(surface.login);
    expect(cookies.get(surface.access)).toMatchObject({ value: '', maxAge: 0 });
    expect(cookies.get(surface.refresh)).toMatchObject({ value: '', maxAge: 0 });
  });

  it.each(REFUSALS)('ne touche à aucun cookie sur %s', async (_label, error) => {
    jar.set(surface.refresh, 'jeton-de-rafraichissement');
    refreshSession.mockRejectedValue(error);

    const response = await call();

    expect(location(response)).toBe(surface.login);
    expect(setCookies(response).size).toBe(0);
  });

  it('ne redirige jamais hors du site, même après résolution des `..`', async () => {
    jar.set(surface.refresh, 'jeton-de-rafraichissement');
    refreshSession.mockResolvedValue(RENEWED);
    const hostile = `${surface.next}/../../..//exemple.test/vol`;

    const response = await surface.handler(
      new NextRequest(`http://127.0.0.1:3000${surface.base}?next=${encodeURIComponent(hostile)}`),
      { params: Promise.resolve({ tenantSlug: SLUG }) },
    );

    // Le renouvellement a lieu, le cookie neuf est posé, et la destination
    // retombe sur l'accueil de la surface au lieu de `//exemple.test`.
    expect(location(response)).not.toContain('exemple.test');
    expect(response.headers.get('location')).not.toContain('exemple.test');
    expect(setCookies(response).get(surface.refresh)?.value).toBe(
      'jeton-de-rafraichissement-neuf',
    );
  });

  it('mène à la connexion sans appeler l’API quand il n’y a rien à renouveler', async () => {
    const response = await call();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(location(response)).toBe(surface.login);
    expect(setCookies(response).size).toBe(0);
  });
});
