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
 * ## Portée volontairement réduite
 *
 * Ce module ne porte que ce dont l'écran de réglages (#343) a besoin : ouvrir
 * une session, la lire, la fermer. Il n'y a ni rotation du jeton de
 * rafraîchissement, ni redirection de renouvellement — l'espace client les a
 * (`(account)/…/session.ts`), et les reprendre ici avant que le shell du
 * back-office n'existe (#48) reviendrait à écrire deux fois la même mécanique
 * pour la déplacer ensuite. Un jeton d'accès expiré renvoie donc à la
 * connexion : c'est le comportement le plus simple qui reste correct.
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

/** Pose la session dans le magasin de cookies — depuis une action serveur. */
export async function writeAdminSession(tenantSlug: string, opened: ApiSession): Promise<void> {
  const store = await cookies();

  store.set(
    ADMIN_ACCESS_COOKIE,
    opened.session.accessToken,
    adminCookieOptions(
      tenantSlug,
      Math.max(opened.session.expiresIn - ACCESS_COOKIE_SAFETY_MARGIN_SECONDS, 1),
    ),
  );

  if (opened.refreshToken !== null) {
    store.set(
      ADMIN_REFRESH_COOKIE,
      opened.refreshToken,
      adminCookieOptions(tenantSlug, opened.refreshTokenMaxAge ?? DEFAULT_REFRESH_MAX_AGE_SECONDS),
    );
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
