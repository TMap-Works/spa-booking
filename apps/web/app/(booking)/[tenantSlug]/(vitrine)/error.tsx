'use client';

import { useParams } from 'next/navigation';

import { accountPath } from '@/app/(account)/[tenantSlug]/compte/paths';
import { PublicExits } from '@/components/salon/public-exits';
import { RouteError } from '@/components/ui/route-error';

interface VitrineErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * La vitrine d'un salon qui n'a pas pu se rendre (#830).
 *
 * Les pannes de l'API sont déjà dites par la page (`page.tsx`) : cette frontière
 * ne voit que ce qui leur échappe. Elle en reprend la forme — le conteneur de la
 * vitrine, que le layout du groupe ne rend pas, et la sortie vers l'espace
 * client, sans laquelle la visiteuse n'aurait que la reprise pour issue.
 *
 * Le chemin du compte vient de `compte/paths.ts`, écrit pour les Client
 * Components — comme le fait déjà l'étape de confirmation du tunnel :
 * `salon-data.ts` en a un jumeau, mais il entraînerait les chargements du salon
 * dans le bundle du navigateur.
 *
 * La phrase est celle que le parcours public emploie pour toute erreur qu'il ne
 * sait pas nommer (`booking-error-notice.tsx`).
 */
export default function VitrineError({ reset }: VitrineErrorProps) {
  const { tenantSlug } = useParams<{ tenantSlug: string }>();

  return (
    <div className="spa-salon">
      <PublicExits variant="header" exits={[{ key: 'compte', href: accountPath(tenantSlug) }]} />
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
