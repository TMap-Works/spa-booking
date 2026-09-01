import type { PublicTenant } from '@spa/shared';
import Link from 'next/link';

interface SalonHeaderProps {
  readonly tenant: PublicTenant;
  /** Chemin du tunnel de réservation — construit par la page, qui tient les URL. */
  readonly reservationHref: string;
}

/**
 * En-tête de la page publique d'un salon (#43).
 *
 * **Server Component** : rien ici n'a d'état ni d'écouteur, et cette section
 * porte le LCP de la page — c'est le titre du salon que le visiteur voit en
 * premier. Un `"use client"` la ferait rendre deux fois et retarderait le seul
 * élément qui compte pour la mesure (skill web-frontend §1 et §7).
 *
 * L'appel à l'action est un `<Link>` et non un `<button>` : c'est une
 * navigation, elle doit pouvoir s'ouvrir dans un nouvel onglet et être suivie
 * par un moteur de recherche jusqu'au tunnel de réservation.
 *
 * Le chemin arrive en propriété plutôt que d'être recomposé ici : les
 * composants de ce dossier ne connaissent pas l'arborescence des routes, c'est
 * la page qui la tient (`salon-data.ts`).
 */
export function SalonHeader({ tenant, reservationHref }: SalonHeaderProps) {
  return (
    <header className="spa-salon__header">
      <p className="spa-salon__eyebrow">Réservation en ligne</p>
      <h1 className="spa-salon__title">{tenant.name}</h1>
      <p className="spa-salon__lede">
        Découvrez les prestations de {tenant.name}, leurs durées et leurs tarifs, puis réservez
        votre rendez-vous en quelques minutes.
      </p>
      <Link className="spa-button spa-button--accent" href={reservationHref}>
        Prendre rendez-vous
      </Link>
    </header>
  );
}
