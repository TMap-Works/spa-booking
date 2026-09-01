import type { PublicService } from '@spa/shared';

import { formatDuration, formatMoney } from '@/lib/format';

import { groupServicesByCategory } from './group-services';

/** Identifiant du titre de section, repris par `aria-labelledby` de la page. */
export const CATALOG_HEADING_ID = 'catalogue';

/**
 * Catalogue public d'un salon, groupé par rubrique (#43).
 *
 * **Server Component** : c'est du texte, et c'est la partie indexable de la
 * page. Aucun état, aucun filtre côté client — le tri et le choix appartiennent
 * au tunnel de réservation, qui est un autre écran.
 *
 * ## Ce que chaque ligne montre, et pourquoi
 *
 * Nom, description, durée facturée, praticiens et prix. Les tampons de
 * préparation et de remise en état ne sont pas dans `PublicService` et n'ont
 * pas à l'être : ils décrivent la cadence interne du salon
 * (`publicServiceSchema`). La durée affichée est donc celle du soin, celle que
 * la cliente paie.
 *
 * Les montants passent par `formatMoney`, qui part d'un entier et d'un code
 * devise — aucun flottant ne traverse le calcul (CLAUDE.md, règles de code).
 */
export function ServiceCatalog({ services }: { readonly services: readonly PublicService[] }) {
  const sections = groupServicesByCategory(services);

  return (
    <section className="spa-salon__section" aria-labelledby={CATALOG_HEADING_ID}>
      <h2 className="spa-salon__section-title" id={CATALOG_HEADING_ID}>
        Nos prestations
      </h2>

      {sections.length === 0 ? (
        // Un catalogue vide n'est pas une erreur : un salon qui vient de
        // s'inscrire existe, et sa page doit le dire plutôt que de rester
        // blanche (skill web-frontend §6).
        <div className="spa-card spa-card--empty">
          <p className="spa-empty-state__title">Catalogue en cours de préparation</p>
          <p className="spa-empty-state__description">
            Ce salon n’a pas encore publié ses prestations en ligne. Contactez-le directement pour
            connaître son offre.
          </p>
        </div>
      ) : (
        sections.map((section) => (
          <section
            className="spa-salon__category"
            key={section.key}
            aria-labelledby={`rubrique-${section.key}`}
          >
            <h3 className="spa-salon__category-title" id={`rubrique-${section.key}`}>
              {section.title}
            </h3>

            <ul className="spa-salon__services">
              {section.services.map((service) => (
                // L'ancre porte le slug de la prestation : c'est elle que les
                // données structurées désignent dans l'`url` de chaque offre, et
                // un lien profond vers une prestation doit aboutir quelque part.
                <li className="spa-card spa-salon__service" id={service.slug} key={service.id}>
                  <h4 className="spa-card__title">{service.name}</h4>

                  {service.description === null ? null : (
                    <p className="spa-card__body">{service.description}</p>
                  )}

                  <p className="spa-card__meta">
                    <span>
                      <span className="spa-visually-hidden">Durée : </span>
                      {formatDuration(service.durationMinutes)}
                    </span>
                    {service.staff.length === 0 ? null : (
                      <span>
                        <span className="spa-visually-hidden">Praticiens : </span>
                        {service.staff.map((member) => member.displayName).join(', ')}
                      </span>
                    )}
                  </p>

                  <p className="spa-card__price">
                    <span className="spa-visually-hidden">Tarif : </span>
                    {formatMoney(service.price)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
