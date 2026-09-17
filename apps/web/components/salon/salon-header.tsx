import type { PublicTenant } from '@spa/shared';
import Link from 'next/link';

import { LinkPending } from '@/components/ui/link-pending';

import { PUBLIC_EXIT_LABELS } from './public-exits';

interface SalonHeaderProps {
  readonly tenant: PublicTenant;
  /**
   * Chemin du tunnel de réservation — construit par la page, qui tient les URL —
   * ou `null` quand la réservation en ligne n'est pas ouverte (#773).
   *
   * Le `null` n'est pas une commodité de typage : c'est la seule chose que
   * l'en-tête a besoin de savoir de l'état du catalogue. Un salon sans
   * prestation publiée n'a pas de tunnel où envoyer qui que ce soit, et le
   * chemin n'existe donc pas pour lui — plutôt qu'un chemin valide assorti d'un
   * second drapeau qui dirait de ne pas s'en servir.
   */
  readonly reservationHref: string | null;
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
 *
 * Le **libellé**, lui, vient du registre des sorties publiques
 * (`public-exits.tsx`) : cet appel à l'action et les barres de sorties nomment
 * la même page, et deux chaînes écrites à deux endroits finissent par diverger.
 *
 * Au clic, le bouton se dit « en cours » jusqu'à l'arrivée du tunnel (#830) :
 * `LinkPending` y remplace le libellé par un spinner, à largeur conservée, comme
 * un `Button` en chargement. C'est le seul îlot client de cet en-tête, et il ne
 * peint rien avant le clic — le titre qui porte le LCP reste rendu serveur.
 *
 * ## Ce que l'accroche promet, elle le tient (#773)
 *
 * L'accroche annonçait « Découvrez les prestations…, leurs durées et leurs
 * tarifs » et l'action accentuée « Prendre rendez-vous » quel que soit l'état du
 * catalogue. Sur la vitrine d'un salon qui n'a rien publié, les deux étaient
 * faux du même coup : la page ne montrait aucune prestation, et le bouton menait
 * à un tunnel qui refusait de démarrer, « Choisir un créneau » désactivé. C'est
 * l'écart relevé par l'audit `d20260916-1` au titre de `ds:confiance`.
 *
 * L'accroche dit donc désormais l'état réel, et l'appel à l'action **disparaît**
 * au lieu de se désactiver : un bouton grisé sur une page publique laisse croire
 * qu'il manque une condition à remplir, là où il n'y a rien à faire côté
 * visiteuse. Ce qu'il y a à faire — joindre le salon — est proposé par l'état
 * vide du catalogue, juste en dessous, et seulement si le salon a publié de quoi
 * le joindre (`salon-contact.ts`).
 */
export function SalonHeader({ tenant, reservationHref }: SalonHeaderProps) {
  return (
    <header className="spa-salon__header">
      <p className="spa-salon__eyebrow">Réservation en ligne</p>
      <h1 className="spa-salon__title">{tenant.name}</h1>

      {reservationHref === null ? (
        <p className="spa-salon__lede">
          La réservation en ligne de {tenant.name} n’est pas encore ouverte.
        </p>
      ) : (
        <>
          <p className="spa-salon__lede">
            Découvrez les prestations de {tenant.name}, leurs durées et leurs tarifs, puis réservez
            votre rendez-vous en quelques minutes.
          </p>
          <Link className="spa-button spa-button--accent" href={reservationHref}>
            <span className="spa-button__label">{PUBLIC_EXIT_LABELS.reservation}</span>
            <LinkPending />
          </Link>
        </>
      )}
    </header>
  );
}
