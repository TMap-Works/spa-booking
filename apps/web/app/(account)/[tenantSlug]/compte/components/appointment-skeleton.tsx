import { ProgressBar } from '@/components/ui/progress-bar';

/**
 * Ce que les deux onglets de rendez-vous peignent le temps qu'un écran arrive
 * (#830, repris par #1053).
 *
 * Il s'affiche **sous** le gabarit du compte : l'en-tête, les onglets et la
 * région d'annonce restent en place. Le gabarit résout l'établissement avant lui
 * — un slug inconnu répond donc toujours 404 avant qu'un squelette soit envoyé.
 *
 * Aucune donnée n'y est inventée : ce sont des blocs gris, pas des rendez-vous
 * factices. La forme suit celle de l'écran qui arrive — une carte héros sur
 * « Mes rendez-vous », des cartes compactes sur « Historique » —, faute de quoi
 * la mise en page saute à l'arrivée du contenu.
 *
 * `aria-busy` et une phrase masquée, comme le squelette du tunnel ; la barre de
 * progression prend le relais de celle du clic
 * (`components/ui/progress-bar.tsx`). Les mesures sont dans
 * `styles/components/account.css`.
 */
interface AppointmentSkeletonProps {
  /** `true` sur « Mes rendez-vous », où la première carte est la carte héros. */
  readonly hero?: boolean;
  /** Nombre de cartes compactes — ce qu'une cliente a d'ordinaire sous les yeux. */
  readonly cards?: number;
}

export function AppointmentSkeleton({ hero = false, cards = 2 }: AppointmentSkeletonProps) {
  return (
    <div aria-busy="true" className="spa-account__section spa-account-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">Chargement de votre espace…</p>

      {hero ? (
        <div className="spa-rdv-hero spa-account-loading__hero">
          <span className="spa-skeleton spa-account-loading__title" />
          <span className="spa-skeleton spa-account-loading__line" />
          <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
        </div>
      ) : null}

      <div className="spa-appointment-list">
        {Array.from({ length: cards }, (_unused, index) => (
          <div className="spa-appointment" key={index}>
            <span className="spa-skeleton spa-account-loading__line" />
            <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
          </div>
        ))}
      </div>
    </div>
  );
}
