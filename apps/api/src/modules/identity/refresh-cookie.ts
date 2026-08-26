import type { CookieOptions, Request, Response } from 'express';

/**
 * Le cookie qui porte le jeton de rafraîchissement.
 *
 * ## Pourquoi un cookie et non le corps de la réponse
 *
 * Un jeton rendu dans le corps doit être rangé quelque part par le front, et ce
 * quelque part est `localStorage` neuf fois sur dix — lisible par le moindre
 * script tiers, donc par la moindre faille XSS. `httpOnly` retire le jeton de
 * portée de JavaScript : une XSS peut encore agir *au nom* de l'utilisateur tant
 * que la page est ouverte, mais elle ne peut plus **exfiltrer** la session pour
 * la rejouer ailleurs et plus tard.
 *
 * Le jeton d'**accès**, lui, part bien dans le corps : il est court, non
 * révocable, et le front doit pouvoir le poser en en-tête `Authorization`.
 *
 * ## Les trois attributs
 *
 * - `httpOnly` — hors de portée de `document.cookie` ;
 * - `secure` — jamais envoyé en clair. Relâché sur les seuls environnements
 *   **non déployés** (`development`, `test`), sans quoi ni `localhost` en HTTP
 *   ni la suite d'intégration ne verraient jamais le cookie revenir. `staging`
 *   sert en HTTPS derrière l'ALB comme la production : l'y relâcher exposerait
 *   la session en clair au premier appel `http://` que le navigateur émettrait ;
 * - `sameSite: 'lax'` — le navigateur ne joint pas le cookie à une requête
 *   inter-site déclenchée par un tiers, ce qui ferme le CSRF sur `/auth/refresh`.
 *   `'strict'` casserait le retour depuis un lien externe (un e-mail de
 *   confirmation, par exemple) ; `'none'` rouvrirait le CSRF.
 *
 * `path` borne le cookie aux routes d'authentification : il n'est pas joint aux
 * autres appels de l'API, donc il ne traverse pas la surface où il n'a rien à
 * faire.
 */

export const REFRESH_COOKIE_NAME = 'spa_refresh_token';

/**
 * Chemin d'émission du cookie.
 *
 * Il doit couvrir `/auth/refresh` **et** `/auth/logout` — la déconnexion a besoin
 * du jeton pour savoir quelle session éteindre. Le préfixe global et le
 * versionnement sont posés par `configureApp`, d'où la forme complète.
 */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

export function refreshCookieOptions(options: {
  /** `true` dès que la requête voyage en HTTPS — soit tout environnement déployé. */
  secure: boolean;
  maxAgeSeconds: number;
}): CookieOptions {
  return {
    httpOnly: true,
    secure: options.secure,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: options.maxAgeSeconds * 1000,
  };
}

export function setRefreshCookie(
  response: Response,
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): void {
  response.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(options));
}

/**
 * Efface le cookie.
 *
 * `clearCookie` n'agit que si `path` et `sameSite` correspondent à ceux de
 * l'émission — un cookie posé sur `/api/v1/auth` et effacé sur `/` survit. C'est
 * pour cela que les options sont reconstruites ici plutôt que devinées.
 */
export function clearRefreshCookie(response: Response, options: { secure: boolean }): void {
  const { maxAge: _maxAge, ...rest } = refreshCookieOptions({
    secure: options.secure,
    maxAgeSeconds: 0,
  });
  response.clearCookie(REFRESH_COOKIE_NAME, rest);
}

/**
 * Lit le cookie depuis l'en-tête brut.
 *
 * `cookie-parser` n'est délibérément pas installé : une dépendance de plus dans
 * l'image, et un `package-lock.json` de plus à faire diverger, pour une lecture
 * qui tient en dix lignes. `request.cookies` n'existe donc pas — on lit
 * `headers.cookie`.
 *
 * Le découpage est fait à la main plutôt que par une expression rationnelle sur
 * le nom : `spa_refresh_token=` apparaîtrait aussi dans la valeur d'un autre
 * cookie, et le motif y accrocherait.
 */
export function readRefreshCookie(request: Request): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string' || header === '') {
    return null;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    // Un cookie vide (`spa_refresh_token=`) est une absence, pas un jeton : le
    // navigateur en produit un en effaçant le cookie.
    if (value === '') {
      return null;
    }
    try {
      return decodeURIComponent(value);
    } catch {
      // `decodeURIComponent` **lève** sur un échappement mal formé
      // (`spa_refresh_token=%`). Cette fonction est appelée par le contrôleur,
      // hors de tout `try` : l'`URIError` remonterait jusqu'au filtre et
      // répondrait 500 — sur `/auth/logout`, dont le contrat est de ne jamais
      // échouer, et sur `/auth/refresh`, dont toutes les issues doivent se
      // ressembler. Une valeur qui ne se décode pas ne peut être aucun des
      // jetons que nous émettons : c'est une absence.
      return null;
    }
  }

  return null;
}
