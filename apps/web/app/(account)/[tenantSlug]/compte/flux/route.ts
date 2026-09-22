import type { NextRequest } from 'next/server';

import { relayAppointmentFeed } from '@/lib/appointment-feed-relay';

import { accountActionAccess } from '../session';

/**
 * Le flux temps réel des rendez-vous de la cliente — relayé depuis l'API.
 *
 * Sous `/{salon}/compte/` pour que le cookie de session de l'espace client, posé
 * sur ce chemin, l'accompagne. Voir `lib/appointment-feed-relay.ts`.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<Response> {
  const { tenantSlug } = await context.params;
  const access = await accountActionAccess(tenantSlug);

  return relayAppointmentFeed(access.kind === 'ready' ? access.accessToken : null, request.signal);
}
