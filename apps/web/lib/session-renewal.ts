import { ERROR_CODES } from '@spa/shared';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Le renouvellement de session **depuis un écran** — le helper commun des deux
 * surfaces authentifiées (#856).
 *
 * ## Ce qu'il reste à faire à un écran
 *
 * Une action serveur renouvelle elle-même un cookie d'accès expiré
 * (`lib/session-refresh.ts`). Ce qui remonte encore en `UNAUTHORIZED` est donc
 * ce qu'elle n'a pas pu trancher : plus de cookie de rafraîchissement, jeton
 * refusé par l'API, ou 401 de l'API sur un jeton que le cookie portait encore.
 * Dans tous ces cas, la réponse est la même : partir vers la route de
 * renouvellement de la surface, avec la page affichée comme destination. Elle
 * renouvelle si elle le peut et rend la main sur cette page ; sinon elle efface
 * les cookies et mène à la connexion. Ce chemin ne boucle pas — voir
 * `session/refresh/route.ts` de chaque surface.
 *
 * ## Pourquoi un helper et non une ligne dans chaque écran
 *
 * Quatre écrans savaient le faire, chacun à sa façon ; quinze autres affichaient
 * « Votre session a expiré. Reconnectez-vous » — un cul-de-sac là où un
 * aller-retour suffisait. Une seule écriture est ce qui empêche le vingtième
 * écran de retomber dans le second cas.
 *
 * `replace` et non `push` : un renouvellement n'est pas une destination, et le
 * laisser dans l'historique ferait renouveler une seconde fois au premier retour
 * arrière.
 */

/** Ce qu'un écran lit d'un refus d'action — le code, jamais le message. */
export interface ActionRefusal {
  readonly code: string;
}

/** `true` si le refus veut dire « la session est à renouveler ». */
export function isSessionExpired(refusal: ActionRefusal): boolean {
  return refusal.code === ERROR_CODES.UNAUTHORIZED;
}

/**
 * La page affichée, chaîne de requête comprise — la destination du retour.
 *
 * Lue dans la barre d'adresse au moment du départ, et non calculée au rendu :
 * c'est la seule source qui porte à la fois le chemin, la période et les filtres
 * de n'importe quel écran. La route de renouvellement la revalide de toute
 * façon, et une destination hors de sa surface retombe sur l'accueil de
 * celle-ci.
 */
export function currentReturnTo(
  location: Pick<Location, 'pathname' | 'search'> = globalThis.location,
): string {
  return `${location.pathname}${location.search}`;
}

export interface SessionRenewal {
  /**
   * Part vers la route de renouvellement, puis revient sur `returnTo` — la page
   * affichée si l'écran n'en désigne pas d'autre.
   */
  readonly renew: (returnTo?: string) => void;
  /**
   * Part vers le renouvellement si le refus est une session expirée, et rend
   * `true` : l'écran n'a alors plus rien à faire — ni message, ni bouton à
   * réarmer, la page va être remplacée. Rend `false` sur tout autre refus.
   */
  readonly renewIfExpired: (refusal: ActionRefusal) => boolean;
}

/**
 * Le renouvellement d'une surface, donnée par le chemin de sa route.
 *
 * `refreshPath` doit être stable d'un rendu à l'autre — les liaisons de chaque
 * surface le mémoïsent sur le slug. Le routeur, lui, est lu par référence : ce
 * qui est rendu ne change donc qu'avec la surface, et un écran peut le placer
 * dans les dépendances d'un effet sans le rejouer à chaque rendu.
 */
export function useSessionRenewal(refreshPath: (returnTo: string) => string): SessionRenewal {
  const router = useRouter();
  const routerRef = useRef(router);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const renew = useCallback(
    (returnTo?: string): void => {
      routerRef.current.replace(refreshPath(returnTo ?? currentReturnTo()));
    },
    [refreshPath],
  );

  const renewIfExpired = useCallback(
    (refusal: ActionRefusal): boolean => {
      if (!isSessionExpired(refusal)) {
        return false;
      }
      renew();
      return true;
    },
    [renew],
  );

  return useMemo(() => ({ renew, renewIfExpired }), [renew, renewIfExpired]);
}
