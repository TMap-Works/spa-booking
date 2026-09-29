import { NextResponse, type NextRequest } from 'next/server';

import { ADMIN_WORKSPACE, TENANT_SLUG_HEADER, TENANT_WORKSPACE_HEADER } from '@/i18n/cookies';
import { pathSegment, tenantSlugFromPathname } from '@/lib/tenant-slug';

/**
 * Le seul travail de ce middleware : dire à la résolution de langue **quel
 * salon** la page visitée concerne (#845), et **de quel côté** de ce salon elle
 * se trouve (#1326).
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
 * L'appel n'a de toute façon lieu que lorsque les signaux qui précèdent
 * l'établissement sont muets — voir `requestLocale`.
 *
 * ## Le second en-tête : le back-office (#1326)
 *
 * Le back-office d'un salon est **son** espace de travail, et non celui de son
 * visiteur : son équipe y travaille dans la langue de l'établissement tant que
 * personne n'a demandé autre chose — c'est ce que promet le bloc « Ma langue »
 * de ses réglages. La résolution y place donc `Tenant.defaultLocale` avant
 * l'`Accept-Language`, et le layout racine a besoin de savoir qu'il y est.
 *
 * Il ne le sait pas plus que le slug : même limite de l'App Router, même remède.
 * Le second segment du chemin est donc recopié dans un second en-tête, et
 * seulement quand il vaut `admin`.
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

/**
 * Le segment qui ouvre le back-office d'un établissement — `/{slug}/admin/…`.
 *
 * Il se lit par `pathSegment` de `lib/tenant-slug.ts`, la même lecture que celle
 * du slug et au rang suivant : décodée, parce que Next apparie ses routes sur des
 * segments décodés — `/maison-lotus/%61dmin` sert donc bien le back-office, et un
 * segment qu'on n'aurait pas reconnu aurait rendu l'écran dans la langue du
 * navigateur au lieu de celle du salon — et enveloppée, parce qu'un échappement
 * tronqué lève `URIError` : il ne désigne aucun espace connu, et ne doit pas
 * faire tomber le middleware de **toutes** les pages.
 */
const ADMIN_SEGMENT = 'admin';

/** Le rang du segment de l'espace de travail — `/{slug}/{espace}/…`. */
const WORKSPACE_RANK = 2;

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const tenantSlug = tenantSlugFromPathname(pathname);

  const headers = new Headers(request.headers);

  // Effacés plutôt que laissés tels quels : les deux en-têtes viennent du client
  // sur une requête forgée, et un `x-spa-tenant-slug` envoyé à la main ferait
  // lire la langue d'un établissement que la page ne sert pas.
  headers.delete(TENANT_SLUG_HEADER);
  headers.delete(TENANT_WORKSPACE_HEADER);

  if (tenantSlug === null || !SLUG_SHAPE.test(tenantSlug)) {
    return NextResponse.next({ request: { headers } });
  }

  headers.set(TENANT_SLUG_HEADER, tenantSlug);

  // L'espace n'est posé qu'avec le salon auquel il appartient : « le back-office
  // de personne » n'existe pas, et la résolution n'aurait alors rien à y lire.
  if (pathSegment(pathname, WORKSPACE_RANK) === ADMIN_SEGMENT) {
    headers.set(TENANT_WORKSPACE_HEADER, ADMIN_WORKSPACE);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)'],
};
