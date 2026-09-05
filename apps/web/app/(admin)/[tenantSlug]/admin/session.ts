import { cookies } from 'next/headers';

import type { ApiSession } from '@/lib/api-client';

import { adminPath } from './paths';

/**
 * La session du back-office — **deux cookies `httpOnly`, et rien d'autre**.
 *
 * ## Pourquoi des cookies distincts de ceux de l'espace client
 *
 * Ce ne sont pas les mêmes sessions : une cliente et une gérante n'ont ni les
 * mêmes rôles ni les mêmes écrans, et il est parfaitement normal qu'une même
 * personne soit connectée aux deux — la gérante d'un salon peut y être cliente.
 * Des cookies homonymes se seraient écrasés l'un l'autre au premier
 * chevauchement de chemin, et la dernière connexion aurait fermé l'autre sans
 * qu'aucune erreur ne le dise.
 *
 * Le `path` est borné au back-office **de cet établissement**, pour deux
 * raisons : le cookie ne part pas sur les pages publiques, qui n'en ont aucun
 * usage, et une session ouverte chez un salon n'écrase pas celle ouverte chez un
 * autre — les jetons de l'API sont eux-mêmes bornés à un établissement.
 *
 * ## Ce qui reste vrai de l'espace client
 *
 * Le jeton d'accès **ne quitte jamais un cookie `httpOnly`** : il ne figure dans
 * aucune réponse HTML, dans aucune prop de composant client, dans aucun
 * `localStorage`. Une XSS sur ce front ne peut ni le lire ni l'exfiltrer
 * (web-frontend §2).
 *
 * ## Le renouvellement, arrivé avec le shell (#48)
 *
 * Ce module portait d'abord le strict nécessaire de l'écran de réglages
 * (#343) : ouvrir une session, la lire, la fermer. Un jeton d'accès expiré
 * renvoyait à la connexion — le comportement le plus simple qui reste correct,
 * et qui devient intenable sur l'écran que le comptoir garde ouvert huit heures
 * d'affilée : la durée de vie d'un jeton d'accès se compte en minutes, et
 * retaper son mot de passe vingt fois par jour n'est pas une session gérée.
 *
 * Les cookies sont donc **rendus** (`adminSessionCookies`) plutôt que posés,
 * pour que deux chemins les écrivent aux mêmes attributs : une action serveur
 * sur le magasin de `cookies()`, la route de renouvellement sur sa
 * `NextResponse`. Un `path` qui divergerait de l'un à l'autre produirait deux
 * cookies homonymes que le navigateur enverrait tous les deux — et la
 * déconnexion n'en effacerait qu'un.
 *
 * La mécanique est celle de l'espace client (`(account)/…/session.ts`), écrite
 * une seconde fois plutôt que partagée : les deux surfaces ne portent ni les
 * mêmes noms de cookie ni le même `path`, et le facteur commun se réduirait à
 * la moitié de ce fichier. La fusion des deux est une issue de suivi, pas une
 * condition de ce ticket.
 */

/** Le jeton d'accès du back-office. Sa durée de vie est celle du jeton. */
export const ADMIN_ACCESS_COOKIE = 'spa_admin_access';

/** Le jeton de rafraîchissement, réémis depuis celui de l'API. */
export const ADMIN_REFRESH_COOKIE = 'spa_admin_refresh';

/**
 * Marge retirée à la durée de vie du cookie d'accès — trente secondes, le temps
 * qu'une page s'affiche et appelle l'API avec le jeton qu'elle vient de lire.
 */
const ACCESS_COOKIE_SAFETY_MARGIN_SECONDS = 30;

/** Repli quand l'API n'annonce pas la durée de vie de son cookie — sept jours. */
const DEFAULT_REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

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
 * d'une version à l'autre.
 */
interface WritableCookies {
  set(name: string, value: string, options: SessionCookieOptions): unknown;
}

/** Les attributs communs aux deux cookies — écrits une fois, lus partout. */
function adminCookieOptions(tenantSlug: string, maxAge: number): SessionCookieOptions {
  return {
    httpOnly: true,
    // Relâché hors production, sans quoi ni `localhost` en HTTP ni la recette ne
    // verraient jamais le cookie revenir. Même arbitrage que l'espace client.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: adminPath(tenantSlug),
    maxAge,
  };
}

/** Un cookie de session, avant qu'un magasin ne le reçoive. */
interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly maxAge: number;
}

/**
 * Les cookies à poser après une connexion ou un renouvellement.
 *
 * Rendus plutôt que posés : c'est ce qui permet à l'action serveur et à la route
 * de renouvellement d'écrire exactement les mêmes valeurs, sur deux magasins
 * différents.
 *
 * L'API n'émet pas toujours un jeton de rafraîchissement — le cookie n'est alors
 * pas réécrit, et **surtout pas effacé** : celui de la connexion précédente
 * reste valide, et l'écraser par une valeur vide fermerait la session au premier
 * renouvellement.
 */
export function adminSessionCookies(opened: ApiSession): readonly SessionCookie[] {
  const access: SessionCookie = {
    name: ADMIN_ACCESS_COOKIE,
    value: opened.session.accessToken,
    maxAge: Math.max(opened.session.expiresIn - ACCESS_COOKIE_SAFETY_MARGIN_SECONDS, 1),
  };

  if (opened.refreshToken === null) {
    return [access];
  }

  return [
    access,
    {
      name: ADMIN_REFRESH_COOKIE,
      value: opened.refreshToken,
      maxAge: opened.refreshTokenMaxAge ?? DEFAULT_REFRESH_MAX_AGE_SECONDS,
    },
  ];
}

/** Pose la session dans le magasin de cookies — depuis une action serveur. */
export async function writeAdminSession(tenantSlug: string, opened: ApiSession): Promise<void> {
  attachAdminSession(await cookies(), tenantSlug, opened);
}

/** Pose la session sur une réponse — depuis la route de renouvellement. */
export function attachAdminSession(
  target: WritableCookies,
  tenantSlug: string,
  opened: ApiSession,
): void {
  for (const cookie of adminSessionCookies(opened)) {
    target.set(cookie.name, cookie.value, adminCookieOptions(tenantSlug, cookie.maxAge));
  }
}

/**
 * Efface les deux cookies.
 *
 * Le `path` est reconstruit plutôt que deviné : un cookie posé sur
 * `/{slug}/admin` et effacé sur `/` survit, et la personne resterait connectée
 * après avoir cliqué sur « se déconnecter ».
 */
export function clearAdminSession(target: WritableCookies, tenantSlug: string): void {
  for (const name of [ADMIN_ACCESS_COOKIE, ADMIN_REFRESH_COOKIE]) {
    target.set(name, '', adminCookieOptions(tenantSlug, 0));
  }
}

/** Le jeton d'accès courant, ou `null` s'il a expiré. */
export async function readAdminAccessToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ADMIN_ACCESS_COOKIE)?.value;

  return value === undefined || value === '' ? null : value;
}

/** Le jeton de rafraîchissement courant, ou `null`. */
export async function readAdminRefreshToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(ADMIN_REFRESH_COOKIE)?.value;

  return value === undefined || value === '' ? null : value;
}
