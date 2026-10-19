import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';

import { ApiClientError } from '@/lib/api-client';
import type { ActionAccess } from '@/lib/session-refresh';

import { copilotEnabled } from './config';
import { copilotBasePath } from './paths';
import { reservationSpecialist } from './agents/reservation';
import { anthropicClient, copilotLog, createOrchestrateur, sessionContext } from './orchestrateur';
import { salonData } from './salon-data';
import { resolveCopilotSession, type CopilotSpace, type ResolvedCopilotSession } from './session';
import type { Specialist } from './specialists';
import { suggestionsFor } from './suggestions';

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

    const systemData = await salonData(tenantSlug, resolved.tenant, resolved.session.locale);
    const agent = createOrchestrateur(resolved, { systemData, specialists: specialistsFor(resolved) });
    const handler = createCopilotRuntimeHandler({
      runtime: new CopilotRuntime({ agents: () => ({ default: agent }) }),
      basePath: copilotBasePath(space, tenantSlug),
    });
    return handler(request);
  };
}
