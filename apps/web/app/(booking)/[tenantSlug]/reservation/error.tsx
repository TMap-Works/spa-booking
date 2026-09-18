'use client';

import { RouteError } from '@/components/ui/route-error';

interface BookingErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Le tunnel de réservation qui n'a pas pu se rendre (#830).
 *
 * Posée sous l'enveloppe du tunnel. Les pannes de l'API sont déjà dites par la
 * page ; cette frontière ne voit que ce qui leur échappe.
 *
 * Sans en-tête de tunnel (#1047) : il n'y a ni établissement à nommer, ni étape
 * à quitter — le composant ne reçoit que l'erreur et sa reprise. Le `<h1>`, lui,
 * reste : il vivait dans le layout jusqu'à #1047, qui l'a déplacé dans
 * `BookingProgress` — c'est-à-dire dans le tunnel, que cet écran-ci remplace
 * précisément parce qu'il n'a pas pu se rendre. Sans cette ligne, la page n'a
 * plus le moindre titre, le nom de l'encart d'erreur étant un `<p>`
 * (`components/ui/notification.tsx`) : rien à quoi un lecteur d'écran puisse
 * sauter, et aucun titre de niveau 1 (WCAG 2.4.6).
 *
 * La reprise rejoue la page sans toucher au brouillon du tunnel : il vit dans le
 * stockage de session (`use-draft-autosave.ts`), et les saisies déjà faites
 * reviennent avec le tunnel (`docs/design/appointments/states.md` : un état
 * d'erreur conserve les saisies).
 *
 * Même cadre que l'encart d'erreur de la page, pour que les deux pannes se
 * ressemblent.
 */
export default function BookingError({ reset }: BookingErrorProps) {
  return (
    <main className="spa-booking__main" id="contenu">
      <div className="spa-booking__frame spa-booking__content">
        <h1 className="spa-booking__title">Prendre rendez-vous</h1>
        <RouteError
          message="Une erreur inattendue est survenue. Merci de réessayer dans un instant."
          reset={reset}
          title="La page de réservation n’a pas pu être chargée"
        />
      </div>
    </main>
  );
}
