import { ProgressBar } from '@/components/ui/progress-bar';

/**
 * Le tunnel de réservation, le temps qu'il arrive (#830).
 *
 * ## Où il s'affiche
 *
 * **Sous** le layout du tunnel : le bandeau — nom du salon, « Prendre
 * rendez-vous » — et le pied restent peints, et le layout a déjà décidé du 404
 * d'un slug inconnu avant que ce squelette parte. Au clic sur « Réserver », la
 * visiteuse voit donc la page du tunnel se poser tout de suite, et seul le
 * panneau reste à remplir.
 *
 * ## Sa forme
 *
 * Celle que `BookingTunnel` prend avant son hydratation : le fil des étapes, puis
 * une carte en chargement, avec la même phrase masquée. Le squelette du serveur
 * et celui du composant se succèdent sans que rien bouge.
 */
export default function BookingLoading() {
  return (
    <div aria-busy="true" className="spa-booking__panel spa-booking-loading">
      <ProgressBar />
      <span className="spa-skeleton spa-booking-loading__steps" />
      <div className="spa-card spa-card--loading">
        <span className="spa-visually-hidden">Chargement de votre réservation…</span>
        <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
        <span className="spa-skeleton spa-card__skeleton-line" />
        <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
      </div>
    </div>
  );
}
