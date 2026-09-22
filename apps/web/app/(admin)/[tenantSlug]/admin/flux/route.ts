import type { NextRequest } from 'next/server';

import { relayAppointmentFeed } from '@/lib/appointment-feed-relay';

import { adminActionAccess } from '../session';

/**
 * Le flux temps réel des rendez-vous du back-office — relayé depuis l'API.
 *
 * Sous `/{salon}/admin/` pour que le cookie de session du back-office, posé sur
 * ce chemin, l'accompagne. Voir `lib/appointment-feed-relay.ts`.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<Response> {
  const { tenantSlug } = await context.params;
  const access = await adminActionAccess(tenantSlug);

  return relayAppointmentFeed(access.ok ? access.accessToken : null, request.signal);
}
