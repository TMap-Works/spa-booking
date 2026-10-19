import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core';
import type Anthropic from '@anthropic-ai/sdk';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { ClaudeAgent, MAX_ROUNDS, type ClaudeAgentOptions, type ServerTool } from '@/lib/copilot/claude-agent';
import { MemoryTranscriptStore } from '@/lib/copilot/transcript-store';

/**
 * L'agent Claude du copilot contre un faux client : aucune requête réseau.
 * Ce qu'on vérifie, ce sont les règles de la spécification §6.4 — historique
 * en ajout seul avec ses blocs de réflexion, pas de `tool_choice`, effort
 * explicite, refus rendu en clair.
 */

type FakeReply = Pick<Anthropic.Message, 'id' | 'content' | 'stop_reason'>;

function fakeClient(replies: FakeReply[]) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      stream(params: Anthropic.MessageCreateParams) {
        // Copie profonde : l'agent ne doit pas pouvoir réécrire après coup ce qu'il a envoyé.
        calls.push(structuredClone(params));
        const reply = replies.shift();
        if (!reply) throw new Error('aucune réponse prévue');
        const message = {
          ...reply,
          type: 'message',
          role: 'assistant',
          model: params.model,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
        } as unknown as Anthropic.Message;
        const events = [
          { type: 'message_start', message: { ...message, content: [] } },
          ...reply.content.flatMap((block, index) =>
            block.type === 'text'
              ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]
              : [],
          ),
        ];
        return {
          async *[Symbol.asyncIterator]() {
            yield* events;
          },
          finalMessage: async () => message,
        };
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

function agentWith(replies: FakeReply[], extra: Partial<ClaudeAgentOptions> = {}) {
  const { client, calls } = fakeClient(replies);
  const store = new MemoryTranscriptStore();
  const agent = new ClaudeAgent({
    client,
    model: 'claude-haiku-5-5',
    effort: 'low',
    system: 'prompt système',
    maxTokens: 1024,
    store,
    transcriptKey: (threadId) => `test:${threadId}`,
    refusalText: 'Je ne peux pas répondre.',
    ...extra,
  });
  return { agent, calls, store };
}

function input(messages: Message[], extra: Partial<RunAgentInput> = {}): RunAgentInput {
  return { threadId: 'fil-1', runId: `run-${messages.length}`, state: {}, messages, tools: [], context: [], forwardedProps: {}, ...extra };
}

async function run(agent: ClaudeAgent, runInput: RunAgentInput): Promise<BaseEvent[]> {
  return firstValueFrom(agent.run(runInput).pipe(toArray()));
}

const THINKING: Anthropic.ThinkingBlock = { type: 'thinking', thinking: '', signature: 'sig-opaque' };

