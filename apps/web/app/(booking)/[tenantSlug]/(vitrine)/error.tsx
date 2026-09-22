'use client';

import { useTranslations } from 'next-intl';

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
 *
 * ## La langue (#846)
 *
 * Le titre est **le même** que celui de l'encart de panne de la page — une seule
 * clé, `salon.error.title` : ces deux écrans disent la même chose de la même
 * page, et deux entrées de catalogue auraient fini par diverger d'une langue à
 * l'autre. Client Component par contrat de Next, donc `useTranslations`.
 *
 * La phrase du corps, elle, est celle du parcours entier : `errors.unexpected`,
 * que `booking-error-notice.tsx` rend pour ce dont on ne sait rien. Trois
 * écritures d'une même phrase — ici, la vitrine, le tunnel — auraient divergé
 * d'une relecture à l'autre.
 */
export default function VitrineError({ reset }: VitrineErrorProps) {
  const t = useTranslations('booking');

  return (
    <div className="spa-salon">
      <main className="spa-salon__main" id="contenu">
        <RouteError
          message={t('errors.unexpected')}
          reset={reset}
          title={t('salon.error.title')}
        />
      </main>
    </div>
  );
}
