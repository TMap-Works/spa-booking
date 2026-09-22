import { useTranslations } from 'next-intl';

import { ProgressBar } from '@/components/ui/progress-bar';

/** Trois lignes : le haut de la première rubrique du catalogue. */
const SKELETON_SERVICES = [1, 2, 3] as const;

/**
 * La vitrine d'un salon, le temps qu'elle arrive (#830, remise en forme par #1046).
 *
 * La forme est celle de la page : le bandeau d'identité — monogramme, nom, ligne
 * d'état, appel à l'action —, puis les deux colonnes, catalogue à gauche et
 * informations pratiques à droite. Les mesures sont décrites dans
 * `styles/components/salon.css` ; les blocs ci-dessous n'ajoutent que les
 * hauteurs, celles des lignes qu'ils remplacent.
 *
 * Aucun nom de salon ni aucun tarif n'y figure : le squelette est servi avant que
 * la page connaisse ses données, et il n'en invente pas. Le 404 d'un slug inconnu
 * est décidé plus haut, par `layout.tsx`, avant que ce squelette parte.
 *
 * ## La langue (#846)
 *
 * Une seule phrase, et elle ne se voit pas : l'annonce faite au lecteur d'écran
 * pendant que la page arrive. Le reste n'est que des blocs gris, qui ne disent
 * rien dans aucune langue. Server Component **synchrone**, donc `useTranslations`
 * et non `getTranslations`.
 */
export default function VitrineLoading() {
  const t = useTranslations('booking');

  return (
    <div aria-busy="true" className="spa-salon spa-salon-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">{t('salon.loading.announcement')}</p>

      <div className="spa-salon__main">
        <div className="spa-salon-hero">
          <div className="spa-salon-hero__identity">
            <span className="spa-skeleton spa-salon-loading__mark" />
            <div className="spa-salon-hero__naming">
              <span className="spa-skeleton spa-salon-loading__title" />
              <span className="spa-skeleton spa-salon-loading__facts" />
            </div>
          </div>
          <span className="spa-skeleton spa-salon-loading__lede" />
          <span className="spa-skeleton spa-salon-loading__action" />
        </div>

        <div className="spa-salon__columns">
          <div className="spa-salon__column">
            <div className="spa-salon__section">
              <span className="spa-skeleton spa-salon-loading__section-title" />
              <ul className="spa-salon__services">
                {SKELETON_SERVICES.map((service) => (
                  <li className="spa-salon-service spa-salon-loading__service" key={service}>
                    <div className="spa-salon-service__main">
                      <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
                      <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
                    </div>
                    <div className="spa-salon-service__aside">
                      <span className="spa-skeleton spa-salon-loading__price" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="spa-salon__aside">
            <div className="spa-salon-card spa-salon-loading__card">
              <span className="spa-skeleton spa-salon-loading__card-title" />
              <span className="spa-skeleton spa-card__skeleton-line" />
              <span className="spa-skeleton spa-card__skeleton-line" />
              <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
