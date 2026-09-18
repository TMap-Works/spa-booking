import { ProgressBar } from '@/components/ui/progress-bar';

/**
 * Le tunnel de réservation, le temps qu'il arrive (#830, #1047).
 *
 * ## Où il s'affiche
 *
 * **Sous** l'enveloppe du tunnel, qui a déjà décidé du 404 d'un slug inconnu
 * avant que ce squelette parte. Au clic sur « Prendre rendez-vous », la
 * visiteuse voit donc la page du tunnel se poser tout de suite.
 *
 * ## Sa forme
 *
 * Celle que le tunnel prend à son arrivée : la bande d'en-tête, la ligne de
 * progression, le titre d'étape, puis la carte en chargement que `BookingTunnel`
 * affiche lui-même avant son hydratation, avec la même phrase masquée. Le tunnel
 * qui arrive reprend donc la place du squelette, sans que rien saute.
 *
 * L'en-tête est ici un squelette et non le vrai : il porte deux commandes qui
 * dépendent de l'étape et du brouillon, et aucune des deux n'existe tant que le
 * tunnel n'est pas là. Une barre inerte d'une hauteur juste vaut mieux qu'un
 * « ✕ Quitter » qui ne saurait pas encore ce qu'il fait perdre.
 */
export default function BookingLoading() {
  return (
    <>
      <div aria-hidden="true" className="spa-booking__header spa-booking-loading">
        <div className="spa-booking__header-bar">
          <span className="spa-skeleton spa-booking-loading__brand" />
        </div>
      </div>

      <main className="spa-booking__main" id="contenu" aria-busy="true">
        <div className="spa-booking__frame">
          <div className="spa-booking__content spa-booking-loading">
            <ProgressBar />
            <span className="spa-skeleton spa-booking-loading__steps" />
            <span className="spa-skeleton spa-booking-loading__title" />
            <div className="spa-card spa-card--loading">
              <span className="spa-visually-hidden">Chargement de votre réservation…</span>
              <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--title" />
              <span className="spa-skeleton spa-card__skeleton-line" />
              <span className="spa-skeleton spa-card__skeleton-line spa-card__skeleton-line--short" />
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
