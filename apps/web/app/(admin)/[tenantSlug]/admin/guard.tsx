import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { ApiClientError } from '@/lib/api-client';

import { adminLoginPath, adminSessionRefreshPath } from './paths';
import { readAdminAccessToken, readAdminRefreshToken } from './session';

/**
 * La garde des pages du back-office, écrite une fois.
 *
 * ## Pourquoi dans chaque page et non dans le layout
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router : il n'est pas
 * rejoué à chaque navigation, et une page peut être servie sans que son parent
 * ait été réévalué. La garde vit donc **dans la page**, et l'écran de connexion
 * s'en passe délibérément plutôt que d'être exempté par une liste tenue
 * ailleurs. Le shell (#48) ne change pas cette règle : il peint la navigation,
 * il ne garde rien. Ce module en factorise le contenu, de sorte que les écrans
 * du back-office ne réécrivent pas chacun la même cascade de statuts — et ne
 * divergent pas sur le suivant.
 */

/**
 * Le jeton d'accès, ou une redirection — vers le renouvellement, ou vers la
 * connexion.
 *
 * Le type de retour est `string` et non `string | null` : `redirect()` lève, si
 * bien que la suite de l'appelant ne s'exécute jamais sans jeton. C'est ce qui
 * évite un `if (token === null)` de plus dans chaque page — donc l'oubli d'un
 * seul.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **le cookie d'accès est là** — on le rend. C'est le cas courant ;
 * 2. **il a expiré, le cookie de rafraîchissement est là** — on part vers la
 *    route de renouvellement, qui pose une session neuve et renvoie ici. Elle ne
 *    peut pas y renvoyer deux fois de suite : au retour, le cookie d'accès
 *    existe forcément, sans quoi c'est le cas 3 ;
 * 3. **les deux ont disparu** — écran de connexion.
 *
 * `returnTo` est la page où revenir après un renouvellement, et il est
 * **obligatoire** (#458). Facultatif, il n'était passé par aucune page : un
 * renouvellement déposait l'opérateur sur le planning et perdait la vue et la
 * date du calendrier, ou le filtre du catalogue — sur les écrans mêmes dont les
 * huit heures d'ouverture d'affilée justifient le renouvellement silencieux. Le
 * type l'exige donc désormais, comme l'espace client l'exige de `readAccountData`
 * depuis toujours : c'est la seule forme de rappel qu'un écran neuf ne puisse pas
 * ignorer.
 *
 * Ce que la page passe est **son chemin courant**, chaîne de requête comprise,
 * construit par les fonctions de `paths.ts` — jamais concaténé sur place. La
 * route de renouvellement le revalide de toute façon (`safeAdminNext`) : une
 * destination hors de ce back-office retombe sur le planning.
 */
export async function requireAdminAccessToken(
  tenantSlug: string,
  returnTo: string,
): Promise<string> {
  const accessToken = await readAdminAccessToken();

  if (accessToken !== null) {
    return accessToken;
  }

  const refreshToken = await readAdminRefreshToken();

  redirect(
    refreshToken === null
      ? adminLoginPath(tenantSlug)
      : adminSessionRefreshPath(tenantSlug, returnTo),
  );
}

/**
 * Ce qu'une page affiche quand un chargement de l'API échoue.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **401** — la session a été révoquée en base ou l'API a changé de secret. On
 *    ne tente pas de renouveler, ce qui échouerait pour la même raison : retour
 *    à la connexion ;
 * 2. **403** — la session est valide mais le rôle ne suffit pas. Ce n'est **pas**
 *    une raison de renvoyer à la connexion : se reconnecter avec le même compte
 *    donnerait le même refus, et la boucle serait sans fin. L'écran le dit, et
 *    s'arrête là ;
 * 3. **le reste** — le message de l'API, tel quel.
 *
 * Ce qui n'est pas une `ApiClientError` est **relancé** : une panne de rendu
 * n'est pas un refus métier, et l'avaler la ferait passer pour une donnée
 * manquante au lieu de remonter à la frontière d'erreur de Next.
 */
export function adminLoadFailure(
  error: unknown,
  tenantSlug: string,
  options: { readonly deniedTitle: string; readonly deniedHint: string; readonly failedTitle: string },
): ReactElement {
  if (!(error instanceof ApiClientError)) {
    throw error;
  }

  if (error.status === 401) {
    redirect(adminLoginPath(tenantSlug));
  }

  if (error.status === 403) {
    return (
      <Notification tone="warning" title={options.deniedTitle}>
        <p>{options.deniedHint}</p>
      </Notification>
    );
  }

  return (
    <Notification tone="danger" title={options.failedTitle}>
      <p>{error.message}</p>
    </Notification>
  );
}
