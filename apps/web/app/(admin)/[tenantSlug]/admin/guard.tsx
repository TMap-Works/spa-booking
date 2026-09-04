import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { ApiClientError } from '@/lib/api-client';

import { adminLoginPath } from './paths';
import { readAdminAccessToken } from './session';

/**
 * La garde des pages du back-office, écrite une fois.
 *
 * ## Pourquoi dans chaque page et non dans le layout
 *
 * Un layout n'est pas une frontière de sécurité dans l'App Router : il n'est pas
 * rejoué à chaque navigation, et une page peut être servie sans que son parent
 * ait été réévalué. La garde vit donc **dans la page**, et l'écran de connexion
 * s'en passe délibérément plutôt que d'être exempté par une liste tenue
 * ailleurs. Ce module ne change pas cette règle : il en factorise le contenu, de
 * sorte que les cinq écrans du catalogue ne réécrivent pas cinq fois la même
 * cascade de statuts — et ne divergent pas sur le sixième.
 */

/**
 * Le jeton d'accès, ou une redirection vers la connexion.
 *
 * Le type de retour est `string` et non `string | null` : `redirect()` lève, si
 * bien que la suite de l'appelant ne s'exécute jamais sans jeton. C'est ce qui
 * évite un `if (token === null)` de plus dans chaque page — donc l'oubli d'un
 * seul.
 */
export async function requireAdminAccessToken(tenantSlug: string): Promise<string> {
  const accessToken = await readAdminAccessToken();

  if (accessToken === null) {
    redirect(adminLoginPath(tenantSlug));
  }

  return accessToken;
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
