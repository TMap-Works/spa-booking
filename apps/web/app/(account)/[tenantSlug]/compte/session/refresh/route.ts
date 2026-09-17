import type { NextRequest, NextResponse } from 'next/server';

import { refreshSession } from '@/lib/api-client';
import { redirectWithinSite } from '@/lib/relative-redirect';
import { sitePath } from '@/lib/site-path';
import { isRefreshRefused, sessionNoticeFor } from '@/lib/session-refresh';

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
 *
 * ## Deux renouvellements à la fois (#856)
 *
 * Deux onglets rechargés ensemble, un double clic, l'effet rejoué par
 * `reactStrictMode` : deux requêtes arrivent ici avec le même cookie. L'API
 * fait tourner la session pour la première et rend à la seconde un jeton
 * d'accès **sans** jeton de rafraîchissement. Cette réponse-là ne pose donc que
 * le cookie d'accès, et laisse en place celui du gagnant — quel que soit
 * l'ordre dans lequel les deux réponses reviennent au navigateur.
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
 *
 * Les deux se jugent sur le chemin **normalisé**, qui est aussi celui qu'on
 * rend (#856) : `/{slug}/compte/../..//exemple.test` porte le bon préfixe et se
 * résout pourtant en `//exemple.test`. Voir `sitePath`.
 */
function safeNext(candidate: string | null, tenantSlug: string): string {
  const home = accountPath(tenantSlug);

  // `//exemple.test` est une URL protocole-relative : elle commence bien par
  // `/` et mène pourtant ailleurs. `sitePath` la refuse, avant comme après la
  // résolution des `..`.
  const path = candidate === null ? null : sitePath(candidate);

  if (path === null) {
    return home;
  }

  return path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}?`)
    ? path
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
    return redirectWithinSite(loginPath(tenantSlug));
  }

  // Relative, et non construite sur `request.nextUrl` : voir `redirectWithinSite`.
  // Construite **avant** l'appel : une fois le jeton tourné par l'API, plus rien
  // ne doit pouvoir lever avant que le cookie neuf ne soit posé.
  const renewedResponse = redirectWithinSite(next);

  try {
    const renewed = await refreshSession(refreshToken);
    attachSessionCookies(renewedResponse.cookies, tenantSlug, renewed);
    return renewedResponse;
  } catch (error) {
    // Jeton révoqué, expiré, ou réemployé — l'API ne distingue pas, et il n'y a
    // rien à en dire à la visiteuse au-delà de « reconnectez-vous ». Les deux
    // cookies partent alors : en garder un ferait retenter ce chemin à chaque
    // navigation.
    //
    // Mais **seulement alors** (voir `isRefreshRefused`). Sur une panne ou le
    // limiteur, on renvoie à la connexion sans rien détruire : la navigation
    // suivante repassera par ici et pourra aboutir.
    const revoked = isRefreshRefused(error);

    // Et l'écran d'arrivée dit **laquelle** des deux choses est arrivée (#860).
    // « Votre session a expiré » sous un refus du limiteur était un mensonge
    // commode : la session est valide, ses cookies sont en place, et la
    // visiteuse n'a rien à ressaisir.
    const response = redirectWithinSite(loginPath(tenantSlug, sessionNoticeFor(error)));

    if (revoked) {
      clearSessionCookies(response.cookies, tenantSlug);
    }
    return response;
  }
}
