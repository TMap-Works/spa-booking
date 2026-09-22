import { ApiClientError, openAppointmentFeed } from '@/lib/api-client';

/**
 * Le relais du flux temps réel des rendez-vous — la moitié serveur de
 * `components/live/appointment-feed.tsx`.
 *
 * ## Pourquoi le navigateur ne parle pas à l'API directement
 *
 * Le jeton d'accès vit dans un cookie `httpOnly` posé sur le chemin du front
 * (web-frontend §2) : le navigateur ne peut ni le lire, ni l'envoyer à l'origine
 * de l'API, et `EventSource` ne sait de toute façon pas poser d'en-tête
 * `Authorization`. Une route du front lit donc le cookie **côté serveur** —
 * en le renouvelant au passage s'il a expiré, comme le font les actions —,
 * ouvre le flux de l'API avec le jeton, et en relaie le corps octet pour octet.
 *
 * Elle ne lit pas ce qu'elle relaie : le contrat est celui de l'API
 * (`packages/shared/src/schemas/appointment-feed.ts`), et le composant qui le
 * reçoit le valide lui-même.
 *
 * ## Ce que disent ses refus
 *
 * Un corps vide et un statut, rien d'autre — `EventSource` n'en lit pas plus.
 * **401** quand la session a expiré ou a été refusée : le composant cesse alors
 * de se reconnecter en boucle et attend que l'écran renouvelle la session.
 * **503** quand l'API est injoignable : le composant réessaie plus tard.
 */

/**
 * `no-transform` n'est pas décoratif : la compression HTTP de Next tamponne ce
 * qu'elle compresse, et un flux tamponné n'arrive qu'à la fermeture — dix
 * minutes plus tard. `x-accel-buffering` dit la même chose à un proxy nginx.
 */
export const APPOINTMENT_FEED_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/**
 * Relaie le flux de l'API pour ce jeton — ou dit pourquoi il ne le peut pas.
 *
 * `accessToken` vaut `null` quand la session n'a pas pu être lue ni renouvelée.
 */
export async function relayAppointmentFeed(
  accessToken: string | null,
  signal: AbortSignal,
): Promise<Response> {
  if (accessToken === null) {
    return new Response(null, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await openAppointmentFeed(accessToken, signal);
  } catch (error) {
    const refused =
      error instanceof ApiClientError && (error.status === 401 || error.status === 403);

    return new Response(null, { status: refused ? 401 : 503 });
  }

  if (upstream.body === null) {
    return new Response(null, { status: 503 });
  }

  return new Response(upstream.body, { status: 200, headers: APPOINTMENT_FEED_HEADERS });
}
