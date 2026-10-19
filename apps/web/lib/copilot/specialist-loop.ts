import type Anthropic from '@anthropic-ai/sdk';

import { MAX_ROUNDS, type BrowserCall, type ServerTool } from './claude-agent';
import type { SpecialistBrief, SpecialistResult } from './specialists';
import type { PendingWrite } from './writes';

/**
 * La boucle d'un spécialiste — spécification §6.2.3, P2-01.
 *
 * Sans mémoire : elle part du brief seul, enchaîne ses outils côté serveur, et
 * rend sa dernière réponse comme `reponse`. Les navigations que ses outils ont
 * préparées remontent dans `actionsFront` ; ce sont les **outils** qui les
 * préparent, après validation de leurs paramètres, jamais le texte du modèle.
 *
 * Pas de streaming : la réponse d'un spécialiste est courte, et elle est
 * affichée d'un bloc par l'orchestrateur (passe-plat).
 */

export interface SpecialistLoopOptions {
  readonly client: Anthropic;
  readonly model: string;
  readonly effort: 'low' | 'medium' | 'high';
  readonly system: string;
  readonly maxTokens: number;
  /** Ce que le serveur sait d'emblée — date du jour, salon — posé avant le brief. */
  readonly context: string;
  readonly tools: readonly ServerTool[];
  /** Où les outils déposent les navigations à faire dans la page. */
  readonly navigations: BrowserCall[];
  readonly fallback: string;
  /** Où les outils déposent l'écriture préparée, s'il y en a une (P3-01). */
  readonly confirmation?: { current: PendingWrite | null };
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

export async function runSpecialistLoop(
  options: SpecialistLoopOptions,
  brief: SpecialistBrief,
  signal: AbortSignal,
): Promise<SpecialistResult> {
  const { client, model, effort, system, maxTokens, context, tools, navigations, fallback, log } = options;
  const pending = () => options.confirmation?.current ?? null;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const faits = Object.entries(brief.faits).map(([key, value]) => `- ${key} : ${value}`);
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: context },
        {
          type: 'text',
          text: `<brief>\nDemande : ${brief.demande}\n${faits.length > 0 ? `Faits établis :\n${faits.join('\n')}` : ''}\n</brief>`,
        },
      ],
    },
  ];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const message = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
        output_config: { effort },
      },
      { signal },
    );

    log?.('copilot.specialist.usage', {
      model,
      round,
      stopReason: message.stop_reason,
      inputTokens: message.usage.input_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      outputTokens: message.usage.output_tokens,
    });

    if (message.stop_reason === 'refusal') {
      return result(fallback, [], null);
    }

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (message.stop_reason !== 'tool_use') {
      return result(text || fallback, navigations, pending());
    }

    messages.push({ role: 'assistant', content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of message.content) {
      if (call.type !== 'tool_use') continue;
      const tool = byName.get(call.name);
      let content = 'Outil inconnu.';
      let isError = true;
      if (tool !== undefined) {
        try {
          const outcome = await tool.run(call.input, signal);
          content = outcome.contenu;
          isError = outcome.kind === 'resultat' && outcome.erreur === true;
        } catch {
          content = "L'outil n'a pas pu répondre. Dis-le simplement, sans inventer.";
        }
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }

  log?.('copilot.specialist.max_rounds', { model });
  return result(fallback, navigations, null);
}

function result(
  reponse: string,
  actionsFront: readonly BrowserCall[],
  confirmation: PendingWrite | null,
): SpecialistResult {
  return { reponse, actionsFront, confirmation, suggestions: [] };
}
