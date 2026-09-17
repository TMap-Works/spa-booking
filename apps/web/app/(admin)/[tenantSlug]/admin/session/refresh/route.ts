import type { NextRequest, NextResponse } from 'next/server';

import { refreshSession } from '@/lib/api-client';
import { redirectWithinSite } from '@/lib/relative-redirect';
import { isRefreshRefused, sessionNoticeFor } from '@/lib/session-refresh';

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
 *
 * ## Deux renouvellements à la fois (#856)
 *
 * Deux onglets rechargés ensemble, un double clic sur un lien du rail, l'effet
 * rejoué par `reactStrictMode` : deux requêtes arrivent ici avec le même
 * cookie. L'API fait tourner la session pour la première et rend à la seconde
 * un jeton d'accès **sans** jeton de rafraîchissement. Cette réponse-là ne pose
 * donc que le cookie d'accès, et laisse en place celui du gagnant — quel que
 * soit l'ordre dans lequel les deux réponses reviennent au navigateur.
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
    return redirectWithinSite(adminLoginPath(tenantSlug));
  }

  // Relative, et non construite sur `request.nextUrl` : voir `redirectWithinSite`.
  // Construite **avant** l'appel : une fois le jeton tourné par l'API, plus rien
  // ne doit pouvoir lever avant que le cookie neuf ne soit posé — sans quoi il
  // serait perdu, et le renouvellement suivant passerait pour un réemploi.
  const renewedResponse = redirectWithinSite(next);

  try {
    const renewed = await refreshSession(refreshToken);
    attachAdminSession(renewedResponse.cookies, tenantSlug, renewed);
    return renewedResponse;
  } catch (error) {
    // Jeton révoqué, expiré ou réemployé — l'API ne distingue pas, et il n'y a
    // rien à en dire au-delà de « reconnectez-vous ». Les deux cookies partent
    // alors : en garder un ferait retenter ce chemin à chaque navigation.
    //
    // Mais **seulement alors** : un 429 du limiteur de débit, un 503, une
    // coupure réseau ne disent rien du jeton (voir `isRefreshRefused`).
    const revoked = isRefreshRefused(error);

    // Et l'écran d'arrivée le dit (#860). Sans motif, l'opérateur tombait sur un
    // formulaire de connexion muet, qui ne se lit que d'une façon : « on m'a
    // déconnecté ». Sa session est pourtant intacte — ses deux cookies sont
    // encore là —, et la seule chose à faire est d'attendre quelques secondes.
    const response = redirectWithinSite(adminLoginPath(tenantSlug, sessionNoticeFor(error)));

    if (revoked) {
      clearAdminSession(response.cookies, tenantSlug);
    }
    return response;
  }
}
