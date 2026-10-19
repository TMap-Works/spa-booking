import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core';
import type Anthropic from '@anthropic-ai/sdk';
import { firstValueFrom, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { ClaudeAgent } from '@/lib/copilot/claude-agent';
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

function agentWith(replies: FakeReply[]) {
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
