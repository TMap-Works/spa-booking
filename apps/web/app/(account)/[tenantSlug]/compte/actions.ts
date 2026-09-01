'use server';

/**
 * Les actions serveur de l'espace client — la seule voie par laquelle le
 * navigateur atteint l'API, et le seul endroit où les jetons existent.
 *
 * Même doctrine que les actions du tunnel (`(booking)/…/reservation/actions.ts`),
 * et deux règles propres à cette surface :
 *
 * - **aucune action ne rend un jeton.** Ce qu'elles rendent est ce qu'un écran
 *   affiche : un profil, une liste, un message. Les jetons entrent dans les
 *   cookies `httpOnly` de `session.ts` et n'en ressortent pas. C'est ce qui rend
 *   vrai le cinquième critère de #47 — la session ne transite ni par
 *   `localStorage` ni par le bundle du navigateur ;
 * - **la validation est refaite ici.** Rien ne garantit qu'un appel d'action
 *   vienne du formulaire ; l'API revalidera de son côté (web-frontend §4).
 */

import {
  ERROR_CODES,
  cancelAppointmentRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  rescheduleAppointmentRequestSchema,
  slugSchema,
  updateProfileRequestSchema,
  uuidSchema,
  type BookedAppointment,
  type SessionUser,
} from '@spa/shared';
import { cookies } from 'next/headers';

import {
  ApiClientError,
  cancelAppointment,
  loginToAccount,
  logoutSession,
  registerAccount,
  rescheduleAppointment,
  updateOwnProfile,
} from '@/lib/api-client';

import {
  clearSessionCookies,
  readAccessToken,
  readRefreshToken,
  writeSessionCookies,
} from './session';

export type ActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly code: string; readonly message: string };

function failure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof ApiClientError) {
    return { ok: false, code: error.code, message: error.message };
  }

  return {
    ok: false,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'Une erreur inattendue est survenue. Merci de réessayer.',
  };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
function invalid(message: string): { ok: false; code: string; message: string } {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

/** Session absente ou expirée — l'écran renvoie à la connexion. */
function unauthenticated(): { ok: false; code: string; message: string } {
  return {
    ok: false,
    code: ERROR_CODES.UNAUTHORIZED,
    message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  };
}

/**
 * Ouvre une session et la range dans les cookies.
 *
 * Rend le profil, **jamais les jetons** : c'est la frontière que tout le
 * dispositif protège, et elle se tient ici, dans la seule fonction qui les voit.
 */
export async function loginAction(
  tenantSlug: string,
  credentials: unknown,
): Promise<ActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = loginRequestSchema.safeParse(credentials);

  if (!slug.success || !parsed.success) {
    return invalid('Renseignez votre adresse e-mail et votre mot de passe.');
  }

  try {
    const opened = await loginToAccount(slug.data, parsed.data);
    await writeSessionCookies(slug.data, opened);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error);
  }
}

/** Inscrit une cliente et ouvre sa session dans la foulée. */
export async function registerAction(
  tenantSlug: string,
  body: unknown,
): Promise<ActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = registerRequestSchema.safeParse(body);

  if (!slug.success || !parsed.success) {
    return invalid('Les informations d’inscription sont incomplètes.');
  }

  try {
    const opened = await registerAccount(slug.data, parsed.data);
    await writeSessionCookies(slug.data, opened);
    return { ok: true, data: opened.session.user };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Ferme la session — **des deux côtés**.
 *
 * L'appel à l'API révoque le jeton de rafraîchissement en base ; effacer les
 * cookies sans lui laisserait une session « fermée » qu'un vol de cookie
 * antérieur pourrait rejouer sept jours durant. L'échec de cet appel n'empêche
 * pas d'effacer les cookies : le résultat visible pour la visiteuse est le même,
 * et lui refuser la déconnexion serait pire que de la lui accorder à moitié.
 */
export async function logoutAction(tenantSlug: string): Promise<ActionResult<null>> {
  const slug = slugSchema.safeParse(tenantSlug);

  if (!slug.success) {
    return invalid('Établissement inconnu.');
  }

  const refreshToken = await readRefreshToken();

  if (refreshToken !== null) {
    try {
      await logoutSession(refreshToken);
    } catch {
      // Volontairement avalé — voir l'en-tête.
    }
  }

  clearSessionCookies(await cookies(), slug.data);
  return { ok: true, data: null };
}

/** Met à jour ses propres coordonnées. */
export async function updateProfileAction(
  tenantSlug: string,
  changes: unknown,
): Promise<ActionResult<SessionUser>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const parsed = updateProfileRequestSchema.safeParse(changes);

  if (!slug.success || !parsed.success) {
    return invalid('Les coordonnées saisies sont invalides.');
  }

  const accessToken = await readAccessToken();
  if (accessToken === null) {
    return unauthenticated();
  }

  try {
    return { ok: true, data: await updateOwnProfile(accessToken, parsed.data) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Annule un de ses rendez-vous, depuis l'espace client.
 *
 * La route appelée est celle du tunnel public : ce qui l'autorise est la
 * connaissance de l'identifiant du rendez-vous, un UUID v4. Cette action ne
 * l'affaiblit pas — elle ne fait que transmettre un identifiant que l'écran vient
 * de lire dans un historique **authentifié**, donc borné à la cliente du jeton.
 * Une cliente ne peut pas y annuler le rendez-vous d'une autre pour la raison
 * qui vaut sur toute cette surface : elle n'en connaît pas l'identifiant.
 *
 * `cancelledBy` vaut `CLIENT`, fixé par la route et non par le corps.
 */
export async function cancelOwnAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  reason?: string,
): Promise<ActionResult<BookedAppointment>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);
  const body = cancelAppointmentRequestSchema.safeParse(
    reason === undefined || reason.trim() === '' ? {} : { reason },
  );

  if (!slug.success || !id.success || !body.success) {
    return invalid('La demande d’annulation est incomplète.');
  }

  // Non pour autoriser — la route ne l'exige pas — mais pour ne pas laisser un
  // écran déconnecté écrire dans l'agenda du salon : la session a expiré, la
  // bonne conduite est de se reconnecter puis de reprendre.
  if ((await readAccessToken()) === null) {
    return unauthenticated();
  }

  try {
    return { ok: true, data: await cancelAppointment(slug.data, id.data, body.data) };
  } catch (error) {
    return failure(error);
  }
}

/** Reporte un de ses rendez-vous — même régime que l'annulation ci-dessus. */
export async function rescheduleOwnAppointmentAction(
  tenantSlug: string,
  appointmentId: string,
  request: unknown,
): Promise<ActionResult<BookedAppointment>> {
  const slug = slugSchema.safeParse(tenantSlug);
  const id = uuidSchema.safeParse(appointmentId);
  const body = rescheduleAppointmentRequestSchema.safeParse(request);

  if (!slug.success || !id.success || !body.success) {
    return invalid('La demande de report est incomplète.');
  }

  if ((await readAccessToken()) === null) {
    return unauthenticated();
  }

  try {
    return { ok: true, data: await rescheduleAppointment(slug.data, id.data, body.data) };
  } catch (error) {
    return failure(error);
  }
}
