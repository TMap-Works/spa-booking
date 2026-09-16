import { ApiClientError, refreshSession, type ApiSession } from '@/lib/api-client';

/**
 * Le renouvellement de session côté serveur Next, commun au back-office et à
 * l'espace client (#856).
 *
 * Les deux surfaces gardent leurs cookies, leurs chemins et leurs refus : ce
 * module ne porte que ce qu'elles décidaient chacune de leur côté, et qui ne
 * doit pas diverger — **quand** un renouvellement raté ferme la session, et
 * **comment** une action serveur se renouvelle avant d'appeler l'API.
 */

/**
 * `true` si l'API a refusé le jeton de rafraîchissement — la seule issue d'un
 * renouvellement qui ferme la session.
 *
 * Un 429 du limiteur de débit, un 503, une coupure réseau ne disent rien du
 * jeton : effacer les cookies sur cette foi-là déconnecterait pour de bon une
 * session valide. Le limiteur n'est pas hypothétique — il compte par adresse
 * IP, et tous les appels partent du serveur Next, donc d'une seule.
 *
 * Le perdant d'une course entre deux renouvellements n'est pas un refus non
 * plus : l'API lui rend un jeton d'accès, sans cookie de rafraîchissement
 * (voir `AuthService.refresh`), et son renouvellement aboutit.
 */
export function isRefreshRefused(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 401 || error.status === 403);
}

/** Ce qu'une surface expose de sa session à une action serveur. */
export interface ActionSessionStore {
  readAccessToken(): Promise<string | null>;
  readRefreshToken(): Promise<string | null>;
  /** Pose la session renouvelée — une action serveur a le droit d'écrire un cookie. */
  write(renewed: ApiSession): Promise<void>;
}

/** Le jeton d'une action, ou la raison pour laquelle elle n'en a pas. */
export type ActionAccess =
  | { readonly kind: 'ready'; readonly accessToken: string }
  /** Plus rien à renouveler : l'écran part vers la route de renouvellement, qui tranche. */
  | { readonly kind: 'expired' }
  /** Le renouvellement a échoué sans rien dire du jeton — l'écran affiche l'erreur. */
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Le jeton d'accès d'une action serveur — **renouvelé sur place** quand le
 * cookie a expiré.
 *
 * ## Pourquoi l'action se renouvelle elle-même
 *
 * Le cookie d'accès vit un quart d'heure, un écran de comptoir reste ouvert une
 * journée. Sans renouvellement ici, l'enregistrement tenté après la pause
 * revenait en `UNAUTHORIZED`, l'écran partait se renouveler et revenait vide :
 * la saisie était perdue alors que la session, elle, était parfaitement
 * valide. Une action serveur a le droit de poser un cookie — un Server
 * Component ne l'a pas, d'où la route de renouvellement des pages —, rien ne
 * l'oblige donc à sortir pour cela.
 *
 * ## Ce qui reste à l'écran
 *
 * - `expired` : pas de cookie de rafraîchissement, ou l'API le refuse. L'action
 *   rend `UNAUTHORIZED`, et l'écran part vers la route de renouvellement, qui
 *   efface les cookies et mène à la connexion. Les cookies ne sont **pas**
 *   effacés ici : un seul endroit en décide, et c'est la route ;
 * - `failed` : limiteur, panne, coupure. L'écran affiche l'erreur et la saisie
 *   reste en place — un nouvel essai pourra aboutir.
 */
export async function accessTokenForAction(store: ActionSessionStore): Promise<ActionAccess> {
  const accessToken = await store.readAccessToken();

  if (accessToken !== null) {
    return { kind: 'ready', accessToken };
  }

  const refreshToken = await store.readRefreshToken();

  if (refreshToken === null) {
    return { kind: 'expired' };
  }

  try {
    const renewed = await refreshSession(refreshToken);
    await store.write(renewed);
    return { kind: 'ready', accessToken: renewed.session.accessToken };
  } catch (error) {
    return isRefreshRefused(error) ? { kind: 'expired' } : { kind: 'failed', error };
  }
}
