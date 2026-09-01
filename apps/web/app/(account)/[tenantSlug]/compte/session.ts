import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { ApiClientError, type ApiSession } from '@/lib/api-client';

import { accountPath, loginPath, refreshPath, sessionEndPath } from './paths';

/**
 * La session de l'espace client — **deux cookies `httpOnly`, et rien d'autre**
 * (#47, cinquième critère).
 *
 * ## Pourquoi le front réémet les jetons plutôt que de relayer ceux de l'API
 *
 * L'API pose son cookie de rafraîchissement sur **son** domaine et sur le chemin
 * `/api/v1/auth`. Dans cette architecture, le navigateur ne parle jamais à
 * l'API : il parle à Next, qui appelle l'API depuis le serveur. Ce cookie-là ne
 * peut donc pas atteindre le navigateur — il est lu dans la réponse
 * (`readApiSessionCookie`, `lib/api-client.ts`) et réémis ici, sur le domaine du
 * front.
 *
 * Le jeton d'**accès** subit le même sort, et c'est le point du ticket : l'API le
 * rend dans le corps parce qu'un client qui parlerait directement à elle devrait
 * le poser en en-tête. Ici, personne n'a à le poser côté navigateur — c'est le
 * serveur Next qui le fait. Il n'a donc aucune raison de traverser la frontière
 * du navigateur, et il ne la traverse pas : **il ne quitte jamais un cookie
 * `httpOnly`**, ne figure dans aucune réponse HTML, dans aucune prop de composant
 * client, et dans aucun `localStorage`. Une XSS sur ce front ne peut ni le lire
 * ni l'exfiltrer.
 *
 * ## Les attributs, et ce que chacun ferme
 *
 * | Attribut | Ce qu'il ferme |
 * |---|---|
 * | `httpOnly` | la lecture par `document.cookie`, donc l'exfiltration par XSS |
 * | `sameSite: 'lax'` | le CSRF : un site tiers ne peut pas déclencher d'écriture au nom de la visiteuse. `'strict'` casserait le retour depuis un lien d'e-mail de confirmation |
 * | `secure` hors développement | l'envoi en clair |
 * | `path` borné à l'espace client **de cet établissement** | deux choses : le cookie ne part pas sur les pages publiques, qui n'en ont aucun usage ; et une session ouverte chez un salon n'écrase pas celle ouverte chez un autre — les jetons de l'API sont eux-mêmes bornés à un établissement |
 *
 * ## La durée de vie du cookie d'accès **est** celle du jeton
 *
 * `maxAge` vaut l'`expiresIn` annoncé par l'API, moins une marge. Le navigateur
 * calcule l'échéance à partir de l'instant de réception, jamais de son horloge
 * absolue : il n'y a donc pas de dérive à corriger, et « le cookie a disparu »
 * devient exactement « le jeton a expiré ». C'est ce qui permet aux pages de
 * décider sans jamais interroger l'API pour rien — et sans boucle de
 * renouvellement possible.
 */

/** Le jeton d'accès. Sa durée de vie est celle du jeton lui-même. */
export const ACCESS_COOKIE = 'spa_account_access';

/** Le jeton de rafraîchissement, réémis depuis celui de l'API. */
export const REFRESH_COOKIE = 'spa_account_refresh';

/**
 * Marge retirée à la durée de vie du cookie d'accès.
 *
 * Trente secondes : le temps qu'une page mette à s'afficher et à appeler l'API
 * avec le jeton qu'elle vient de lire. Sans elle, un cookie encore présent à la
 * lecture pourrait porter un jeton déjà expiré à l'arrivée de la requête.
 */
const ACCESS_COOKIE_SAFETY_MARGIN_SECONDS = 30;

/** Repli quand l'API n'annonce pas la durée de vie de son cookie — sept jours. */
const DEFAULT_REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
}

/**
 * Les deux cookies à poser après une connexion, une inscription ou un
 * renouvellement.
 *
 * Rendus plutôt que posés : une action serveur les pose sur le magasin de
 * `cookies()`, une route de renouvellement les pose sur sa `NextResponse`. Les
 * deux chemins passent donc par les mêmes valeurs, ce qui évite qu'un attribut
 * diverge entre eux — un `path` différent d'un chemin à l'autre produirait deux
 * cookies homonymes que le navigateur enverrait tous les deux.
 */
