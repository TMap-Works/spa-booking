/**
 * Ce que rend une action serveur du back-office, et rien d'autre.
 *
 * ## Pourquoi ce module existe à côté de `actions.ts`
 *
 * `actions.ts` porte la directive `'use server'`, et un module ainsi marqué ne
 * peut exporter que des fonctions asynchrones : Next transforme chacun de ses
 * exports en point d'entrée appelable depuis le navigateur. Un type, une
 * constante ou une fonction synchrone n'y ont pas leur place — d'où ce fichier
 * ordinaire, importable des deux côtés de la frontière.
 *
 * ## Le contrat
 *
 * Une action rend **toujours** un résultat, jamais une exception : un rejet
 * traverserait la frontière serveur en perdant son type, et le composant
 * client n'aurait plus qu'un message générique à afficher. Le refus porte donc
 * un `code` — c'est lui que les écrans lisent — et un `message`, destiné à un
 * humain (web-frontend §2).
 *
 * ## Et `details`, depuis #1210
 *
 * Un même `code` couvre parfois plusieurs refus, que l'API distingue dans son
 * corps d'erreur : `INVALID_STATE_TRANSITION` vaut aussi bien pour un
 * rendez-vous déjà soldé que pour un rendez-vous qui n'a pas commencé, et seul
 * `details.notStarted` les sépare (#1137). Sans ce report, l'écran n'avait que
 * le message de l'API à réémettre, et ne pouvait pas conduire l'opérateur vers
 * le geste qui débloque — attendre l'heure du rendez-vous.
 *
 * Ce que `details` porte vient de l'API et d'elle seule, et le contrat d'erreur
 * lui interdit déjà toute donnée d'établissement ou de cliente
 * (tenant-isolation §4) : le traverser jusqu'à l'écran n'ouvre donc aucune
 * fuite que le corps d'erreur n'ouvrait pas.
 */

import { ERROR_CODES } from '@spa/shared';

import { ApiClientError } from '@/lib/api-client';

/**
 * Un refus, tel que les écrans le reçoivent.
 *
 * `details` est **facultatif** à dessein : la grande majorité des refus n'en ont
 * pas besoin — ils se lisent sur le `code` —, et l'exiger aurait obligé chaque
 * action du back-office à poser un objet vide pour satisfaire le type, sans rien
 * ajouter à ce qu'elle dit. Il est posé là où il porte quelque chose : les refus
 * qui remontent de l'API.
 */
export type AdminActionFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type AdminActionResult<TData> =
  | { readonly ok: true; readonly data: TData }
  | AdminActionFailure;

/** Traduit une erreur remontée de l'API — ou n'importe quelle autre — en refus. */
export function failure(error: unknown): AdminActionFailure {
  if (error instanceof ApiClientError) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }

  return {
    ok: false,
    code: ERROR_CODES.INTERNAL_ERROR,
    message: 'Une erreur inattendue est survenue. Merci de réessayer.',
  };
}

/** Refus de validation : l'appel n'a même pas atteint l'API. */
export function invalid(message: string): AdminActionFailure {
  return { ok: false, code: ERROR_CODES.VALIDATION_ERROR, message };
}

/**
 * Refus faute de session — et d'une session qu'on n'a pas pu renouveler.
 *
 * Un cookie d'accès simplement expiré ne produit plus ce refus : l'action le
 * renouvelle sur place avant d'appeler l'API (`adminActionAccess`, #856). Il ne
 * reste donc que les cas où ce renouvellement est impossible — plus de cookie
 * de rafraîchissement, ou jeton refusé par l'API.
 *
 * **Tous** les écrans du back-office réagissent sur `UNAUTHORIZED` — celui-ci,
 * ou le 401 de l'API que `failure()` laisse passer — par le même helper,
 * `useAdminSessionRenewal` : ils partent vers la route de renouvellement, qui
 * pose une session neuve si elle le peut et rend la main sur la page quittée
 * (#48, #458). Elle retombe d'elle-même sur l'écran de connexion quand le jeton
 * de rafraîchissement manque ou que l'API le refuse : c'est là que s'arrête le
 * chemin, et il ne boucle pas (voir `session/refresh/route.ts`).
 */
export function expired(): AdminActionFailure {
  return {
    ok: false,
    code: ERROR_CODES.UNAUTHORIZED,
    message: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  };
}
