// @vitest-environment node

import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import type { ServerTool } from '@/lib/copilot/claude-agent';
import { runSpecialistLoop, SPECIALIST_MAX_ROUNDS } from '@/lib/copilot/specialist-loop';
import type { PendingWrite } from '@/lib/copilot/writes';

/** La boucle d'un spécialiste : bornée, et sans perdre une écriture déjà préparée. */

const write: PendingWrite = {
  action: 'rendez_vous.reporter',
  parametres: {},
  recapitulatif: { titre: 'Reporter', lignes: [] },
  succes: 'Reporté.',
};

function looping() {
  const create = vi.fn(async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: `t${create.mock.calls.length}`, name: 'outil', input: {} }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const tool: ServerTool = {
  name: 'outil',
  description: 'boucle',
  inputSchema: { type: 'object', properties: {} },
  run: async () => ({ kind: 'resultat', contenu: 'encore' }),
};

const options = (client: Anthropic, confirmation?: { current: PendingWrite | null }) => ({
  client,
  model: 'm',
  effort: 'low' as const,
  system: 's',
  maxTokens: 10,
  context: '',
  tools: [tool],
  navigations: [],
  fallback: 'Je n’ai pas pu.',
  ...(confirmation === undefined ? {} : { confirmation }),
});

describe('runSpecialistLoop', () => {
  it(`s'arrête après ${SPECIALIST_MAX_ROUNDS} appels et rend la réponse de secours`, async () => {
    const { client, create } = looping();
    const result = await runSpecialistLoop(options(client), { demande: 'x', faits: {} }, new AbortController().signal);
    expect(create).toHaveBeenCalledTimes(SPECIALIST_MAX_ROUNDS);
    expect(result).toMatchObject({ reponse: 'Je n’ai pas pu.', confirmation: null });
  });

  it('garde une écriture préparée quand la borne tombe', async () => {
    const { client } = looping();
    const result = await runSpecialistLoop(
      options(client, { current: write }),
      { demande: 'x', faits: {} },
      new AbortController().signal,
    );
    expect(result.confirmation).toEqual(write);
    expect(result.reponse).toContain('validez');
  });
});
