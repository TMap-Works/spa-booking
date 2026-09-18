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
