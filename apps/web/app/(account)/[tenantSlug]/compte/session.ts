import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  PRESENCE_COOKIE,
  presenceCookieOptions,
  presenceCookieValue,
  type PresenceSource,
} from '@/lib/account-presence';
import { ApiClientError, type ApiSession } from '@/lib/api-client';
import {
  accessTokenForAction,
  renewalReturnTo,
  type ActionAccess,
} from '@/lib/session-refresh';

import { clearAccountLocaleCookie } from './account-locale';
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

  // Un renouvellement qui a perdu une course contre un autre ne rend pas de jeton
  // de rafraîchissement (#856) : le gagnant pose le cookie neuf, et le réécrire
  // ici — fût-ce avec l'ancienne valeur — pourrait l'écraser.
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

/**
 * Pose le cookie de présence (#1045) : ce que le salon peut afficher — et, depuis
 * #1086, préremplir — hors de l'espace client, où les jetons ne voyagent pas.
 * Voir `lib/account-presence.ts`, qui porte l'arbitrage sur ce qu'il emporte et
 * ce qu'il continue de laisser dehors. Il vit aussi longtemps que la session
 * qu'il annonce.
 *
 * `PresenceSource` et non `AccountPresence` : c'est le sens **écriture** du
 * cookie, celui que `SessionUser` satisfait tel quel — l'API y émet `phone` à
 * `null`, que `presenceCookieValue` ramène à la chaîne vide du cookie.
 */
export function attachPresenceCookie(
  target: WritableCookies,
  tenantSlug: string,
  user: PresenceSource,
  maxAge: number = DEFAULT_REFRESH_MAX_AGE_SECONDS,
): void {
  target.set(PRESENCE_COOKIE, presenceCookieValue(user), presenceCookieOptions(tenantSlug, maxAge));
}

/** Pose la session dans le magasin de cookies — depuis une action serveur. */
export async function writeSessionCookies(
  tenantSlug: string,
  opened: ApiSession,
): Promise<void> {
  attachSessionCookies(await cookies(), tenantSlug, opened);
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
  attachPresenceCookie(
    target,
    tenantSlug,
    opened.session.user,
    opened.refreshTokenMaxAge ?? DEFAULT_REFRESH_MAX_AGE_SECONDS,
  );
}

/**
 * Efface les deux cookies.
 *
 * Le `path` est reconstruit plutôt que deviné : un cookie posé sur
 * `/{slug}/compte` et effacé sur `/` survit, et la visiteuse resterait connectée
 * après avoir cliqué sur « se déconnecter ».
 *
 * Le miroir de la langue du compte part avec (#847) : il n'annonce qu'une
 * préférence, mais il l'annonce pour **quelqu'un**. Le laisser derrière ferait
 * lire à la visiteuse suivante de ce navigateur la langue de la précédente,
 * sans qu'aucune session ne subsiste pour l'expliquer. Le choix explicite du
 * sélecteur, lui, n'est pas touché : il appartient au navigateur, pas à la
 * session (`account-locale.ts`).
 */
export function clearSessionCookies(target: WritableCookies, tenantSlug: string): void {
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
    target.set(name, '', sessionCookieOptions(tenantSlug, 0));
  }
  target.set(PRESENCE_COOKIE, '', presenceCookieOptions(tenantSlug, 0));
  clearAccountLocaleCookie(target);
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
 * Le jeton d'accès d'une action serveur de l'espace client — renouvelé sur
 * place quand le cookie a expiré (#856). Voir `accessTokenForAction`.
 */
export function accountActionAccess(tenantSlug: string): Promise<ActionAccess> {
  return accessTokenForAction({
    readAccessToken,
    readRefreshToken,
    write: (renewed) => writeSessionCookies(tenantSlug, renewed),
  });
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
 * Un 401 malgré un cookie d'accès présent est le quatrième cas, et il passe
 * désormais par le renouvellement (#861) : voir `unauthorizedPath`.
 */
export async function readAccountData<T>(
  tenantSlug: string,
  currentPath: string,
  read: (accessToken: string) => Promise<T>,
  /**
   * `true` si l'URL courante revient déjà d'un renouvellement déclenché par un
   * 401 — ce que la page lit de son `?session=renouvelee` (`isRenewalReturn`).
   *
   * **Obligatoire**, et pour la raison qui rend `returnTo` obligatoire côté
   * back-office (#458) : facultatif, il n'aurait été passé par aucun écran. Un
   * écran qui l'omet retente un renouvellement à chaque rendu, et une API qui
   * refuse jusqu'aux jetons qu'elle vient d'émettre enchaîne alors les
   * redirections entre l'écran et la route de renouvellement jusqu'à la page
   * d'erreur du navigateur — exactement ce que le marqueur existe pour empêcher
   * (voir `RENEWAL_PARAM`). Le type est la seule forme de rappel qu'un écran neuf
   * ne puisse pas ignorer.
   */
  renewalAttempted: boolean,
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
      redirect(await unauthorizedPath(tenantSlug, currentPath, renewalAttempted));
    }
    throw error;
  }
}

/**
 * Où mène un **401 reçu alors que le cookie d'accès est là** (#861).
 *
 * L'écran partait jusqu'ici vers `session/fin`, qui **révoque la session en
 * base** avant de mener à la connexion. C'était trop, et irréversible : trois
 * causes produisent ce 401 sans que la session soit morte — le secret de l'API
 * changé au déploiement, son horloge dérivée, un rendu plus long que la marge de
 * trente secondes du cookie —, et toutes trois se réparent par un
 * renouvellement. La visiteuse perdait sa session pour un jeton de quinze
 * minutes.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **le renouvellement a déjà été tenté** — la session neuve a été refusée
 *    elle aussi. Celle-là est bien morte : `session/fin`, qui la révoque et le
 *    dit ;
 * 2. **il n'y a plus rien à renouveler** — pas de cookie de rafraîchissement.
 *    `session/fin` encore : il efface le cookie d'accès resté seul, ce que la
 *    route de renouvellement ne ferait pas ;
 * 3. **il reste une chance** — route de renouvellement, avec le chemin marqué.
 *    Elle pose une session neuve et rend la main à l'écran, ou refuse et mène
 *    elle-même à la connexion : c'est elle, et elle seule, qui efface les
 *    cookies (`lib/session-refresh.ts`).
 */
async function unauthorizedPath(
  tenantSlug: string,
  currentPath: string,
  renewalAttempted: boolean,
): Promise<string> {
  if (renewalAttempted) {
    return sessionEndPath(tenantSlug);
  }

  const refreshToken = await readRefreshToken();

  return refreshToken === null
    ? sessionEndPath(tenantSlug)
    : refreshPath(tenantSlug, renewalReturnTo(currentPath));
}