export function sessionCookies(opened: ApiSession): readonly SessionCookie[] {
  const access: SessionCookie = {
    name: ACCESS_COOKIE,
    value: opened.session.accessToken,
    maxAge: Math.max(opened.session.expiresIn - ACCESS_COOKIE_SAFETY_MARGIN_SECONDS, 1),
  };

  if (opened.refreshToken === null) {
    return [access];
  }

  return [
    access,
    {
      name: REFRESH_COOKIE,
      value: opened.refreshToken,
      maxAge: opened.refreshTokenMaxAge ?? DEFAULT_REFRESH_MAX_AGE_SECONDS,
    },
  ];
}

/** Les attributs que les deux magasins de cookies acceptent. */
interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: string;
  readonly maxAge: number;
}

/**
 * Le minimum d'un magasin de cookies inscriptible.
 *
 * Déclaré structurellement plutôt qu'importé de `next/dist/...` : le type
 * `ResponseCookies` de Next vit sous un chemin interne que rien ne garantit
 * d'une version à l'autre. Le magasin rendu par `cookies()` et celui d'une
 * `NextResponse` satisfont tous deux cette forme, ce qui est exactement ce dont
 * ce fichier a besoin.
 */
interface WritableCookies {
  set(name: string, value: string, options: SessionCookieOptions): unknown;
}

/** Les attributs communs aux deux cookies — écrits une fois, lus partout. */
export function sessionCookieOptions(tenantSlug: string, maxAge: number): SessionCookieOptions {
  return {
    httpOnly: true,
    // Relâché hors production, sans quoi ni `localhost` en HTTP ni la recette ne
    // verraient jamais le cookie revenir. Même arbitrage que `refresh-cookie.ts`
    // côté API.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: accountPath(tenantSlug),
    maxAge,
  };
}

/** Pose la session dans le magasin de cookies — depuis une action serveur. */
export async function writeSessionCookies(
  tenantSlug: string,
  opened: ApiSession,
): Promise<void> {
  const store = await cookies();

  for (const cookie of sessionCookies(opened)) {
    store.set(cookie.name, cookie.value, sessionCookieOptions(tenantSlug, cookie.maxAge));
  }
}

/** Pose la session sur une réponse — depuis une route de renouvellement. */
export function attachSessionCookies(
  target: WritableCookies,
  tenantSlug: string,
  opened: ApiSession,
): void {
  for (const cookie of sessionCookies(opened)) {
    target.set(cookie.name, cookie.value, sessionCookieOptions(tenantSlug, cookie.maxAge));
  }
}

/**
 * Efface les deux cookies.
 *
 * Le `path` est reconstruit plutôt que deviné : un cookie posé sur
 * `/{slug}/compte` et effacé sur `/` survit, et la visiteuse resterait connectée
 * après avoir cliqué sur « se déconnecter ».
 */
export function clearSessionCookies(target: WritableCookies, tenantSlug: string): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    target.set(name, '', sessionCookieOptions(tenantSlug, 0));
  }
}

/** Le jeton d'accès courant, ou `null` s'il a expiré — voir l'en-tête. */
export async function readAccessToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ACCESS_COOKIE)?.value;
  return value === undefined || value === '' ? null : value;
}

/** Le jeton de rafraîchissement courant, ou `null`. */
export async function readRefreshToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(REFRESH_COOKIE)?.value;
  return value === undefined || value === '' ? null : value;
}

/**
 * Lit une donnée de compte, ou redirige — la garde de session des pages.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **le cookie d'accès est là** — on lit. C'est le cas courant ;
 * 2. **il a expiré, le cookie de rafraîchissement est là** — on part vers la
 *    route de renouvellement, qui pose une session neuve et renvoie ici. Elle ne
 *    peut pas renvoyer ici deux fois de suite : au retour, le cookie d'accès
 *    existe forcément, sans quoi c'est le cas 3 ;
 * 3. **les deux ont disparu** — écran de connexion.
 *
 * Un 401 malgré un cookie d'accès présent est le quatrième cas, et il est
 * **anormal** : la session a été révoquée en base — changement de rôle, réemploi
 * de jeton détecté — ou l'API a changé de secret. On ne tente alors pas de
 * renouveler, ce qui échouerait pour la même raison : on ferme la session et on
 * renvoie à la connexion, en le disant.
 */
export async function readAccountData<T>(
  tenantSlug: string,
  currentPath: string,
  read: (accessToken: string) => Promise<T>,
): Promise<T> {
  const accessToken = await readAccessToken();

  if (accessToken === null) {
    const refreshToken = await readRefreshToken();
    redirect(
      refreshToken === null ? loginPath(tenantSlug) : refreshPath(tenantSlug, currentPath),
    );
  }

  try {
    return await read(accessToken);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) {
      redirect(sessionEndPath(tenantSlug));
    }
    throw error;
  }
}
