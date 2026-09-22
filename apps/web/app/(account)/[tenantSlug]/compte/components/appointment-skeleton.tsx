import { useTranslations } from 'next-intl';

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
 * factices. La forme suit celle de l'écran qui arrive — une carte héros puis des
 * cartes compactes sur « Mes rendez-vous », une rangée de filtres puis des lignes
 * sur « Historique » depuis #1054 —, faute de quoi la mise en page saute à
 * l'arrivée du contenu. C'est tout l'objet de la forme demandée : peindre des
 * cartes là où une liste arrive rendrait le squelette pire qu'un écran blanc.
 *
 * `aria-busy` et une phrase masquée, comme le squelette du tunnel ; la barre de
 * progression prend le relais de celle du clic
 * (`components/ui/progress-bar.tsx`). Les mesures sont dans
 * `styles/components/account.css`.
 */
interface AppointmentSkeletonProps {
  /** `true` sur « Mes rendez-vous », où la première carte est la carte héros. */
  readonly hero?: boolean;
  /** Nombre de rendez-vous esquissés — ce qu'une cliente a d'ordinaire sous les yeux. */
  readonly cards?: number;
  /** `list` pour l'historique (#1054), `cards` pour les rendez-vous à venir. */
  readonly shape?: 'cards' | 'list';
}

export function AppointmentSkeleton({
  hero = false,
  cards = 2,
  shape = 'cards',
}: AppointmentSkeletonProps) {
  const t = useTranslations('account.loading');

  return (
    <div aria-busy="true" className="spa-account__section spa-account-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">{t('label')}</p>

      {hero ? (
        <div className="spa-rdv-hero spa-account-loading__hero">
          <span className="spa-skeleton spa-account-loading__title" />
          <span className="spa-skeleton spa-account-loading__line" />
          <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
        </div>
      ) : null}

      {shape === 'cards' ? (
        <div className="spa-appointment-list">
          {Array.from({ length: cards }, (_unused, index) => (
            <div className="spa-appointment" key={index}>
              <span className="spa-skeleton spa-account-loading__line" />
              <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
            </div>
          ))}
        </div>
      ) : (
        <div className="spa-history">
          {/* La rangée de filtres tient déjà sa place : elle coiffe la liste dès
              qu'elle arrive, et l'oublier ferait descendre toutes les lignes
              d'un cran au dernier moment. */}
          <span className="spa-skeleton spa-account-loading__filters" />

          <div className="spa-history__list">
            {Array.from({ length: cards }, (_unused, index) => (
              <div className="spa-history__row" key={index}>
                <span className="spa-skeleton spa-account-loading__date" />
                <div className="spa-history__body">
                  <span className="spa-skeleton spa-account-loading__line" />
                  <span className="spa-skeleton spa-account-loading__line spa-account-loading__line--short" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
