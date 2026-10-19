// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopilotMount } from '@/components/copilot/copilot-mount';
import { copilotBasePath, isSalonPath } from '@/lib/copilot/paths';
import { copilotRoute } from '@/lib/copilot/runtime';
import type { ResolvedCopilotSession } from '@/lib/copilot/session';

/**
 * L'interface du chat (P1-06) côté serveur et en logique pure : où il se monte,
 * ce que l'exécutant `naviguer` accepte de suivre, et les suggestions servies
 * sans modèle.
 */

const sessionMock = vi.hoisted(() => ({ resolveCopilotSession: vi.fn() }));
vi.mock('@/lib/copilot/session', () => sessionMock);

afterEach(() => {
  vi.unstubAllEnvs();
  sessionMock.resolveCopilotSession.mockReset();
});

describe('isSalonPath — la garde de naviguer', () => {
  it('suit une adresse du salon courant', () => {
    expect(isSalonPath('/salon-lea/reservation?etape=creneau&plage=soir', 'salon-lea')).toBe(true);
    expect(isSalonPath('/salon-lea', 'salon-lea')).toBe(true);
  });

  it("refuse tout ce qui sortirait du salon ou du site", () => {
    for (const chemin of [
      'https://ailleurs.example/salon-lea',
      '//ailleurs.example/salon-lea',
      '/\\ailleurs.example',
      '/autre-salon/reservation',
      '/salon-leaxyz/reservation',
      'javascript:alert(1)',
      'salon-lea/reservation',
      '/salon-lea/../autre-salon',
    ]) {
      expect(isSalonPath(chemin, 'salon-lea'), chemin).toBe(false);
    }
  });
});

describe('CopilotMount', () => {
  it('ne laisse aucune trace quand le copilot est fermé', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(CopilotMount({ space: 'public', tenantSlug: 'salon-lea' })).toBeNull();
  });

  it('monte le panneau au back-office et la bulle ailleurs, sur la route de l’espace', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('NODE_ENV', 'development');
    const admin = CopilotMount({ space: 'admin', tenantSlug: 'salon-lea' });
    const compte = CopilotMount({ space: 'compte', tenantSlug: 'salon-lea' });
    expect(admin?.props).toMatchObject({ runtimeUrl: '/salon-lea/admin/copilot', variant: 'panneau' });
    expect(compte?.props).toMatchObject({ runtimeUrl: '/salon-lea/compte/copilot', variant: 'bulle' });
  });
});

describe('suggestions servies par la route', () => {
  it('rend les suggestions de la session et de la page, sans appeler le modèle', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k');
    vi.stubEnv('NODE_ENV', 'development');
    const resolved = {
      session: {
        surface: 'visiteur',
        role: null,
        permissions: [],
        tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
        locale: 'fr',
      },
      accessToken: null,
      notice: null,
      subject: null,
      tenant: {},
    } as unknown as ResolvedCopilotSession;
    sessionMock.resolveCopilotSession.mockResolvedValue(resolved);

    const response = await copilotRoute('public')(
      new Request(`http://x${copilotBasePath('public', 'salon-lea')}/suggestions?page=%2Fsalon-lea`),
      { params: Promise.resolve({ tenantSlug: 'salon-lea' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestions: [
        { cle: 'reserver', type: 'navigation', chemin: '/salon-lea/reservation' },
        { cle: 'creneaux_demain', type: 'message' },
        { cle: 'tarifs', type: 'message' },
      ],
    });
  });
});
