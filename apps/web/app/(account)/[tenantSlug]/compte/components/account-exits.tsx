'use client';

import { usePathname } from 'next/navigation';

import { PUBLIC_EXIT_LABELS } from '@/components/salon/public-exits';

import { accountPath, bookingPath, loginPath } from '../paths';

/**
 * Le pied de page de l'espace client — **ses sorties**, et rien d'autre (#749).
 *
 * ## Ce qu'il répare
 *
 * L'audit `d20260916-1` relève deux défauts sur ces deux liens, tous deux au
 * titre de `ds:libelles` :
 *
 * 1. le pied nommait « Mes rendez-vous » une destination dont le titre est
 *    « Mon compte » — il réécrivait la chaîne au lieu de la lire dans le registre
 *    qui existe pour cela (`components/salon/public-exits.tsx`) ;
 * 2. sur `/{slug}/compte/connexion`, ce lien menait à `/{slug}/compte`, **qui
 *    redirige aussitôt vers la connexion** (`session.ts`, cas 3). Une sortie qui
 *    ramène à l'écran qu'on lit n'est pas une sortie : elle se lit comme une
 *    panne, ou comme une invitation à tourner en rond.
 *
 * ## La règle, énoncée une fois
 *
 * La sortie « compte » est masquée quand **l'écran où elle mène est celui qu'on
 * lit déjà**. Ce n'est pas « quand on est connecté » ni « quand on est sur la
 * liste » : c'est la destination *effective* qui décide, redirection comprise.
 * Sans jeton d'accès, `/{slug}/compte` finit sur la connexion — le lien
 * disparaît donc de la connexion, et reste sur l'inscription, d'où il mène bien
 * ailleurs.
 *
 * `Prendre un nouveau rendez-vous` n'est jamais masqué : le tunnel n'appartient
 * pas à cet espace, et aucun de ses écrans ne peut être celui qu'on lit.
 *
 * Depuis #927, le gabarit ne peint plus ce pied quand **aucun** cookie n'est
 * là : ces écrans-là reçoivent le cadre d'accueil et ses propres sorties. Ce
 * composant garde donc le seul état où la connexion porte encore ce pied — une
 * session renouvelable —, qui est justement celui que le cookie d'accès tranche.
 *
 * ## Client Component, pour `usePathname()` seul
 *
 * Même arbitrage que `AccountNav` (#747) : un layout n'est pas rejoué à chaque
 * navigation dans l'App Router, si bien qu'un chemin calculé côté serveur
 * resterait figé sur le premier écran ouvert — précisément celui qu'on quitte.
 * Rien d'autre ne franchit la frontière : ce composant reçoit un slug et un
 * booléen, jamais un jeton — c'est le gabarit qui lit les cookies
 * (web-frontend §2).
 *
 * Les balises et les classes sont celles que le gabarit rendait déjà : le pied
 * change de propriétaire, pas d'apparence.
 */
interface AccountExitsProps {
  readonly tenantSlug: string;
  /**
   * Le **cookie d'accès** est-il là, tel que le gabarit le lit ?
   *
   * C'est lui, et non « une session existe », qui dit où `/{slug}/compte` mène :
   * la liste n'est servie qu'à un jeton d'accès valide. Sans lui, la page part au
   * renouvellement, qui peut aboutir — et rendre la liste — ou échouer, et mener
   * à la connexion. Or **c'est précisément dans cet état que la barre est peinte
   * sur l'écran de connexion** : un renouvellement refusé par le limiteur ou par
   * une API injoignable y renvoie **sans effacer les cookies**
   * (`session/refresh/route.ts`, `isRefreshRefused`). Compter la session
   * renouvelable comme « mène à la liste » y rouvrait donc la boucle que ce
   * composant ferme.
   *
   * Le pari inverse ne coûte rien : les écrans gardés — liste, coordonnées,
   * report — ne se rendent pas du tout sans jeton d'accès, leur page redirigeant
   * avant tout rendu (`session.ts`, `readAccountData`). Seules la connexion et
   * l'inscription se peignent dans cet état, et cette lecture y donne pour les
   * deux la bonne réponse.
   *
   * La barre du compte, elle, regarde toujours les **deux** cookies : elle dirait
   * autrement « pas de session » à chaque expiration, juste avant le
   * renouvellement qui la ramène (#747).
   */
  readonly hasAccessToken: boolean;
}

export function AccountExits({ tenantSlug, hasAccessToken }: AccountExitsProps) {
  const pathname = usePathname();
  const account = accountPath(tenantSlug);
  // Où le lien mène **vraiment** : sans jeton d'accès, `/compte` finit sur la
  // connexion, et c'est cette page-là qu'il faut comparer à l'écran courant.
  const landing = hasAccessToken ? account : loginPath(tenantSlug);

  return (
    <footer className="spa-account__footer">
      <a className="spa-account__back" href={bookingPath(tenantSlug)}>
        Prendre un nouveau rendez-vous
      </a>
      {pathname === landing ? null : (
        <a className="spa-account__back" href={account}>
          {PUBLIC_EXIT_LABELS.compte}
        </a>
      )}
    </footer>
  );
}
