import { ProgressBar } from '@/components/ui/progress-bar';

/** Trois cartes : la première rangée de la grille de prestations. */
const SKELETON_SERVICES = [1, 2, 3] as const;

/**
 * La vitrine d'un salon, le temps qu'elle arrive (#830).
 *
 * La forme est celle de la page : barre de sorties, en-tête — surtitre, nom du
 * salon, accroche, bouton « Réserver » — puis la première rangée du catalogue.
 * Les mesures sont décrites dans `styles/components/salon.css`.
 *
 * Aucun nom de salon ni aucun tarif n'y figure : le squelette est servi avant que
 * la page connaisse ses données, et il n'en invente pas. Le 404 d'un slug inconnu
 * est décidé plus haut, par `layout.tsx`, avant que ce squelette parte.
 */
export default function VitrineLoading() {
  return (
    <div aria-busy="true" className="spa-salon spa-salon-loading">
      <ProgressBar />
      <p className="spa-visually-hidden">Chargement de la page du salon…</p>
      <div className="spa-public-exits spa-public-exits--header">
        <span className="spa-skeleton spa-salon-loading__exit" />
      </div>
      <div className="spa-salon__main">
        <div className="spa-salon__header">
          <span className="spa-skeleton spa-salon-loading__eyebrow" />
          <span className="spa-skeleton spa-salon-loading__title" />
          <span className="spa-skeleton spa-salon-loading__lede" />
          <span className="spa-skeleton spa-salon-loading__lede spa-salon-loading__lede--short" />
          <span className="spa-skeleton spa-salon-loading__action" />
        </div>
        <div className="spa-salon__section">
          <span className="spa-skeleton spa-salon-loading__section-title" />
          <div className="spa-salon__services">
            {SKELETON_SERVICES.map((service) => (
              <div className="spa-card spa-card--loading spa-salon__service" key={service}>
                <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
                <span className="spa-skeleton spa-card__skeleton-line" />
                <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
