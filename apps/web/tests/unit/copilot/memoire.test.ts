// @vitest-environment jsdom

import type { Message } from '@ag-ui/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadConversation, MEMORY_TTL_MS, saveConversation } from '@/components/copilot/memoire';

const messages = [
  { id: 'u1', role: 'user', content: 'Un massage demain' },
  { id: 'a1', role: 'assistant', content: 'Je vous ouvre la réservation.' },
] as Message[];

beforeEach(() => window.sessionStorage.clear());

describe('mémoire de la conversation', () => {
  it('rend le même fil et les mêmes messages après un rechargement', () => {
    const first = loadConversation('salon', 'bulle', 'visiteur');
    saveConversation('salon', 'bulle', 'visiteur', { threadId: first.threadId, messages });

    const again = loadConversation('salon', 'bulle', 'visiteur');
    expect(again.threadId).toBe(first.threadId);
    expect(again.messages).toEqual(messages);
  });

  it('ne rend rien à une autre personne sur le même onglet, et efface', () => {
    saveConversation('salon', 'bulle', 'alice', { threadId: 'fil-alice', messages });

    const other = loadConversation('salon', 'bulle', 'visiteur');
    expect(other.threadId).not.toBe('fil-alice');
    expect(other.messages).toEqual([]);
    expect(window.sessionStorage.getItem('spa-copilot:salon:bulle')).toBeNull();
  });

  it('repart de zéro après 30 minutes sans message', () => {
    const now = Date.now();
    saveConversation('salon', 'bulle', 'alice', { threadId: 'fil', messages }, now);

    expect(loadConversation('salon', 'bulle', 'alice', now + MEMORY_TTL_MS - 1).threadId).toBe('fil');
    expect(loadConversation('salon', 'bulle', 'alice', now + MEMORY_TTL_MS + 1).threadId).not.toBe('fil');
  });

  it('sépare les salons et les espaces', () => {
    saveConversation('salon', 'bulle', 'alice', { threadId: 'fil', messages });
    expect(loadConversation('autre-salon', 'bulle', 'alice').threadId).not.toBe('fil');
    expect(loadConversation('salon', 'panneau', 'alice').threadId).not.toBe('fil');
  });

  it("ne garde ni raisonnement ni activité, et survit à un stockage illisible", () => {
    saveConversation('salon', 'bulle', 'alice', {
      threadId: 'fil',
      messages: [...messages, { id: 'r', role: 'reasoning', content: 'pensée' } as Message],
    });
    expect(loadConversation('salon', 'bulle', 'alice').messages).toHaveLength(2);

    window.sessionStorage.setItem('spa-copilot:salon:bulle', '{pas du json');
    expect(loadConversation('salon', 'bulle', 'alice').messages).toEqual([]);
  });
});
