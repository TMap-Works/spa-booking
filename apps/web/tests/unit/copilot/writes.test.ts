// @vitest-environment node

import type { CopilotSession } from '@spa/shared';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';
import { specialistTools, type Specialist } from '@/lib/copilot/specialists';
import {
  decideWrite,
  isSameOrigin,
  MemoryPendingWriteStore,
  RedisPendingWriteStore,
  type PendingWrite,
} from '@/lib/copilot/writes';

/**
 * Les écritures confirmées (P3-01) : gardées côté serveur, exécutées une
 * seule fois par la personne qui les a vues, et refusées en clair.
 */

const write: PendingWrite = {
  action: 'rendez_vous.annuler',
  parametres: { rendezVous: '0b6f8b8e-3f4a-4c2e-9a8e-2f1d3c4b5a69' },
  recapitulatif: { titre: 'Annuler le massage de jeudi', lignes: ['Jeudi 22 octobre, 14 h 00', 'Avec Léa'] },
};
const scope = { tenantSlug: 'salon-lea', subject: 'a'.repeat(32) };

describe('magasin des écritures en attente', () => {
  it("rend l'écriture une seule fois, et à la même personne seulement", async () => {
    const store = new MemoryPendingWriteStore();
    const id = await store.put(scope, write);

    expect(await store.take({ ...scope, subject: 'b'.repeat(32) }, id)).toBeUndefined();
    const other = await store.put(scope, write);
    expect(await store.take(scope, other)).toEqual(write);
    expect(await store.take(scope, other)).toBeUndefined();
  });

  it('expire au bout de cinq minutes', async () => {
    let now = 0;
    const store = new MemoryPendingWriteStore(() => now);
    const id = await store.put(scope, write);
    now = 5 * 60 * 1000 + 1;
    expect(await store.take(scope, id)).toBeUndefined();
  });

  it('lit et efface d’un seul geste sur Redis', async () => {
    const data = new Map<string, string>();
    const redis = {
      get: vi.fn(),
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
      getdel: vi.fn(async (key: string) => {
        const value = data.get(key) ?? null;
        data.delete(key);
        return value;
      }),
    };
    const store = new RedisPendingWriteStore(redis);
    const id = await store.put(scope, write);

    expect(redis.set).toHaveBeenCalledWith(`ecriture:salon-lea:${scope.subject}:${id}`, expect.any(String), 'EX', 300);
    expect(await store.take(scope, id)).toEqual(write);
    expect(await store.take(scope, id)).toBeUndefined();
  });
});

describe('decideWrite', () => {
  async function decide(overrides: Partial<Parameters<typeof decideWrite>[0]> = {}) {
    const store = new MemoryPendingWriteStore();
    const id = await store.put(scope, write);
    const execute = vi.fn(async () => 'Votre rendez-vous de jeudi est annulé.');
    const outcome = await decideWrite({
      store,
      executors: { 'rendez_vous.annuler': execute },
      scope,
      accessToken: 'jeton',
      id,
      decision: 'valider',
      locale: 'fr',
      ...overrides,
    });
    return { outcome, execute };
  }

  it('exécute avec le jeton de la session courante', async () => {
    const { outcome, execute } = await decide();
    expect(outcome).toEqual({ statut: 'faite', message: 'Votre rendez-vous de jeudi est annulé.' });
    expect(execute).toHaveBeenCalledWith(write.parametres, { accessToken: 'jeton', tenantSlug: 'salon-lea' });
  });

  it("un refus n'exécute rien", async () => {
    const { outcome, execute } = await decide({ decision: 'refuser' });
    expect(outcome.statut).toBe('refusee');
    expect(execute).not.toHaveBeenCalled();
  });

  it('sans session, rien ne part', async () => {
    const { outcome, execute } = await decide({ accessToken: null });
    expect(outcome).toMatchObject({ statut: 'echec' });
    expect(outcome.message).toContain('reconnectez-vous');
    expect(execute).not.toHaveBeenCalled();
  });

  it("dit en clair le refus de l'API — un créneau pris, un droit manquant", async () => {
    for (const [error, expected] of [
      [new ApiClientError('SLOT_NO_LONGER_AVAILABLE', 'pris', 409), "vient d'être pris"],
      [new ApiClientError('FORBIDDEN', 'non', 403), "pas le droit"],
      [new ApiClientError('NOT_FOUND', 'absent', 404), 'ne retrouve plus'],
    ] as const) {
      const store = new MemoryPendingWriteStore();
      const id = await store.put(scope, write);
      const outcome = await decideWrite({
        store,
        executors: { 'rendez_vous.annuler': async () => Promise.reject(error) },
        scope,
        accessToken: 'jeton',
        id,
        decision: 'valider',
        locale: 'fr',
      });
      expect(outcome.statut).toBe('echec');
      expect(outcome.message).toContain(expected);
    }
  });
});

describe('isSameOrigin', () => {
  const req = (headers: Record<string, string>) => new Request('http://salon.test/x', { method: 'POST', headers });
  it("n'accepte que la page du site", () => {
    expect(isSameOrigin(req({ origin: 'https://salon.test', host: 'salon.test' }))).toBe(true);
    expect(isSameOrigin(req({ origin: 'https://evil.test', host: 'salon.test' }))).toBe(false);
    expect(isSameOrigin(req({ host: 'salon.test' }))).toBe(false);
  });
});

describe('un spécialiste propose, il n’écrit pas', () => {
  const session: CopilotSession = {
    surface: 'client',
    role: 'client',
    permissions: [],
    tenant: { slug: 'salon-lea', timezone: 'Europe/Paris', currency: 'EUR' },
    locale: 'fr',
  };
  const specialist: Specialist = {
    domaine: 'rendez_vous',
    description: 'Rendez-vous',
    run: async () => ({ reponse: 'Je vous propose d’annuler.', actionsFront: [], confirmation: write, suggestions: [] }),
  };

  it('la page reçoit une carte avec l’identifiant, jamais les paramètres', async () => {
    const prepare = vi.fn(async () => '11111111-2222-4333-8444-555555555555');
    const [tool] = specialistTools(session, [specialist], prepare);
    const outcome = await tool!.run({ demande: 'Annuler jeudi' }, new AbortController().signal);

    expect(prepare).toHaveBeenCalledWith(write);
    expect(outcome).toMatchObject({
      kind: 'fin',
      navigateur: [
        {
          outil: 'confirmer',
          arguments: { id: '11111111-2222-4333-8444-555555555555', titre: write.recapitulatif.titre, lignes: write.recapitulatif.lignes },
        },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain(write.parametres.rendezVous as string);
  });

  it("sans session qui puisse écrire, l'écriture est abandonnée", async () => {
    const [tool] = specialistTools(session, [specialist], null);
    const outcome = await tool!.run({ demande: 'Annuler jeudi' }, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: 'fin', navigateur: [] });
  });
});
