'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { LinkPending } from '@/components/ui/link-pending';

import { LogoutButton } from './logout-button';
import { accountPath } from '../paths';

/**
 * La navigation de l'espace client — **posée par le gabarit, donc servie par
 * tous ses écrans connectés** (#747).
 *
 * ## Ce qui manquait
 *
 * La barre « Modifier mes coordonnées | Se déconnecter » était rendue par
 * `page.tsx`, c'est-à-dire par **un écran sur trois**. Sur
 * `/{slug}/compte/coordonnees` et sur `/{slug}/compte/rendez-vous/{id}/report`,
 * « Se déconnecter » n'existait nulle part : fermer sa session depuis l'écran de
 * ses coordonnées demandait de revenir d'abord à la liste. L'audit `d20260916-1`
 * relève l'écart au titre de `ds:coherence` — *la même action se trouve au même
 * endroit d'un écran à l'autre d'un même espace* — et le CDC §2.4 ne connaît
 * qu'un `User` pour les trois écrans, pas un par page.
 *
 * ## Pourquoi ce composant est client, et lui seul
 *
 * Il lui faut `usePathname()`. Marquer l'entrée courante est la seule chose
 * qu'un rendu serveur ne saurait pas faire ici : un layout n'est pas rejoué à
 * chaque navigation dans l'App Router, si bien qu'un repère calculé côté serveur
 * resterait figé sur le premier écran ouvert — précisément celui qu'on quitte.
 * Même arbitrage que le rail du back-office (`(admin)/…/components/admin-rail.tsx`).
 *
 * Rien d'autre ne franchit la frontière : le composant reçoit un slug, jamais un
 * jeton. C'est le gabarit qui lit la session, et il ne passe ici que des chaînes
 * (web-frontend §2).
 *
 * ## Ce que cette barre ne fait pas : garder quoi que ce soit
 *
 * Elle n'est pas rendue tant qu'il n'y a pas de session — mais c'est le gabarit
 * qui en décide, et ce n'est pas une garde : un menu masqué n'interdit pas de
 * taper l'URL, et la seule frontière qui compte est celle de l'API. La garde des
 * écrans vit dans chaque page, par `readAccountData` (`session.ts`).
 *
 * Les classes sont celles qui existaient déjà (`styles/components/account.css`) :
 * la barre change de propriétaire, pas d'apparence.
 */
interface AccountNavProps {
  readonly tenantSlug: string;
}

export function AccountNav({ tenantSlug }: AccountNavProps) {
  const pathname = usePathname();
  const profile = accountPath(tenantSlug, '/coordonnees');

  return (
    <nav className="spa-account__nav" aria-label="Mon compte">
      {/*
       * La barre est identique partout, l'écran des coordonnées compris : c'est
       * ce que le ticket demande, et retirer l'entrée sur l'écran qu'elle
       * désigne rendrait la barre différente d'un écran à l'autre — l'écart
       * qu'on corrige. Le lien y pointe donc vers la page courante, et
       * `aria-current="page"` le dit à qui écoute, plutôt que de laisser
       * chercher (WAI-ARIA Authoring Practices, motif « navigation »).
       *
       * Égalité stricte et non préfixe : `/coordonnees` n'a pas de sous-écran,
       * et un `startsWith` marquerait un jour une route voisine qui n'est pas
       * celle-là.
       */}
      <Link
        aria-current={pathname === profile ? 'page' : undefined}
        className="spa-account__nav-link"
        href={profile}
      >
        Modifier mes coordonnées
        {/* Le lien cliqué se dit « en cours » jusqu'à l'arrivée de l'écran (#830). */}
        <LinkPending />
      </Link>
      <LogoutButton tenantSlug={tenantSlug} />
    </nav>
  );
}
