import { Icon } from '@/components/ui/icon';

/**
 * L'illustration du héros de l'accueil : un rendez-vous en train de se prendre
 * (#927).
 *
 * ## Du balisage plutôt qu'une image
 *
 * Une capture d'écran vieillirait au premier changement d'interface, pèserait
 * sur le LCP de la page et ne suivrait ni le thème sombre ni la rampe de marque.
 * Ces trois cartes sont peintes avec les jetons du design system : elles
 * changent avec le produit, et coûtent quelques centaines d'octets.
 *
 * ## Décorative, et déclarée comme telle
 *
 * Elle montre ce que le texte voisin dit déjà — choisir une prestation, un
 * créneau, recevoir la confirmation. Elle est donc masquée aux technologies
 * d'assistance : une lectrice d'écran entendrait sinon un faux rendez-vous, avec
 * un prix et une heure, au milieu de la présentation du produit.
 */

const SLOTS = [
  { time: '09:30', state: 'free' },
  { time: '10:00', state: 'taken' },
  { time: '10:30', state: 'selected' },
  { time: '11:00', state: 'free' },
  { time: '14:00', state: 'free' },
  { time: '15:30', state: 'free' },
] as const;

export function BookingPreview() {
  return (
    <div className="spa-home-preview" aria-hidden="true">
      <div className="spa-home-preview__card spa-home-preview__card--service">
        <span className="spa-home-preview__badge">
          <Icon name="sparkle" className="spa-home-preview__badge-icon" />
          Soin visage
        </span>
        <p className="spa-home-preview__title">Éclat hydratant</p>
        <p className="spa-home-preview__meta">60 min · avec Inès</p>
        <p className="spa-home-preview__price">75,00 €</p>
      </div>

      <div className="spa-home-preview__card spa-home-preview__card--slots">
        <p className="spa-home-preview__day">
          <Icon name="calendar" className="spa-home-preview__day-icon" />
          Jeudi
        </p>
        <ul className="spa-home-preview__slots">
          {SLOTS.map((slot) => (
            <li
              key={slot.time}
              className={`spa-home-preview__slot spa-home-preview__slot--${slot.state}`}
            >
              {slot.time}
            </li>
          ))}
        </ul>
      </div>

      <div className="spa-home-preview__toast">
        <span className="spa-home-preview__toast-icon">
          <Icon name="check" />
        </span>
        <p className="spa-home-preview__toast-text">
          <strong>Rendez-vous confirmé</strong>
          <span>Rappel envoyé la veille</span>
        </p>
      </div>
    </div>
  );
}
