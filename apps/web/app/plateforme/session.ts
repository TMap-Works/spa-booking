import type { PlatformSession } from '@spa/shared';
import { cookies } from 'next/headers';

import { PLATFORM_CONSOLE_PATH } from './paths';

/**
 * La session de console — un cookie `httpOnly` pour le jeton, un second pour le
 * nom affiché.
 *
 * ## Aucun renouvellement
 *
 * Le jeton d'opérateur vit trente minutes et l'API n'émet aucun jeton de
 * rafraîchissement (ADR 0012 §3) : une chaîne de renouvellement aurait rendu la
 * MFA franchissable une fois pour toutes. Le cookie meurt donc avec le jeton, et
 * la console renvoie à la connexion — code TOTP compris.
 *
 * ## Borné à `/plateforme`
 *
 * Le cookie ne part ni vers les pages publiques d'un salon ni vers son
 * back-office : un jeton de console n'a rien à y faire, et l'API le refuserait
 * de toute façon.
 */

export const PLATFORM_ACCESS_COOKIE = 'spa_platform_access';

/** « Prénom N. » — ce que le rail affiche. Aucun secret, mais `httpOnly` quand même. */
export const PLATFORM_OPERATOR_COOKIE = 'spa_platform_operator';

/**
 * Le défi du premier temps de la connexion (#1442) — `httpOnly`, comme la
 * session : il n'est relu que par l'action serveur du second temps, et le
 * JavaScript du navigateur n'a pas à le connaître.
 */
export const PLATFORM_CHALLENGE_COOKIE = 'spa_platform_challenge';

/** Le temps qu'une page s'affiche et appelle l'API avec le jeton qu'elle vient de lire. */
const ACCESS_COOKIE_SAFETY_MARGIN_SECONDS = 30;

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: PLATFORM_CONSOLE_PATH,
    maxAge,
  } as const;
}

export async function writePlatformSession(session: PlatformSession): Promise<void> {
  const store = await cookies();
  const maxAge = Math.max(session.expiresIn - ACCESS_COOKIE_SAFETY_MARGIN_SECONDS, 1);
  const name = `${session.operator.firstName} ${session.operator.lastName.slice(0, 1)}.`;

  store.set(PLATFORM_ACCESS_COOKIE, session.accessToken, cookieOptions(maxAge));
  store.set(PLATFORM_OPERATOR_COOKIE, encodeURIComponent(name), cookieOptions(maxAge));
}

export async function clearPlatformSession(): Promise<void> {
  const store = await cookies();

  for (const name of [PLATFORM_ACCESS_COOKIE, PLATFORM_OPERATOR_COOKIE]) {
    store.set(name, '', cookieOptions(0));
  }
}

/**
 * Ce que le cookie du défi retranche à sa durée : le délai entre la signature
 * du défi par l'API et la pose du cookie, plus la seconde que `exp` arrondit.
 */
const CHALLENGE_COOKIE_SAFETY_MARGIN_SECONDS = 5;

/**
 * Garde le défi du premier temps, un peu moins longtemps que l'API ne le tient.
 *
 * Le cookie doit mourir **avant** le défi, jamais après : un défi expiré côté
 * navigateur renvoie au mot de passe avec le motif dit, alors qu'un cookie qui
 * survivrait au défi ferait refuser par l'API un code juste, dit à l'écran
 * comme un code faux.
 */
export async function writePlatformChallenge(token: string, expiresIn: number): Promise<void> {
  const maxAge = Math.max(expiresIn - CHALLENGE_COOKIE_SAFETY_MARGIN_SECONDS, 1);

  (await cookies()).set(PLATFORM_CHALLENGE_COOKIE, token, cookieOptions(maxAge));
}

/** Le défi en cours, ou `null` s'il n'y en a pas — ou plus. */
export async function readPlatformChallenge(): Promise<string | null> {
  const value = (await cookies()).get(PLATFORM_CHALLENGE_COOKIE)?.value;

  return value === undefined || value === '' ? null : value;
}

export async function clearPlatformChallenge(): Promise<void> {
  (await cookies()).set(PLATFORM_CHALLENGE_COOKIE, '', cookieOptions(0));
}

/** Le jeton de console, ou `null` s'il a expiré. */
export async function readPlatformAccessToken(): Promise<string | null> {
  const value = (await cookies()).get(PLATFORM_ACCESS_COOKIE)?.value;

  return value === undefined || value === '' ? null : value;
}

export async function readPlatformOperatorName(): Promise<string | null> {
  const value = (await cookies()).get(PLATFORM_OPERATOR_COOKIE)?.value;

  if (value === undefined || value === '') {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
