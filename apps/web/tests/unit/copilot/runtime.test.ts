// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';
import { copilotEnabled } from '@/lib/copilot/config';
import { createOrchestrateur, sessionContext } from '@/lib/copilot/orchestrateur';
import { copilotBasePath, copilotRoute } from '@/lib/copilot/runtime';
import type { ResolvedCopilotSession } from '@/lib/copilot/session';

/**
 * Les routes du copilot par espace (P1-04) : quand elles s'ouvrent, ce qu'elles
 * disent de la session au modèle, et sous quelle clé la conversation est rangée.
 */

const sessionMock = vi.hoisted(() => ({ resolveCopilotSession: vi.fn() }));
vi.mock('@/lib/copilot/session', () => sessionMock);

function resolved(overrides: Partial<ResolvedCopilotSession> = {}): ResolvedCopilotSession {
  return {
    session: {
      surface: 'praticien',
      role: 'staff',
      permissions: ['agenda:read:own'],
      tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
      locale: 'fr',
    },
    accessToken: 'jeton-secret',
    notice: null,
    subject: 'a'.repeat(32),
    tenant: { name: 'Salon Léa', timezone: 'Europe/Paris', defaultCurrency: 'EUR', defaultLocale: 'fr' } as ResolvedCopilotSession['tenant'],
    ...overrides,
  };
}

const context = { params: Promise.resolve({ tenantSlug: 'salon-lea' }) };

afterEach(() => {
  vi.unstubAllEnvs();
  sessionMock.resolveCopilotSession.mockReset();
});

describe('copilotEnabled', () => {
  it('reste fermé sans clé, et en production sans drapeau', () => {
    expect(copilotEnabled({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(false);
    expect(copilotEnabled({ NODE_ENV: 'development', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(true);
    expect(copilotEnabled({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(false);
    // Déployé : le drapeau **et** Redis (P1-08), sans quoi les quotas ne bornent rien.
    expect(
      copilotEnabled({ NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k', COPILOT_ENABLED: 'true' } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      copilotEnabled({
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'k',
        COPILOT_ENABLED: 'true',
        REDIS_URL: 'rediss://cache:6379',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(copilotEnabled({ NODE_ENV: 'production', COPILOT_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('copilotRoute', () => {
  it('répond 404 quand le copilot est fermé, sans lire la session', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const response = await copilotRoute('admin')(new Request('http://x/salon-lea/admin/copilot/info'), context);
    expect(response.status).toBe(404);
    expect(sessionMock.resolveCopilotSession).not.toHaveBeenCalled();
  });

  it("répond 404 pour un salon inconnu, 503 si l'API ne répond pas", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('NODE_ENV', 'development');

    sessionMock.resolveCopilotSession.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'salon', 404));
    expect((await copilotRoute('public')(new Request('http://x/inconnu/copilot/info'), context)).status).toBe(404);

    sessionMock.resolveCopilotSession.mockRejectedValueOnce(new ApiClientError('INTERNAL_ERROR', 'panne', 500));
    expect((await copilotRoute('public')(new Request('http://x/salon-lea/copilot/info'), context)).status).toBe(503);
  });

  it("transmet à la session la lecture des cookies de l'espace", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('NODE_ENV', 'development');
    sessionMock.resolveCopilotSession.mockRejectedValueOnce(new ApiClientError('NOT_FOUND', 'salon', 404));
    const access = vi.fn();

    await copilotRoute('admin', access)(new Request('http://x/salon-lea/admin/copilot/info'), context);

    const [space, slug, deps] = sessionMock.resolveCopilotSession.mock.calls[0]!;
    expect([space, slug]).toEqual(['admin', 'salon-lea']);
    await deps.access();
    expect(access).toHaveBeenCalledWith('salon-lea');
  });

  it('sert chaque espace sous son propre chemin', () => {
    expect(copilotBasePath('public', 'salon-lea')).toBe('/salon-lea/copilot');
    expect(copilotBasePath('compte', 'salon-lea')).toBe('/salon-lea/compte/copilot');
    expect(copilotBasePath('admin', 'salon-lea')).toBe('/salon-lea/admin/copilot');
  });
});

describe("contexte de session et rangement de la conversation", () => {
  it('décrit la surface et le salon, sans jeton', () => {
    const text = sessionContext(resolved());
    expect(text).toContain('<contexte_session>');
    expect(text).toContain('un praticien du salon');
    expect(text).toContain('Europe/Paris');
    expect(text).not.toContain('jeton-secret');
  });

  it("dit que la session a expiré quand c'est le cas", () => {
    expect(sessionContext(resolved({ notice: 'session-expiree' }))).toContain('se reconnecter');
  });

  it('range la conversation sous le salon et la personne', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    const lea = createOrchestrateur(resolved()).options;
    const autre = createOrchestrateur(resolved({ subject: 'b'.repeat(32) })).options;
    const visiteuse = createOrchestrateur(resolved({ subject: null })).options;

    expect(lea.transcriptKey('fil')).toBe(`copilot:salon-lea:${'a'.repeat(32)}:fil`);
    expect(autre.transcriptKey('fil')).not.toBe(lea.transcriptKey('fil'));
    expect(visiteuse.transcriptKey('fil')).toBe('copilot:salon-lea:visiteur:fil');
    expect(lea.sessionContext).toContain('<contexte_session>');
  });
});
