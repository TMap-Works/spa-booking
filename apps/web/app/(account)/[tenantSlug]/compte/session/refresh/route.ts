import { type NextRequest, NextResponse } from 'next/server';

import { ApiClientError, refreshSession } from '@/lib/api-client';

import { accountPath, loginPath } from '../../paths';
import { attachSessionCookies, clearSessionCookies, readRefreshToken } from '../../session';

/**
 * Renouvellement silencieux de la session, puis retour d'où l'on vient.
 *
 * ## Pourquoi une route et non un middleware
 *
 * Parce que poser un cookie demande une réponse, et qu'un Server Component n'en
 * écrit pas : `cookies().set()` n'est permis que dans une action serveur ou une
 * route. Une page qui découvre que son jeton d'accès a expiré ne peut donc pas le
 * renouveler elle-même — elle redirige ici, cette route pose la session neuve, et
 * renvoie la visiteuse à sa page. Un `middleware.ts` ferait le même travail pour
 * **toutes** les routes du front, y compris le tunnel de réservation, qui n'a
 * pas de session : le coût serait payé par la surface qui génère le revenu.
 *
 * ## Ce chemin ne peut pas boucler
 *
 * Le cookie d'accès porte la durée de vie du jeton, si bien qu'« absent » et
 * « expiré » sont le même état (voir `session.ts`). Au retour de cette route, le
 * cookie existe donc forcément — sinon le renouvellement a échoué, et l'on est
 * parti à la connexion sans repasser par la page.
 */

/** Vitesse de rafraîchissement d'une page qui ne se met jamais en cache. */
export const dynamic = 'force-dynamic';

/**
 * Ramène `next` à une destination sûre.
 *
 * Un `next` non vérifié est une redirection ouverte : `?next=https://exemple.test`
 * ferait de cette route un tremplin vers un site tiers, sous notre domaine et
 * avec notre crédibilité. Deux contrôles suffisent, et ils sont volontairement
 * stricts — la destination doit être **dans l'espace client de cet
 * établissement**, ce qui est la seule chose que cette route ait à savoir
 * renvoyer.
 */
function safeNext(candidate: string | null, tenantSlug: string): string {
  const home = accountPath(tenantSlug);

  if (candidate === null) {
    return home;
  }

  // `//exemple.test` est une URL protocole-relative : elle commence bien par
  // `/` et mène pourtant ailleurs. Le second caractère est donc vérifié aussi.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) {
    return home;
  }

  return candidate === home || candidate.startsWith(`${home}/`) || candidate.startsWith(`${home}?`)
    ? candidate
    : home;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ tenantSlug: string }> },
): Promise<NextResponse> {
  const { tenantSlug } = await context.params;
  const next = safeNext(request.nextUrl.searchParams.get('next'), tenantSlug);
  const refreshToken = await readRefreshToken();

  if (refreshToken === null) {
    return NextResponse.redirect(new URL(loginPath(tenantSlug), request.nextUrl));
  }

  try {
    const renewed = await refreshSession(refreshToken);
    const response = NextResponse.redirect(new URL(next, request.nextUrl));
    attachSessionCookies(response.cookies, tenantSlug, renewed);
    return response;
  } catch (error) {
    // Jeton révoqué, expiré, ou réemployé — l'API ne distingue pas, et il n'y a
    // rien à en dire à la visiteuse au-delà de « reconnectez-vous ». Les deux
    // cookies partent alors : en garder un ferait retenter ce chemin à chaque
    // navigation.
    //
    // Mais **seulement alors**. Un 429 du limiteur de débit, un 503, une coupure
    // réseau : rien de tout cela ne dit que le jeton est mauvais, et effacer le
    // cookie sur cette foi-là déconnecte pour de bon une session parfaitement
    // valide. Le limiteur n'est pas hypothétique — il compte par adresse IP, et
    // tous les appels partent du serveur Next, donc d'une seule. On renvoie donc
    // à la connexion sans rien détruire : la navigation suivante repassera par
    // ici et pourra aboutir.
    const revoked =
      error instanceof ApiClientError && (error.status === 401 || error.status === 403);

    const response = NextResponse.redirect(
      new URL(loginPath(tenantSlug, 'session-expiree'), request.nextUrl),
    );

    if (revoked) {
      clearSessionCookies(response.cookies, tenantSlug);
    }
    return response;
  }
}
