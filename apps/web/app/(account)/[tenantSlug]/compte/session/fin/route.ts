import { type NextRequest, NextResponse } from 'next/server';

import { logoutSession } from '@/lib/api-client';

import { loginPath } from '../../paths';
import { clearSessionCookies, readRefreshToken } from '../../session';

/**
 * Fin de session **subie** — celle qu'une page constate, pas celle qu'une
 * visiteuse demande.
 *
 * Le cas est précis : le cookie d'accès était présent, et l'API a pourtant
 * répondu 401. La session a donc été révoquée en base — changement de rôle,
 * réemploi de jeton détecté — ou l'API a changé de secret. Renouveler échouerait
 * pour la même raison ; la seule issue est de fermer proprement et de le dire.
 *
 * La déconnexion **voulue**, elle, passe par `logoutAction` : c'est une écriture
 * demandée par la visiteuse, et une écriture ne se déclenche pas par un `GET`
 * qu'un site tiers pourrait provoquer. Cette route-ci n'est atteinte que par une
 * redirection émise par nos propres pages.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<NextResponse> {
  const { tenantSlug } = await context.params;
  const refreshToken = await readRefreshToken();

  if (refreshToken !== null) {
    try {
      await logoutSession(refreshToken);
    } catch {
      // Sans effet sur la suite : les cookies partent de toute façon, et une
      // session déjà révoquée est exactement le cas qui amène ici.
    }
  }

  const response = NextResponse.redirect(
    new URL(loginPath(tenantSlug, 'session-expiree'), request.nextUrl),
  );
  clearSessionCookies(response.cookies, tenantSlug);
  return response;
}
