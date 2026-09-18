import { describe, expect, it, vi } from 'vitest';

import {
  attachSessionCookies,
  clearSessionCookies,
} from '@/app/(account)/[tenantSlug]/compte/session';
import { PRESENCE_COOKIE, parsePresence, presenceCookieValue } from '@/lib/account-presence';
import type { ApiSession } from '@/lib/api-client';

/*
 * Le cookie de présence (#1045) — le prénom que l'en-tête du salon salue hors
 * de l'espace client, où les jetons ne voyagent pas.
 *
 * Ce que la suite protège :
 * - il ne porte **que** le prénom et le nom, jamais un jeton ;
 * - il vit sur tout le salon (`/{slug}`), là où les jetons restent bornés à
 *   `/{slug}/compte` ;
 * - il part avec la session ;
 * - relu du navigateur, il est validé : une valeur trafiquée ne s'affiche pas.
 */

vi.mock('next/headers', () => ({ cookies: vi.fn() }));

const opened: ApiSession = {
  session: {
    accessToken: 'jeton-d-acces-de-test',
    expiresIn: 900,
    user: {
      id: '3f7c1f4e-2a9d-4c53-8f0e-1b2c3d4e5f60',
      email: 'alice@maison-lotus.test',
      role: 'client',
      firstName: 'Alice',
      lastName: 'Marchand',
      phone: null,
    },
  },
  refreshToken: 'jeton-de-rafraichissement-de-test',
  refreshTokenMaxAge: 604800,
};

function magasin() {
  const set = vi.fn();
  return { set, cookies: { set } };
}

describe('cookie de présence', () => {
  it('se pose avec la session, sur tout le salon, sans jeton', () => {
    const { set, cookies } = magasin();

    attachSessionCookies(cookies, 'maison-lotus', opened);

    const presence = set.mock.calls.find(([name]) => name === PRESENCE_COOKIE);
    expect(presence).toBeDefined();
    const [, value, options] = presence as [string, string, { path: string; httpOnly: boolean; maxAge: number }];
    expect(JSON.parse(value)).toEqual({ firstName: 'Alice', lastName: 'Marchand' });
    expect(value).not.toContain('jeton');
    expect(options).toMatchObject({ path: '/maison-lotus', httpOnly: true, maxAge: 604800 });

    // Les jetons, eux, restent bornés à l'espace client.
    for (const [name, , tokenOptions] of set.mock.calls) {
      if (name !== PRESENCE_COOKIE) {
        expect(tokenOptions.path).toBe('/maison-lotus/compte');
      }
    }
  });

  it('part avec la session', () => {
    const { set, cookies } = magasin();

    clearSessionCookies(cookies, 'maison-lotus');

    expect(set).toHaveBeenCalledWith(
      PRESENCE_COOKIE,
      '',
      expect.objectContaining({ path: '/maison-lotus', maxAge: 0 }),
    );
  });

  it('se relit, et refuse ce qui n’en a pas la forme', () => {
    expect(parsePresence(presenceCookieValue({ firstName: 'Alice', lastName: 'Marchand' }))).toEqual({
      firstName: 'Alice',
      lastName: 'Marchand',
    });
    expect(parsePresence(undefined)).toBeNull();
    expect(parsePresence('')).toBeNull();
    expect(parsePresence('pas du json')).toBeNull();
    expect(parsePresence(JSON.stringify({ firstName: '', lastName: 'X' }))).toBeNull();
    expect(parsePresence(JSON.stringify({ firstName: 'A'.repeat(500), lastName: '' }))).toBeNull();
  });
});
