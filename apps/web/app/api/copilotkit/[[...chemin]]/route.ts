import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';

import { copilotEnabled } from '@/lib/copilot/config';
import { createOrchestrateur } from '@/lib/copilot/orchestrateur';

/**
 * Le runtime CopilotKit (ADR 0018) — **version spike** (P1-01).
 *
 * Runtime v2 et agent maison sur le SDK Anthropic : l'adaptateur Anthropic de
 * CopilotKit est écarté (voir `lib/copilot/claude-agent.ts`). Le chemin attrape
 * tout ce qui suit `/api/copilotkit` : le runtime y sert `/info`,
 * `/agent/{id}/run`, etc.
 *
 * Fermé — 404, comme une route qui n'existe pas — sans clé Anthropic et en
 * production. Retiré avec le banc d'essai par P1-06.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BASE_PATH = '/api/copilotkit';

let handler: ((request: Request) => Promise<Response>) | undefined;

function copilotHandler(): (request: Request) => Promise<Response> {
  handler ??= createCopilotRuntimeHandler({
    runtime: new CopilotRuntime({
      // Une fabrique par requête : la V1 y lira la session pour ne donner à
      // l'agent que les actions permises (spécification §5).
      agents: () => ({ default: createOrchestrateur() }),
    }),
    basePath: BASE_PATH,
  });
  return handler;
}

async function serve(request: Request): Promise<Response> {
  // Banc d'essai sans session : jamais servi par une image déployée, même
  // copilot ouvert. Les vraies routes sont celles de chaque espace (P1-04).
  if (!copilotEnabled() || process.env.NODE_ENV === 'production') return new Response(null, { status: 404 });
  return copilotHandler()(request);
}

export { serve as GET, serve as POST };
