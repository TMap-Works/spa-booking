import { NextResponse, type NextRequest } from 'next/server';

import { platformLoginPath } from '../../paths';
import { PLATFORM_ACCESS_COOKIE, PLATFORM_OPERATOR_COOKIE } from '../../session';

/**
 * Efface la session de console et renvoie à la connexion.
 *
 * Un Server Component ne peut pas écrire de cookie : sans cette route, un jeton
 * refusé par l'API (clé tournée, opérateur désactivé) resterait en place, et la
 * connexion — qui redirige toute session présente vers la console — bouclerait.
 */
export function GET(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL(platformLoginPath('session-expiree'), request.url));

  for (const name of [PLATFORM_ACCESS_COOKIE, PLATFORM_OPERATOR_COOKIE]) {
    response.cookies.set(name, '', { path: '/plateforme', maxAge: 0 });
  }

  return response;
}
