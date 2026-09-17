'use client';

import { useLinkStatus } from 'next/link';

interface LinkPendingProps {
  /** Classe de placement, propre au lien qui l'accueille. */
  readonly className?: string;
}

/**
 * Le repère « en cours » d'un lien cliqué (#830).
 *
 * ## Ce qu'il dit
 *
 * Que **ce** lien-là a été pris en compte, et que son écran arrive. La barre de
 * progression dit qu'une navigation est en vol ; ce repère dit laquelle — c'est
 * ce qui manquait au rail, dont le surlignage restait sur l'écran qu'on quittait.
 *
 * ## Où il se pose
 *
 * **À l'intérieur** d'un `<Link>` : `useLinkStatus` lit l'état du lien ancêtre le
 * plus proche, et n'en connaît aucun ailleurs. C'est aussi pourquoi il est un
 * composant à part et non une propriété du lien — un lien rendu côté serveur,
 * comme « Réserver » sur la vitrine, n'a besoin que de cet îlot client, pas de
 * basculer entier.
 *
 * Le rendu est toujours présent, et seul `data-pending` change : la place du
 * repère est réservée dès le départ, et le libellé ne saute pas au clic. Chaque
 * lien décide de son apparence dans sa feuille (`[data-pending]`), le lien
 * pouvant se peindre lui-même par `:has()`.
 *
 * ## Ce qu'il n'annonce pas
 *
 * Il est décoratif, comme la barre (`components/ui/progress-bar.tsx`) : l'attente
 * se dit une fois, par le squelette de l'écran d'arrivée. Son apparition est
 * différée dans la feuille — une navigation préchargée aboutit avant, et un
 * repère qui clignote à chaque clic serait du bruit.
 */
export function LinkPending({ className }: LinkPendingProps) {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden="true"
      className={className === undefined ? 'spa-link-pending' : `spa-link-pending ${className}`}
      data-pending={pending ? 'true' : undefined}
    />
  );
}