describe('ClaudeAgent', () => {
  it('diffuse le texte et ne force jamais un outil', async () => {
    const { agent, calls } = agentWith([
      { id: 'msg_a', stop_reason: 'end_turn', content: [THINKING, { type: 'text', text: 'Bonjour !', citations: null }] },
    ]);

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'Salut' }]));

    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(calls[0]).not.toHaveProperty('tool_choice');
    expect(calls[0]?.output_config).toEqual({ effort: 'low' });
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Salut' }] }]);
  });

  it('rend à Claude les blocs de réflexion tels quels, sans reprendre ce que renvoie le navigateur', async () => {
    const first: FakeReply = { id: 'msg_a', stop_reason: 'end_turn', content: [THINKING, { type: 'text', text: 'Bonjour !', citations: null }] };
    const { agent, calls } = agentWith([first, { id: 'msg_b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Volontiers.', citations: null }] }]);

    await run(agent, input([{ id: 'u1', role: 'user', content: 'Salut' }]));
    await run(
      agent,
      input([
        { id: 'u1', role: 'user', content: 'Salut' },
        // Ce que CopilotKit renvoie : le même identifiant, sans la réflexion — et ici modifié.
        { id: 'msg_a', role: 'assistant', content: 'Texte réécrit par le navigateur' },
        { id: 'u2', role: 'user', content: 'Un massage ?' },
      ]),
    );

    expect(calls[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Salut' }] },
      { role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'text', text: 'Un massage ?' }] },
    ]);
  });

  it("émet l'appel d'outil une fois le message complet, puis verse son résultat en tête du tour suivant", async () => {
    const toolUse: Anthropic.ToolUseBlock = { type: 'tool_use', id: 'toolu_1', name: 'ouvrir_tunnel', input: { prestation: 'massage' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock;
    const { agent, calls } = agentWith([
      { id: 'msg_a', stop_reason: 'tool_use', content: [THINKING, toolUse] },
      { id: 'msg_b', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Voilà.', citations: null }] },
    ]);

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'Je veux un massage' }]));
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events[2]).toMatchObject({ toolCallId: 'toolu_1', delta: '{"prestation":"massage"}' });

    await run(
      agent,
      input([
        { id: 'u1', role: 'user', content: 'Je veux un massage' },
        { id: 'msg_a', role: 'assistant', toolCalls: [{ id: 'toolu_1', type: 'function', function: { name: 'ouvrir_tunnel', arguments: '{}' } }] },
        { id: 't1', role: 'tool', toolCallId: 'toolu_1', content: 'tunnel ouvert' },
      ]),
    );
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'tunnel ouvert' }],
    });
    expect(calls[1]?.messages.at(-2)).toEqual({ role: 'assistant', content: [THINKING, toolUse] });
  });

  it("rend un message neutre sur un refus, et n'en garde rien", async () => {
    const { agent, store } = agentWith([{ id: 'msg_a', stop_reason: 'refusal', content: [] }]);

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: '…' }]));

    expect(events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toMatchObject({ delta: 'Je ne peux pas répondre.' });
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect((await store.get('test:fil-1'))?.messages).toEqual([]);
  });

  it("n'appelle pas Claude quand rien de neuf n'est arrivé", async () => {
    const { agent, calls } = agentWith([]);

    const events = await run(agent, input([{ id: 'a0', role: 'assistant', content: 'Bienvenue' }]));

    expect(calls).toHaveLength(0);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
  });

  it("joint le contexte de l'écran au dernier message, jamais au prompt système", async () => {
    const { agent, calls } = agentWith([{ id: 'msg_a', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok', citations: null }] }]);

    await run(agent, input([{ id: 'u1', role: 'user', content: 'Où suis-je ?' }], { context: [{ description: 'Écran', value: 'vitrine' }] }));

    expect(calls[0]?.system).toEqual([{ type: 'text', text: 'prompt système', cache_control: { type: 'ephemeral' } }]);
    const content = calls[0]?.messages[0]?.content as Anthropic.TextBlockParam[];
    expect(content[0]?.text).toContain('<contexte_page>');
    expect(content[1]).toEqual({ type: 'text', text: 'Où suis-je ?' });
  });
});

describe('ClaudeAgent — outils serveur', () => {
  const toolUse = (id: string, name: string, toolInput: Record<string, unknown>): Anthropic.ToolUseBlock =>
    ({ type: 'tool_use', id, name, input: toolInput, caller: { type: 'direct' } }) as unknown as Anthropic.ToolUseBlock;
  const text = (value: string): Anthropic.TextBlock => ({ type: 'text', text: value, citations: null });

  function serverTool(name: string, run: ServerTool['run']): ServerTool {
    return { name, description: `outil ${name}`, inputSchema: { type: 'object', properties: {} }, run };
  }

  it("exécute une lecture et rend son résultat à Claude dans le même tour", async () => {
    const lire = vi.fn(async () => ({ kind: 'resultat' as const, contenu: 'Massage 60 min : 70 €' }));
    const { agent, calls, store } = agentWith(
      [
        { id: 'msg_a', stop_reason: 'tool_use', content: [toolUse('t1', 'lire_catalogue', { recherche: 'massage' })] },
        { id: 'msg_b', stop_reason: 'end_turn', content: [text('Le massage de 60 min coûte 70 €.')] },
      ],
      { serverTools: [serverTool('lire_catalogue', lire)] },
    );

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'Prix du massage ?' }]));

    expect(lire).toHaveBeenCalledWith({ recherche: 'massage' }, expect.any(AbortSignal));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Massage 60 min : 70 €' }],
    });
    expect(events.some((e) => e.type === EventType.TOOL_CALL_START)).toBe(false);
    expect((await store.get('test:fil-1'))?.pending).toBeUndefined();
  });

  it('passe-plat : affiche le texte, navigue, et garde le résultat pour le message suivant', async () => {
    const mener = vi.fn(async () => ({
      kind: 'fin' as const,
      contenu: 'Navigation vers /salon/compte/historique.',
      texte: 'Voici votre historique.',
      navigateur: [{ outil: 'naviguer', arguments: { chemin: '/salon/compte/historique' } }],
    }));
    const { agent, calls, store } = agentWith(
      [
        { id: 'msg_a', stop_reason: 'tool_use', content: [toolUse('t1', 'guide_mener', { route: 'historique' })] },
        { id: 'msg_b', stop_reason: 'end_turn', content: [text('Avec plaisir.')] },
      ],
      { serverTools: [serverTool('guide_mener', mener)] },
    );

    const first = await run(agent, input([{ id: 'u1', role: 'user', content: 'Mon historique' }]));

    expect(calls).toHaveLength(1);
    const contents = first.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as unknown as { delta: string }[];
    expect(contents.map((e) => e.delta)).toEqual(['Voici votre historique.']);
    const navigation = first.find((e) => e.type === EventType.TOOL_CALL_START) as unknown as {
      toolCallId: string;
      toolCallName: string;
    };
    expect(navigation.toolCallName).toBe('naviguer');
    expect(navigation.toolCallId.startsWith('nav-')).toBe(true);
    expect((await store.get('test:fil-1'))?.pending).toHaveLength(1);

    // CopilotKit relance l'agent avec le résultat de la navigation : rien à dire.
    const followUp = await run(
      agent,
      input([
        { id: 'u1', role: 'user', content: 'Mon historique' },
        { id: 'tool-nav', role: 'tool', toolCallId: navigation.toolCallId, content: 'ok' },
      ]),
    );
    expect(calls).toHaveLength(1);
    expect(followUp.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);

    // Le message suivant de l'utilisateur s'ouvre sur le résultat gardé.
    await run(
      agent,
      input([
        { id: 'u1', role: 'user', content: 'Mon historique' },
        { id: 'u2', role: 'user', content: 'Merci' },
      ]),
    );
    expect(calls[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Navigation vers /salon/compte/historique.' },
        { type: 'text', text: 'Merci' },
      ],
    });
    expect((await store.get('test:fil-1'))?.pending).toBeUndefined();
  });

  it("une panne d'outil devient un résultat d'erreur, pas une panne du chat", async () => {
    const { agent, calls } = agentWith(
      [
        { id: 'msg_a', stop_reason: 'tool_use', content: [toolUse('t1', 'lire', {})] },
        { id: 'msg_b', stop_reason: 'end_turn', content: [text("Je n'ai pas pu lire le catalogue.")] },
      ],
      {
        serverTools: [
          serverTool('lire', async () => {
            throw new Error('API injoignable');
          }),
        ],
      },
    );

    await run(agent, input([{ id: 'u1', role: 'user', content: 'Tarifs ?' }]));

    const result = (calls[1]?.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0];
    expect(result?.is_error).toBe(true);
  });

  it(`s'arrête après ${MAX_ROUNDS} appels si un outil boucle`, async () => {
    const replies = Array.from({ length: MAX_ROUNDS }, (_, i) => ({
      id: `msg_${i}`,
      stop_reason: 'tool_use' as const,
      content: [toolUse(`t${i}`, 'lire', {})],
    }));
    const { agent, calls } = agentWith(replies, {
      serverTools: [serverTool('lire', async () => ({ kind: 'resultat', contenu: 'encore' }))],
    });

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'Boucle' }]));

    expect(calls).toHaveLength(MAX_ROUNDS);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  it('ne montre jamais à Claude les exécutants du navigateur, et met en cache les données du salon', async () => {
    const { agent, calls } = agentWith(
      [{ id: 'msg_a', stop_reason: 'end_turn', content: [text('Bonjour')] }],
      { systemData: '<donnees_salon>…</donnees_salon>' },
    );

    await run(
      agent,
      input([{ id: 'u1', role: 'user', content: 'Salut' }], {
        tools: [
          { name: 'naviguer', description: 'exécutant', parameters: { type: 'object', properties: {} } },
          { name: 'filtrer_prestations', description: 'filtre', parameters: { type: 'object', properties: {} } },
        ],
      }),
    );

    expect(calls[0]?.tools?.map((tool) => (tool as Anthropic.Tool).name)).toEqual(['filtrer_prestations']);
    expect(calls[0]?.system).toEqual([
      { type: 'text', text: 'prompt système', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<donnees_salon>…</donnees_salon>', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

describe('ClaudeAgent — bornes', () => {
  const limits = {
    maxMessageChars: 20,
    maxTranscriptMessages: 2,
    texts: { messageTooLong: 'Trop long.', conversationTooLong: 'Conversation trop longue.' },
  };
  const reply = (id: string): FakeReply => ({ id, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok', citations: null }] });

  it("un message trop long reçoit une réponse fixe, n'entre pas dans l'historique, et ne bloque pas le suivant", async () => {
    const { agent, calls, store } = agentWith([reply('msg_a')], { limits });

    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'x'.repeat(21) }]));
    const texts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as unknown as { delta: string }[];
    expect(texts.map((e) => e.delta)).toEqual(['Trop long.']);
    expect(calls).toHaveLength(0);
    expect((await store.get('test:fil-1'))?.messages).toEqual([]);

    await run(agent, input([{ id: 'u1', role: 'user', content: 'x'.repeat(21) }, { id: 'u2', role: 'user', content: 'Court' }]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Court' }] }]);
  });

  it('une conversation pleine propose d’en ouvrir une nouvelle, sans appel', async () => {
    const { agent, calls } = agentWith([reply('msg_a')], { limits });

    await run(agent, input([{ id: 'u1', role: 'user', content: 'Un' }]));
    const events = await run(agent, input([{ id: 'u1', role: 'user', content: 'Un' }, { id: 'u2', role: 'user', content: 'Deux' }]));

    expect(calls).toHaveLength(1);
    const texts = events.filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT) as unknown as { delta: string }[];
    expect(texts.map((e) => e.delta)).toEqual(['Conversation trop longue.']);
  });
});
