'use client';

import type { PublicService } from '@spa/shared';

import { formatDuration, formatMoney } from '@/lib/format';

interface ServiceChoiceProps {
  readonly services: readonly PublicService[];
  /** `null` : aucune prestation retenue — aucune carte n'est cochée. */
  readonly selectedServiceId: string | null;
  readonly onSelect: (serviceId: string) => void;
}

/**
 * Le choix de la prestation, en cartes (#741).
 *
 * ## Ce qu'il remplace
 *
 * Un `<select>` natif dont chaque option concaténait nom, durée et prix. À
 * 360 px, le contrôle refermé affichait « Rituel duo 90 min — 1 h 30 — 14… » :
 * le prix était **coupé**, et rien d'autre à l'écran ne le portait — la barre de
 * résumé de #735 ne s'affiche qu'à partir de l'étape suivante. Les descriptions
 * que la vitrine montre disparaissaient avec lui, et deux prestations ne se
 * comparaient plus qu'en dépliant la liste et en lisant des lignes tronquées
 * (audit `d20260916-1`, critère `ds:hierarchie`).
 *
 * ## Ce que `wireframes.md` prescrit, et qui est tenu ici
 *
 * `docs/design/appointments/wireframes.md` — étape 1 :
 *
 * - *« Chaque carte affiche **durée** et **prix** (formaté depuis un entier +
 *   devise) »* — les deux sont sur leur propre ligne, hors de toute chaîne
 *   composée : rien ne peut plus en tronquer un bout ;
 * - *« La sélection est un `radiogroup` : un seul choix actif, navigable au
 *   clavier »* — des `<input type="radio">` **natifs** dans un `<fieldset>` nommé
 *   par sa `<legend>`. Le groupe, la position (« 2 sur 5 ») et la navigation aux
 *   flèches viennent avec, sans un seul attribut `aria` ni un gestionnaire de
 *   touche à écrire. C'est le motif que le comptoir emploie déjà pour son moyen
 *   de paiement (`checkout-panel.tsx`) ;
 * - *« Desktop : grille de 2–3 cartes par ligne »* — la feuille s'en charge
 *   (`booking.css`), sans point de rupture : les cartes se posent d'elles-mêmes
 *   sur une colonne tant que la largeur ne tient pas deux cartes lisibles.
 *
 * ## Ce qu'il ne fait pas
 *
 * Le wireframe dessine aussi, à cette étape, un champ de recherche et des
 * rubriques repliables. Ni l'un ni l'autre n'est ici : l'issue ne les relève pas,
 * et un catalogue de MVP tient sur un écran. Le regroupement par rubrique, lui,
 * appartient à la vitrine, qui le rend déjà — le reprendre ici demanderait de
 * partager son découpage entre deux surfaces, ce qu'un ticket de mise en forme
 * n'a pas à trancher.
 *
 * Le radio reste **visible**, là où `checkout-panel.tsx` le masque. Deux raisons :
 * une carte qui ne se distingue que par la couleur de son cadre porte son état
 * par la seule couleur (WCAG 1.4.1), et le wireframe dessine bien une case —
 * « [x] Massage aux pierres ». La pastille native la donne sans rien peindre.
 *
 * `.spa-card--selectable` du socle dit la même chose en cadre et en fond, mais
 * expose son état par `aria-checked` **sur la carte** : l'adopter ferait de
 * chaque carte un `<button role="radio">`, et il faudrait réécrire à la main le
 * groupe, le *roving tabindex* et les flèches. C'est le raisonnement écrit en
 * long dans `booking.css`, au-dessus de `.spa-booking__services`.
 */
export function ServiceChoice({ services, selectedServiceId, onSelect }: ServiceChoiceProps) {
  if (services.length === 0) {
    // « Ça charge » et « il n'y a rien » ne sont pas le même écran : le catalogue
    // est arrivé, il est vide, et l'écran le dit (skill web-frontend §6). C'est
    // le message que portait l'`emptyLabel` du sélecteur.
    return (
      <div className="spa-card spa-card--empty">
        <p className="spa-empty-state__title">Aucune prestation réservable en ligne</p>
        <p className="spa-empty-state__description">
          Ce salon ne propose aucune prestation à la réservation en ligne pour le moment.
          Contactez-le directement pour connaître son offre.
        </p>
      </div>
    );
  }

  return (
    <fieldset className="spa-booking__services">
      <legend className="spa-booking__services-legend">Prestation</legend>

      {services.map((service) => (
        // Le `<label>` **enveloppe** son contrôle : le nom accessible du bouton
        // radio est alors tout ce que la carte porte — « Massage suédois, Durée :
        // 1 h 00, Tarif : 35,00 €, Détente profonde… » —, et toute la carte est
        // cliquable, y compris au doigt.
        <label className="spa-booking__service" key={service.id}>
          <input
            className="spa-booking__service-input"
            type="radio"
            name="prestation"
            value={service.id}
            checked={service.id === selectedServiceId}
            onChange={() => {
              onSelect(service.id);
            }}
          />

          <span className="spa-booking__service-body">
            <span className="spa-booking__service-name">{service.name}</span>

            <span className="spa-booking__service-facts">
              {/* Les préfixes sont donnés au lecteur d'écran et à lui seul :
                  « 1 h 00 · 35,00 € » se comprend d'un coup d'œil dans la carte,
                  mais s'entend comme deux nombres sans objet. Même partage que
                  le catalogue de la vitrine. */}
              <span className="spa-booking__service-duration">
                <span className="spa-visually-hidden">Durée : </span>
                {formatDuration(service.durationMinutes)}
              </span>
              <span className="spa-booking__service-price">
                <span className="spa-visually-hidden">Tarif : </span>
                {formatMoney(service.price)}
              </span>
            </span>

            {service.description === null ? null : (
              <span className="spa-booking__service-description">{service.description}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
