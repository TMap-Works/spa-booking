import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import type { CopilotActionId } from '@spa/shared';

import { ApiClientError } from '@/lib/api-client';
import type { ActionAccess } from '@/lib/session-refresh';

import { FixedReplyAgent } from './claude-agent';
import { copilotEnabled } from './config';
import { copilotBasePath } from './paths';
import { reservationSpecialist } from './agents/reservation';
import { anthropicClient, copilotLog, createOrchestrateur, sessionContext } from './orchestrateur';
import { salonData } from './salon-data';
import { resolveCopilotSession, type CopilotSpace, type ResolvedCopilotSession } from './session';
import type { Specialist } from './specialists';
import { suggestionsFor } from './suggestions';
import { checkQuotas, isAgentRun, MemoryCounterStore, RedisCounterStore, type CounterStore } from './quotas';
import { copilotRedis } from './redis';
import {
  decideWrite,
  isSameOrigin,
  MemoryPendingWriteStore,
  RedisPendingWriteStore,
  type PendingWriteStore,
  type WriteExecutor,
} from './writes';

let counters: CounterStore | undefined;
let pendingWrites: PendingWriteStore | undefined;

function pendingWriteStore(): PendingWriteStore {
  if (pendingWrites === undefined) {
    const redis = copilotRedis();
    pendingWrites = redis === null ? new MemoryPendingWriteStore() : new RedisPendingWriteStore(redis);
  }
  return pendingWrites;
}

/**
 * Les écritures que le chat sait exécuter, action par action. Chacune arrive
 * avec le spécialiste qui la propose — Rendez-vous côté cliente (P3-02),
 * praticien (P3-03), gérance (P3-04).
 */
const WRITE_EXECUTORS: Partial<Record<CopilotActionId, WriteExecutor>> = {};

function counterStore(): CounterStore {
  if (counters === undefined) {
    const redis = copilotRedis();
    counters = redis === null ? new MemoryCounterStore() : new RedisCounterStore(redis);
  }
  return counters;
}

const QUOTA_TEXT = {
  fr: "Vous avez envoyé beaucoup de messages en peu de temps. Réessayez dans quelques minutes, ou continuez directement sur le site.",
  en: "You've sent a lot of messages in a short time. Please try again in a few minutes, or carry on directly on the site.",
} as const;

/**
 * Les spécialistes d'une requête. Chacun arrive avec son ticket — Réservation
 * (P2-01) ; Guide (P2-04), Rendez-vous (P3-02), Clients et Encaissement (P4) à
 * suivre. L'orchestrateur n'expose que ceux que la session permet.
 */
function specialistsFor(resolved: ResolvedCopilotSession): Specialist[] {
  const shared = { client: anthropicClient(), session: resolved.session, context: sessionContext(resolved), log: copilotLog };
  return [reservationSpecialist(shared)];
}

/**
 * Les routes du copilot — P1-04 (#1451), ADR 0018.
 *
 * ## Une route par espace
 *
 * `/{salon}/copilot`, `/{salon}/compte/copilot` et `/{salon}/admin/copilot` :
 * les cookies de session ne sont envoyés qu'à leur propre chemin (inventaire
 * §6.1), et la route de chaque espace lit donc les siens — exactement comme le
 * flux temps réel (`admin/flux/route.ts`). Le front n'a qu'à pointer le
 * `runtimeUrl` du fournisseur CopilotKit sur l'espace où il est rendu.
 *
 * ## À chaque requête
 *
 * La session est résolue (P1-05), puis le runtime est construit pour elle :
 * l'agent ne connaît que cette session, et rien n'en survit à la requête hors
 * l'historique de la conversation, rangé sous le salon et la personne.
 *
 * Fermée — 404, comme une route qui n'existe pas — quand le copilot ne l'est
 * pas (`copilotEnabled`), ou que le salon n'existe pas.
 */

type RouteContext = { params: Promise<{ tenantSlug: string }> };


export { copilotBasePath };

export function copilotRoute(
  space: CopilotSpace,
  accessFor?: (tenantSlug: string) => Promise<ActionAccess>,
): (request: Request, context: RouteContext) => Promise<Response> {
  return async (request, context) => {
    if (!copilotEnabled()) return new Response(null, { status: 404 });

    const { tenantSlug } = await context.params;

    let resolved;
    try {
      resolved = await resolveCopilotSession(
        space,
        tenantSlug,
        accessFor === undefined ? {} : { access: () => accessFor(tenantSlug) },
      );
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 404) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 503 });
    }

    // Les suggestions d'ouverture (EF-2) : calculées sans modèle, avant toute
    // lecture du catalogue — elles n'en ont pas besoin.
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === `${copilotBasePath(space, tenantSlug)}/suggestions`) {
      return Response.json({ suggestions: suggestionsFor(resolved.session, url.searchParams.get('page') ?? '') });
    }

    const basePath = copilotBasePath(space, tenantSlug);
    const scope = resolved.subject === null ? null : { tenantSlug, subject: resolved.subject };

    // La décision sur une écriture proposée (P3-01) : étage 0, sans modèle.
    const decision = new RegExp(`^${basePath}/ecritures/([0-9a-f-]{36})$`).exec(url.pathname);
    if (decision !== null) {
      if (request.method !== 'POST' || !isSameOrigin(request)) return new Response(null, { status: 403 });
      const body = (await request.json().catch(() => null)) as { decision?: unknown } | null;
      if (body?.decision !== 'valider' && body?.decision !== 'refuser') return new Response(null, { status: 400 });
      const outcome = await decideWrite({
        store: pendingWriteStore(),
        executors: WRITE_EXECUTORS,
        scope,
        accessToken: resolved.accessToken,
        id: decision[1]!,
        decision: body.decision,
        locale: resolved.session.locale,
      });
      copilotLog('copilot.write.decided', { tenantSlug, statut: outcome.statut, decision: body.decision });
      return Response.json(outcome);
    }

    if (isAgentRun(request, basePath)) {
      const verdict = await checkQuotas(counterStore(), { tenantSlug, subject: resolved.subject, request });
      if (!verdict.ok) {
        copilotLog('copilot.quota.exceeded', { tenantSlug, portee: verdict.portee });
        return createCopilotRuntimeHandler({
          runtime: new CopilotRuntime({
            agents: () => ({ default: new FixedReplyAgent(QUOTA_TEXT[resolved.session.locale]) }),
          }),
          basePath,
        })(request);
      }
    }

    const systemData = await salonData(tenantSlug, resolved.tenant, resolved.session.locale);
    const agent = createOrchestrateur(resolved, {
      systemData,
      specialists: specialistsFor(resolved),
      prepareWrite: scope === null ? null : (write) => pendingWriteStore().put(scope, write),
    });
    const handler = createCopilotRuntimeHandler({
      runtime: new CopilotRuntime({ agents: () => ({ default: agent }) }),
      basePath: copilotBasePath(space, tenantSlug),
    });
    return handler(request);
  };
}
