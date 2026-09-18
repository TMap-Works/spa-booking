'use client';

import { RouteError } from '@/components/ui/route-error';

interface VitrineErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * La vitrine d'un salon qui n'a pas pu se rendre (#830).
 *
 * Les pannes de l'API sont déjà dites par la page (`page.tsx`) : cette frontière
 * ne voit que ce qui leur échappe. Elle en reprend le conteneur. La sortie vers
 * l'espace client, sans laquelle la visiteuse n'aurait que la reprise pour
 * issue, est dans l'en-tête du gabarit (#1045) : le layout du groupe l'a posé,
 * et une frontière d'erreur se rend **sous** le layout de son segment.
 *
 * La phrase est celle que le parcours public emploie pour toute erreur qu'il ne
 * sait pas nommer (`booking-error-notice.tsx`).
 */
export default function VitrineError({ reset }: VitrineErrorProps) {
  return (
    <div className="spa-salon">
      <main className="spa-salon__main" id="contenu">
        <RouteError
          message="Une erreur inattendue est survenue. Merci de réessayer dans un instant."
          reset={reset}
          title="La page du salon n’a pas pu être chargée"
        />
      </main>
    </div>
  );
}
