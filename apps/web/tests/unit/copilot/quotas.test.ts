// @vitest-environment node

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { FixedReplyAgent } from '@/lib/copilot/claude-agent';
import {
  checkQuotas,
  COPILOT_QUOTAS,
  isAgentRun,
  MemoryCounterStore,
  RedisCounterStore,
} from '@/lib/copilot/quotas';
import { RedisTranscriptStore } from '@/lib/copilot/transcript-store';

/**
 * Quotas, historique sur Redis et réponse fixe (P1-08) : ce qui borne la
 * facture et ce qui permet à deux tâches de servir le même fil.
 */

const request = (ip = '203.0.113.7') =>
  new Request('http://x/salon-lea/copilot/agent/default/run', {
    method: 'POST',
    headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
  });

describe('checkQuotas', () => {
  it('borne une visiteuse par son adresse, sans gêner une autre', async () => {
    const store = new MemoryCounterStore();
    const { limite } = COPILOT_QUOTAS.visiteur;
    for (let i = 0; i < limite; i += 1) {
      expect(await checkQuotas(store, { tenantSlug: 'salon-lea', subject: null, request: request() })).toEqual({
        ok: true,
      });
    }
    expect(await checkQuotas(store, { tenantSlug: 'salon-lea', subject: null, request: request() })).toEqual({
      ok: false,
      portee: 'visiteur',
    });
    expect(
      await checkQuotas(store, { tenantSlug: 'salon-lea', subject: null, request: request('198.51.100.2') }),
    ).toEqual({ ok: true });
  });

  it('borne un compte, et rouvre la fenêtre une fois écoulée', async () => {
    let now = 0;
    const store = new MemoryCounterStore(() => now);
    const quota = { tenantSlug: 'salon-lea', subject: 'abc', request: request() };
    for (let i = 0; i < COPILOT_QUOTAS.compte.limite; i += 1) await checkQuotas(store, quota);
    expect(await checkQuotas(store, quota)).toEqual({ ok: false, portee: 'compte' });

    now = COPILOT_QUOTAS.compte.fenetreSecondes * 1000 + 1;
    expect(await checkQuotas(store, quota)).toEqual({ ok: true });
  });

  it('plafonne le salon quels que soient les comptes', async () => {
    const store = new MemoryCounterStore();
    for (let i = 0; i < COPILOT_QUOTAS.salon.limite; i += 1) {
      await store.increment('salon-lea:salon', COPILOT_QUOTAS.salon.fenetreSecondes);
    }
    expect(await checkQuotas(store, { tenantSlug: 'salon-lea', subject: 'neuf', request: request() })).toEqual({
      ok: false,
      portee: 'salon',
    });
  });

  it('ne compte que les exécutions de l’agent', () => {
    expect(isAgentRun(request(), '/salon-lea/copilot')).toBe(true);
    expect(isAgentRun(new Request('http://x/salon-lea/copilot/info'), '/salon-lea/copilot')).toBe(false);
    expect(isAgentRun(new Request('http://x/salon-lea/copilot/suggestions'), '/salon-lea/copilot')).toBe(false);
  });
});

describe('Redis', () => {
  it('le compteur ouvre sa fenêtre au premier compte seulement', async () => {
    const redis = { incr: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2), expire: vi.fn() };
    const store = new RedisCounterStore(redis);
    await store.increment('k', 600);
    await store.increment('k', 600);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledWith('quota:k', 600);
  });

  it("l'historique est gardé tel quel, trente minutes, et une entrée illisible repart à vide", async () => {
    const data = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => data.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        data.set(key, value);
        return 'OK';
      }),
    };
    const store = new RedisTranscriptStore(redis);
    const transcript = {
      messages: [
        { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: '', signature: 'sig' }] },
      ],
      seen: ['m1'],
    };

    await store.set('copilot:salon-lea:visiteur:fil', transcript);
    expect(redis.set).toHaveBeenCalledWith('transcript:copilot:salon-lea:visiteur:fil', expect.any(String), 'EX', 1800);
    expect(await store.get('copilot:salon-lea:visiteur:fil')).toEqual(transcript);

    data.set('transcript:abîmé', '{');
    expect(await store.get('abîmé')).toBeUndefined();
  });
});

describe('FixedReplyAgent', () => {
  it('répond un texte fixe sans appel au modèle', async () => {
    const input = { threadId: 'f', runId: 'r', state: {}, messages: [], tools: [], context: [], forwardedProps: {} };
    const events: BaseEvent[] = await firstValueFrom(
      new FixedReplyAgent('Réessayez plus tard.').run(input as RunAgentInput).pipe(toArray()),
    );
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });
});
