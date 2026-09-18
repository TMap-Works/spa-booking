import { ERROR_CODES } from '@spa/shared';
import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';

import { Notification } from '@/components/ui/notification';
import { ApiClientError } from '@/lib/api-client';
import { renewalReturnTo } from '@/lib/session-refresh';

import { AdminRetryButton } from './components/admin-retry-button';
import { adminBillingPath, adminLoginPath, adminSessionRefreshPath } from './paths';
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
 * Il en existe un quatrième, que cette fonction ne voit pas : le cookie d'accès
 * est là, et l'API refuse quand même le jeton. Il ne se constate qu'à l'appel,
 * et c'est `adminUnauthorizedPath` qui en décide (#861).
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
 * Ce que le back-office dit d'une API injoignable — et qui n'est pas ce que le
 * client public en dit (#755).
 *
 * `lib/api-client.ts` construit, pour une coupure réseau, un
 * `SERVICE_UNAVAILABLE` dont le message nomme « le service de réservation ». Il
 * est juste devant un visiteur en train de réserver ; il ne l'est plus sur
 * l'encaissement, le planning ou les réglages, où il fait chercher à l'opérateur
 * ce que la réservation vient faire dans son écran de comptoir.
 *
 * C'est le **`code`** qui est lu et non le message, comme le veulent
 * `web-frontend` §2 et `docs/design/appointments/states.md` : le message est ce
 * qui change d'une version d'API à l'autre, le code est ce qui tient.
 */
const UNREACHABLE_MESSAGE =
  'Le serveur du salon est momentanément injoignable. Réessayez dans un instant.';

/** Le texte à afficher pour cet échec — le nôtre s'il s'agit d'une panne. */
function failureMessage(error: ApiClientError): string {
  return error.code === ERROR_CODES.SERVICE_UNAVAILABLE ? UNREACHABLE_MESSAGE : error.message;
}

/**
 * Ce qu'un écran sait de son propre renouvellement — voir `adminUnauthorizedPath`.
 *
 * Les deux champs vont ensemble et ne se séparent pas : sans `returnTo` il n'y a
 * nulle part où revenir, et sans `attempted` rien n'arrête la seconde tentative.
 */
export interface AdminRenewal {
  /** Le chemin de l'écran, paramètres compris — celui où revenir après coup. */
  readonly returnTo: string;
  /** `true` si l'URL courante revient déjà d'un renouvellement (voir `isRenewalReturn`). */
  readonly attempted: boolean;
}

/**
 * Où mène un **401 reçu alors que le cookie d'accès est là** (#861).
 *
 * C'est le quatrième cas de `requireAdminAccessToken`, et il ne se confond avec
 * aucun des trois autres : le cookie existe, donc le jeton n'est pas « absent » ;
 * l'API le refuse pourtant. Trois causes le produisent sans que la session soit
 * morte — secret changé au déploiement, horloge de l'API dérivée, rendu plus long
 * que la marge de trente secondes du cookie —, et toutes trois se réparent par un
 * renouvellement. Y répondre par la connexion, comme avant ce ticket, faisait
 * retaper un mot de passe dont personne n'avait besoin.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **l'écran ne dit rien de son renouvellement** — il ne sait pas où revenir :
 *    connexion, exactement comme avant. C'est le cas des écrans qui ne passent
 *    pas encore de `renewal` ;
 * 2. **il en revient déjà** (`?session=renouvelee`) — la session neuve a été
 *    refusée elle aussi, et une troisième ne changerait rien : connexion, en
 *    disant que la session a expiré ;
 * 3. **il n'a pas encore essayé** — route de renouvellement, avec le chemin
 *    marqué. Elle pose une session neuve et rend la main à l'écran, ou refuse et
 *    mène elle-même à la connexion : c'est elle, et elle seule, qui efface les
 *    cookies (`lib/session-refresh.ts`).
 */
export function adminUnauthorizedPath(tenantSlug: string, renewal?: AdminRenewal): string {
  if (renewal === undefined) {
    return adminLoginPath(tenantSlug);
  }

  return renewal.attempted
    ? adminLoginPath(tenantSlug, 'session-expiree')
    : adminSessionRefreshPath(tenantSlug, renewalReturnTo(renewal.returnTo));
}

/**
 * Ce qu'une page affiche quand un chargement de l'API échoue.
 *
 * Trois issues, et aucune ne boucle :
 *
 * 1. **401** — le cookie d'accès est là et l'API refuse quand même le jeton. Un
 *    renouvellement est tenté d'abord, et une seule fois : voir
 *    `adminUnauthorizedPath` ;
 * 2. **403** — la session est valide mais le rôle ne suffit pas. Ce n'est **pas**
 *    une raison de renvoyer à la connexion : se reconnecter avec le même compte
 *    donnerait le même refus, et la boucle serait sans fin. L'écran le dit, et
 *    s'arrête là ;
 * 3. **le reste** — le message de l'API, et **une reprise**.
 *
 * Ce qui n'est pas une `ApiClientError` est **relancé** : une panne de rendu
 * n'est pas un refus métier, et l'avaler la ferait passer pour une donnée
 * manquante au lieu de remonter à la frontière d'erreur de Next.
 *
 * ## Pourquoi « Réessayer » sur la troisième branche, et sur elle seule (#755)
 *
 * `docs/design/appointments/states.md`, « Règles générales », exige d'un état
 * d'erreur un message compréhensible **et** une action « Réessayer ». L'encart
 * n'en avait aucune : l'écran de comptoir se réduisait à un pavé rouge, et le
 * seul recours de l'opérateur était la barre d'adresse.
 *
 * La branche 403, elle, n'en reçoit pas — et ce n'est pas un oubli. Réessayer un
 * refus de rôle rejoue le même appel avec le même compte, pour le même refus :
 * le bouton promettrait une issue qui n'existe pas. C'est la raison même pour
 * laquelle cette branche ne repart pas vers la connexion, deux paragraphes plus
 * haut.
 */
export function adminLoadFailure(
  error: unknown,
  tenantSlug: string,
  options: {
    readonly deniedTitle: string;
    readonly deniedHint: string;
    readonly failedTitle: string;
    /**
     * Ce que l'écran sait de son renouvellement, s'il en sait quelque chose.
     *
     * Facultatif, et il l'est délibérément : un écran qui ne le passe pas garde
     * le comportement d'avant #861 — la connexion —, ce qui est sûr mais ne
     * renouvelle rien. Le passer est le seul moyen d'obtenir la tentative, et
     * c'est aussi ce qui la borne à une.
     */
    readonly renewal?: AdminRenewal;
  },
): ReactElement {
  if (!(error instanceof ApiClientError)) {
    throw error;
  }

  if (error.status === 401) {
    redirect(adminUnauthorizedPath(tenantSlug, options.renewal));
  }
  // L'abonnement du salon n'est pas en cours (ADR 0016) : tous les écrans
  // mènent à celui qui permet de le rétablir.
  if (error.status === 402) {
    redirect(adminBillingPath(tenantSlug));
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
      <p>{failureMessage(error)}</p>
      <AdminRetryButton />
    </Notification>
  );
}
