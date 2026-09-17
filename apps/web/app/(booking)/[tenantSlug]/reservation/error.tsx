'use client';

import { RouteError } from '@/components/ui/route-error';

interface BookingErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Le tunnel de réservation qui n'a pas pu se rendre (#830).
 *
 * Posée sous le layout du tunnel : le bandeau et le pied — retour à la vitrine,
 * espace client — restent affichés, et la visiteuse garde une issue en plus de la
 * reprise. Les pannes de l'API sont déjà dites par la page ; cette frontière ne
 * voit que ce qui leur échappe.
 *
 * La reprise rejoue la page sans toucher au brouillon du tunnel : il vit dans le
 * stockage de session (`use-draft-autosave.ts`), et les saisies déjà faites
 * reviennent avec le tunnel (`docs/design/appointments/states.md` : un état
 * d'erreur conserve les saisies).
 *
 * Même panneau que l'encart d'erreur de la page, pour que les deux pannes se
 * ressemblent.
 */
export default function BookingError({ reset }: BookingErrorProps) {
  return (
    <div className="spa-booking__panel">
      <RouteError
        message="Une erreur inattendue est survenue. Merci de réessayer dans un instant."
        reset={reset}
        title="La page de réservation n’a pas pu être chargée"
      />
    </div>
  );
}
