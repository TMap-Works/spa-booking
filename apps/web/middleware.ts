import { NextResponse, type NextRequest } from 'next/server';

import { TENANT_SLUG_HEADER } from '@/i18n/cookies';
import { tenantSlugFromPathname } from '@/lib/tenant-slug';

/**
 * Le seul travail de ce middleware : dire à la résolution de langue **quel
 * salon** la page visitée concerne (#845).
 *
 * ## Pourquoi il faut un middleware pour cela
 *
 * L'ordre de résolution de l'épique se termine par `Tenant.defaultLocale` : un
 * salon québécois s'ouvre en français pour qui n'a rien demandé. Or la langue est
 * posée sur `<html lang>` par le **layout racine**, qui ne reçoit aucun `params`
 * — l'App Router ne lui donne pas le segment `[tenantSlug]` d'une route
 * enfant — et aucune API de Next ne rend le chemin courant à un Server
 * Component.
 *
 * Le middleware, lui, voit l'URL. Il recopie donc le premier segment dans un
 * en-tête de requête, que `i18n/server.ts` relit. C'est la seule information
 * qu'il ajoute, et il ne redirige, ne réécrit et ne refuse rien : **aucune
 * décision d'autorisation ne se prend ici** — la seule frontière qui compte est
 * celle de l'API (web-frontend §1), et un middleware n'est pas rejoué sur les
 * navigations client de l'App Router.
 *
 * ## Le segment n'est pas forcément un salon
 *
 * `/inscription`, `/plateforme`, `/` : le premier segment y désigne une page de
 * la plateforme, pas un établissement. Rien ne les distingue d'un slug sans
 * interroger l'API, et c'est très bien : `i18n/server.ts` appelle
 * `GET /public/{slug}`, reçoit un 404 et passe à l'étape suivante de l'ordre.
 * Filtrer ici aurait demandé d'y tenir une seconde liste des routes réservées,
 * qui aurait divergé de celle de l'API au premier ajout.
 *
 * L'appel n'a de toute façon lieu que lorsque les trois signaux qui précèdent
 * l'établissement sont muets — voir `requestLocale`.
 *
 * Seule la **forme** du segment est vérifiée ici, et ce n'est pas un filtre de
 * routes : un slug d'établissement est un label DNS (`SLUG_SHAPE` ci-dessous),
 * donc de l'ASCII. Le segment, lui, vient de l'URL et passe par
 * `decodeURIComponent` : `/%E6%97%A5%E6%9C%AC` rend « 日本 », et
 * `Headers.set` **lève** sur toute valeur qui sort de l'octet — la page
 * introuvable serait alors servie en 500. Ce qui n'a pas la forme d'un slug ne
 * peut de toute façon désigner aucun salon.
 *
 * ## Le filtre `matcher`
 *
 * Tout sauf les ressources servies telles quelles : le middleware coûterait un
 * passage par requête d'image ou de script, pour un en-tête dont aucune d'elles
 * n'a l'usage.
 */
/**
 * La forme d'un slug d'établissement — un label DNS.
 *
 * Recopié de `DNS_LABEL_PATTERN` (`@spa/shared`) plutôt qu'importé : le baril du
 * contrat entraîne zod, et ce middleware s'exécute sur **chaque** requête de
 * page. Le motif ne bouge pas — un salon est un nom d'hôte depuis #837 — et une
 * divergence n'aurait de toute façon d'autre effet que de taire un en-tête
 * d'affichage.
 */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function middleware(request: NextRequest): NextResponse {
  const tenantSlug = tenantSlugFromPathname(request.nextUrl.pathname);

  const headers = new Headers(request.headers);

  if (tenantSlug === null || !SLUG_SHAPE.test(tenantSlug)) {
    // Effacé plutôt que laissé tel quel : l'en-tête vient du client sur une
    // requête forgée, et un `x-spa-tenant-slug` envoyé à la main ferait lire la
    // langue d'un établissement que la page ne sert pas.
    headers.delete(TENANT_SLUG_HEADER);
  } else {
    headers.set(TENANT_SLUG_HEADER, tenantSlug);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
