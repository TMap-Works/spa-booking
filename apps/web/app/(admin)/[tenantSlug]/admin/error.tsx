'use client';

import { RouteError } from '@/components/ui/route-error';

interface AdminErrorProps {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}

/**
 * Un écran du back-office qui n'a pas pu se rendre (#830).
 *
 * Les échecs de l'API sont déjà traités par chaque page (`guard.tsx`) : cette
 * frontière ne voit que ce qui leur échappe, une panne du rendu. Elle est posée
 * **sous** le layout admin — le rail reste donc affiché quand il y a une
 * session, et l'opérateur peut aussi bien réessayer que changer d'écran (#755 :
 * un état d'erreur laisse une issue). Le message ne renvoie pas au menu pour
 * autant : l'écran de connexion est servi sans rail.
 *
 * Le titre de niveau 1 remplace celui de l'écran qui n'a pas pu s'afficher : la
 * zone de contenu ne reste pas sans nom.
 */
export default function AdminError({ reset }: AdminErrorProps) {
  return (
    <section aria-labelledby="ecran-indisponible-titre">
      <h1 className="spa-admin__title" id="ecran-indisponible-titre">
        Écran indisponible
      </h1>
      <RouteError
        message="Une erreur inattendue a interrompu l’affichage de cet écran. Réessayez dans un instant."
        reset={reset}
        title="Cet écran n’a pas pu s’afficher"
      />
    </section>
  );
}
