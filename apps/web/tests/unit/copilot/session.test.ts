import type { PublicTenant } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, type OwnProfile } from '@/lib/api-client';
import { ProfileCache, resolveCopilotSession } from '@/lib/copilot/session';
import type { ActionAccess } from '@/lib/session-refresh';

/**
 * Détection de la session du copilot (spécification §5, P1-05) : ce que la
 * route décrit au modèle selon qui parle, et ce qu'elle garde pour elle.
 * Aucune requête : l'API et les cookies sont simulés.
 */

const tenant = {
  timezone: 'Europe/Paris',
  defaultCurrency: 'EUR',
  defaultLocale: 'fr',
} as PublicTenant;

function profile(role: OwnProfile['role'], permissions?: OwnProfile['permissions']): OwnProfile {
  return {
    id: '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69',
    email: 'lea@example.test',
    role,
    firstName: 'Léa',
    lastName: 'Martin',
    phone: null,
    locale: null,
    ...(permissions === undefined ? {} : { permissions }),
  } as OwnProfile;
}

function deps(access: ActionAccess, me: () => Promise<OwnProfile>) {
  return {
    access: vi.fn(async () => access),
    fetchProfile: vi.fn(me),
    fetchTenant: vi.fn(async () => tenant),
    profileCache: new ProfileCache(),
  };
}

const ready: ActionAccess = { kind: 'ready', accessToken: 'jeton-secret' };

describe('resolveCopilotSession', () => {
  it("l'espace public est toujours visiteur, sans lire aucun cookie", async () => {
    const d = deps(ready, async () => profile('admin'));
    const resolved = await resolveCopilotSession('public', 'salon-lea', d);

    expect(resolved.session).toMatchObject({ surface: 'visiteur', role: null, permissions: [] });
    expect(resolved.accessToken).toBeNull();
    expect(d.access).not.toHaveBeenCalled();
    expect(d.fetchProfile).not.toHaveBeenCalled();
  });

  it('un praticien connecté reçoit sa surface et ses permissions, et le jeton reste hors de la session', async () => {
    const d = deps(ready, async () => profile('staff', ['agenda:read:own', 'appointment:write:own']));
    const resolved = await resolveCopilotSession('admin', 'salon-lea', d);

    expect(resolved.session).toEqual({
      surface: 'praticien',
      role: 'staff',
      permissions: ['agenda:read:own', 'appointment:write:own'],
      tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
      locale: 'fr',
    });
    expect(resolved.accessToken).toBe('jeton-secret');
    expect(JSON.stringify(resolved.session)).not.toContain('jeton-secret');
    expect(JSON.stringify(resolved.session)).not.toContain('lea@example.test');
  });

  it('une session expirée est traitée en visiteuse, avec le motif à dire', async () => {
    const d = deps({ kind: 'expired' }, async () => profile('client'));
    const resolved = await resolveCopilotSession('compte', 'salon-lea', d);

    expect(resolved.session.surface).toBe('visiteur');
    expect(resolved.notice).toBe('session-expiree');
    expect(d.fetchProfile).not.toHaveBeenCalled();
  });

  it('un renouvellement impossible ne donne aucun droit', async () => {
    const d = deps({ kind: 'failed', error: new Error('panne') }, async () => profile('admin'));
    const resolved = await resolveCopilotSession('admin', 'salon-lea', d);

    expect(resolved.session.surface).toBe('visiteur');
    expect(resolved.notice).toBe('renouvellement-indisponible');
  });

  it("un jeton d'un autre salon (401 de l'API) vaut visiteuse de celui-ci", async () => {
    const d = deps(ready, async () => {
      throw new ApiClientError('UNAUTHORIZED', 'tenant du jeton ≠ slug', 401);
    });
    const resolved = await resolveCopilotSession('admin', 'autre-salon', d);

    expect(resolved).toMatchObject({ accessToken: null, notice: 'session-expiree' });
    expect(resolved.session.permissions).toEqual([]);
  });

  it("une panne de l'API n'est pas maquillée en visiteuse", async () => {
    const d = deps(ready, async () => {
      throw new ApiClientError('INTERNAL_ERROR', 'panne', 500);
    });
    await expect(resolveCopilotSession('admin', 'salon-lea', d)).rejects.toThrow('panne');
  });

  it("une API qui n'émet pas les permissions laisse une session sans permission", async () => {
    const d = deps(ready, async () => profile('manager'));
    const resolved = await resolveCopilotSession('admin', 'salon-lea', d);

    expect(resolved.session).toMatchObject({ surface: 'gerance', permissions: [] });
  });

  it('la langue du compte passe avant celle du salon', async () => {
    const d = deps(ready, async () => ({ ...profile('client'), locale: 'en' }) as OwnProfile);
    expect((await resolveCopilotSession('compte', 'salon-lea', d)).session.locale).toBe('en');
  });
});

describe('ProfileCache', () => {
  it('garde le profil trente secondes, sous une empreinte du jeton', async () => {
    let now = 0;
    const cache = new ProfileCache(30_000, 10, () => now);
    const load = vi.fn(async () => profile('staff'));

    await cache.get('jeton', load);
    await cache.get('jeton', load);
    expect(load).toHaveBeenCalledTimes(1);

    now = 30_001;
    await cache.get('jeton', load);
    expect(load).toHaveBeenCalledTimes(2);

    const keys = [...(cache as unknown as { entries: Map<string, unknown> }).entries.keys()];
    expect(keys).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it('borne le nombre de profils gardés', async () => {
    const cache = new ProfileCache(30_000, 2);
    const load = vi.fn(async () => profile('client'));

    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('c', load);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
