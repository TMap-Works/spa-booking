import { type NextRequest, NextResponse } from 'next/server';

import { ApiClientError, refreshSession } from '@/lib/api-client';

import { adminLoginPath, safeAdminNext } from '../../paths';
import { attachAdminSession, clearAdminSession, readAdminRefreshToken } from '../../session';

/**
 * Renouvellement silencieux de la session du back-office, puis retour d'où l'on
 * vient (#48, cinquième critère).
 *
 * ## Pourquoi une route et non un layout ni un middleware
 *
 * Poser un cookie demande une réponse, et un Server Component n'en écrit pas :
 * `cookies().set()` n'est permis que dans une action serveur ou une route. La
 * page qui découvre que son jeton d'accès a expiré ne peut donc pas le
 * renouveler elle-même — elle redirige ici, cette route pose la session neuve,
 * et la renvoie à sa page.
 *
 * Un `middleware.ts` ferait le même travail pour **toutes** les routes du front,
 * tunnel de réservation compris — qui n'a pas de session. Le coût serait payé
 * par la surface qui génère le revenu, pour rien. Même arbitrage que l'espace
 * client, et pour les mêmes raisons.
 *
 * ## Ce chemin ne peut pas boucler
 *
 * Le cookie d'accès porte la durée de vie du jeton (voir `session.ts`), si bien
 * qu'« absent » et « expiré » sont le même état. Au retour, le cookie existe
 * donc forcément — sinon le renouvellement a échoué, et l'on est parti à la
 * connexion sans repasser par la page.
 */

/** Une route de session ne se met jamais en cache. */
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { readonly params: Promise<{ readonly tenantSlug: string }> },
): Promise<NextResponse> {
  const { tenantSlug } = await context.params;
  const next = safeAdminNext(request.nextUrl.searchParams.get('next'), tenantSlug);
  const refreshToken = await readAdminRefreshToken();

  if (refreshToken === null) {
    return NextResponse.redirect(new URL(adminLoginPath(tenantSlug), request.nextUrl));
  }

  try {
    const renewed = await refreshSession(refreshToken);
    const response = NextResponse.redirect(new URL(next, request.nextUrl));
    attachAdminSession(response.cookies, tenantSlug, renewed);
    return response;
  } catch (error) {
    // Jeton révoqué, expiré ou réemployé — l'API ne distingue pas, et il n'y a
    // rien à en dire au-delà de « reconnectez-vous ». Les deux cookies partent
    // alors : en garder un ferait retenter ce chemin à chaque navigation.
    //
    // Mais **seulement alors**. Un 429 du limiteur de débit, un 503, une coupure
    // réseau : rien de cela ne dit que le jeton est mauvais, et effacer le
    // cookie sur cette foi-là déconnecte pour de bon une session valide. Le
    // limiteur n'est pas hypothétique — il compte par adresse IP, et tous les
    // appels partent du serveur Next, donc d'une seule.
    const revoked =
      error instanceof ApiClientError && (error.status === 401 || error.status === 403);

    const response = NextResponse.redirect(new URL(adminLoginPath(tenantSlug), request.nextUrl));

    if (revoked) {
      clearAdminSession(response.cookies, tenantSlug);
    }
    return response;
  }
}
