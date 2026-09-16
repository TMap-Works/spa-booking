import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError, type ApiSession } from '@/lib/api-client';
import {
  accessTokenForAction,
  isRefreshRefused,
  type ActionSessionStore,
} from '@/lib/session-refresh';

/**
 * Le renouvellement d'une session depuis une action serveur, et la règle qui
 * décide qu'un renouvellement raté ferme la session (#856).
 *
 * Ce qui est tenu ici est ce qui coûtait la saisie : une action appelée après
 * l'expiration du cookie d'accès renouvelle elle-même la session au lieu de
 * rendre `UNAUTHORIZED`, et seule une réponse qui dit que le jeton est mauvais
 * — 401 ou 403 — met fin à la session.
 */

const refreshSession = vi.fn();

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, refreshSession: (...args: unknown[]) => refreshSession(...args) };
});

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

function store(access: string | null, refresh: string | null): ActionSessionStore & {
  readonly write: ReturnType<typeof vi.fn>;
} {
  return {
    readAccessToken: () => Promise.resolve(access),
    readRefreshToken: () => Promise.resolve(refresh),
    write: vi.fn(() => Promise.resolve()),
  };
}

afterEach(() => {
  refreshSession.mockReset();
});

describe('accessTokenForAction', () => {
  it('rend le cookie d’accès tel quel, sans appeler l’API', async () => {
    const session = store('jeton-courant', 'rafraichissement');

    await expect(accessTokenForAction(session)).resolves.toEqual({
      kind: 'ready',
      accessToken: 'jeton-courant',
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(session.write).not.toHaveBeenCalled();
  });

  it('renouvelle sur place un cookie d’accès expiré, et pose la session neuve', async () => {
    refreshSession.mockResolvedValue(RENEWED);
    const session = store(null, 'rafraichissement');

    await expect(accessTokenForAction(session)).resolves.toEqual({
      kind: 'ready',
      accessToken: 'jeton-d-acces-neuf',
    });
    expect(refreshSession).toHaveBeenCalledWith('rafraichissement');
    expect(session.write).toHaveBeenCalledWith(RENEWED);
  });

  it('renouvelle aussi quand l’API a perdu une course et ne rend qu’un jeton d’accès', async () => {
    refreshSession.mockResolvedValue({ ...RENEWED, refreshToken: null, refreshTokenMaxAge: null });
    const session = store(null, 'rafraichissement');

    await expect(accessTokenForAction(session)).resolves.toEqual({
      kind: 'ready',
      accessToken: 'jeton-d-acces-neuf',
    });
    // La surface pose ce qu'elle reçoit : sans jeton de rafraîchissement, seul
    // le cookie d'accès est écrit (voir `adminSessionCookies`).
    expect(session.write).toHaveBeenCalledTimes(1);
  });

  it('n’a rien à renouveler sans cookie de rafraîchissement', async () => {
    const session = store(null, null);

    await expect(accessTokenForAction(session)).resolves.toEqual({ kind: 'expired' });
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it.each([401, 403])('rend « expirée » quand l’API refuse le jeton (%i)', async (status) => {
    refreshSession.mockRejectedValue(
      new ApiClientError('INVALID_REFRESH_TOKEN', 'Session invalide ou expirée.', status),
    );
    const session = store(null, 'rafraichissement');

    await expect(accessTokenForAction(session)).resolves.toEqual({ kind: 'expired' });
    expect(session.write).not.toHaveBeenCalled();
  });

  it.each([
    ['le limiteur de débit', new ApiClientError('TOO_MANY_REQUESTS', 'Trop de requêtes.', 429)],
    ['une panne de l’API', new ApiClientError('INTERNAL_ERROR', 'Erreur.', 500)],
    [
      'une coupure réseau',
      new ApiClientError('SERVICE_UNAVAILABLE', 'Injoignable.', 503, { cause: 'ECONNREFUSED' }),
    ],
    ['une réponse illisible', new Error('schéma inattendu')],
  ])('rend l’échec sans conclure sur la session — %s', async (_label, error) => {
    refreshSession.mockRejectedValue(error);
    const session = store(null, 'rafraichissement');

    await expect(accessTokenForAction(session)).resolves.toEqual({ kind: 'failed', error });
    expect(session.write).not.toHaveBeenCalled();
  });
});

describe('isRefreshRefused', () => {
  it('ne ferme la session que sur un refus du jeton', () => {
    expect(isRefreshRefused(new ApiClientError('INVALID_REFRESH_TOKEN', 'x', 401))).toBe(true);
    expect(isRefreshRefused(new ApiClientError('FORBIDDEN', 'x', 403))).toBe(true);
    expect(isRefreshRefused(new ApiClientError('TOO_MANY_REQUESTS', 'x', 429))).toBe(false);
    expect(isRefreshRefused(new ApiClientError('SERVICE_UNAVAILABLE', 'x', 503))).toBe(false);
    expect(isRefreshRefused(new Error('x'))).toBe(false);
  });
});
