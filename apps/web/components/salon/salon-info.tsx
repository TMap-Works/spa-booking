import type { PostalAddress, PublicTenant } from '@spa/shared';

import { formatOpeningRange, groupOpeningHoursByDay } from './opening-hours';

/** Identifiant du titre de section, repris par `aria-labelledby`. */
export const INFO_HEADING_ID = 'informations-pratiques';

/**
 * Le fuseau de l'établissement, écrit pour un humain : « Indian/Antananarivo »
 * devient « Indian/Antananarivo » sans ses tirets bas.
 *
 * Ce n'est pas `timeZoneMention` de `lib/format.ts` : celle-ci compare le fuseau
 * du salon à **celui du visiteur**, lu d'`Intl` — donc, dans un Server
 * Component, celui du serveur. La mention serait décidée par le fuseau d'une
 * machine d'AWS et non par celui de la personne qui lit la page.
 */
function humanTimeZone(timezone: string): string {
  return timezone.replace(/_/g, ' ');
}

/**
 * L'adresse en lignes d'affichage.
 *
 * Ni virgules ni format national : une adresse postale se lit en lignes, et
 * c'est ce que rend une pile de `<span>`. Le code postal et la ville partagent
 * la leur, comme sur une enveloppe ; le pays reste à part.
 *
 * Le pays est rendu **en toutes lettres** quand l'environnement sait le
 * traduire, et en code sinon. `Intl.DisplayNames` fait partie d'ECMA-402 et est
 * disponible dans Node comme dans tous les navigateurs visés ; le repli existe
 * pour ne jamais rendre une chaîne vide si un code inconnu passait.
 */
function addressLines(address: PostalAddress): readonly string[] {
  const locality = [address.postalCode, address.city].filter((part) => part !== undefined);

  return [
    address.line1,
    ...(address.line2 === undefined ? [] : [address.line2]),
    locality.join(' '),
    countryName(address.country),
  ];
}

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Informations pratiques du salon (#43, complété par #343).
 *
 * ## Ce que l'API expose
 *
 * Le critère d'acceptation demande « adresse, horaires, contact ». Les trois
 * sont désormais servis : `publicTenantSchema` porte `contactEmail`,
 * `contactPhone`, `address` et `openingHours` (#343). Les trois sont
 * **facultatifs** — un salon fraîchement inscrit n'a rien saisi, et sa page doit
 * rester servie.
 *
 * ## Ce qui ne s'invente pas
 *
 * Une ligne n'apparaît que si l'API a rendu la donnée. Un jour de la semaine
 * absent des horaires n'affiche pas « fermé » : l'API omet les horaires plutôt
 * que de rendre une semaine vide, et rien ne permet donc de distinguer « le
 * salon ferme le lundi » de « le salon n'a pas encore saisi ses horaires ».
 * Afficher le premier quand c'est le second enverrait une cliente devant une
 * porte ouverte.
 *
 * Quand rien n'est renseigné, la section rend son état vide plutôt que de
 * disparaître : une page sans « informations pratiques » se lit comme une page
 * incomplète, là où un état vide explicite dit ce qu'il en est.
 */
export function SalonInfo({ tenant }: { readonly tenant: PublicTenant }) {
  const openingDays = groupOpeningHoursByDay(tenant.openingHours ?? []);
  const hasInfo =
    tenant.contactEmail !== undefined ||
    tenant.contactPhone !== undefined ||
    tenant.address !== undefined ||
    openingDays.length > 0;

  return (
    <section className="spa-salon__section" aria-labelledby={INFO_HEADING_ID}>
      <h2 className="spa-salon__section-title" id={INFO_HEADING_ID}>
        Informations pratiques
      </h2>

      {hasInfo ? (
        <dl className="spa-salon__info">
          {tenant.address === undefined ? null : (
            <div className="spa-salon__info-row">
              <dt className="spa-salon__info-term">Adresse</dt>
              <dd className="spa-salon__info-value">
                <address className="spa-salon__address">
                  {/* Clé positionnelle, et non le texte de la ligne : deux
                      lignes d'une même adresse peuvent coïncider — un
                      complément qui reprend la voie —, et React n'admet pas
                      deux clés identiques entre frères. La liste est de longueur
                      fixe et sans réordonnancement, l'index y est stable. */}
                  {addressLines(tenant.address).map((line, index) => (
                    <span className="spa-salon__address-line" key={index}>
                      {line}
                    </span>
                  ))}
                </address>
              </dd>
            </div>
          )}

          {openingDays.length === 0 ? null : (
            <div className="spa-salon__info-row">
              <dt className="spa-salon__info-term">Horaires d’ouverture</dt>
              <dd className="spa-salon__info-value">
                <ul className="spa-salon__hours">
                  {openingDays.map((day) => (
                    <li className="spa-salon__hours-row" key={day.weekday}>
                      <span className="spa-salon__hours-day">{day.label}</span>
                      <span className="spa-salon__hours-ranges">
                        {day.ranges.map((range) => formatOpeningRange(range)).join(', ')}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="spa-salon__hint">
                  Horaires donnés dans le fuseau du salon.
                </span>
              </dd>
            </div>
          )}

          {tenant.contactEmail === undefined ? null : (
            <div className="spa-salon__info-row">
              <dt className="spa-salon__info-term">E-mail</dt>
              <dd className="spa-salon__info-value">
                <a href={`mailto:${tenant.contactEmail}`}>{tenant.contactEmail}</a>
              </dd>
            </div>
          )}

          {tenant.contactPhone === undefined ? null : (
            <div className="spa-salon__info-row">
              <dt className="spa-salon__info-term">Téléphone</dt>
              <dd className="spa-salon__info-value">
                {/* Le numéro est déjà en E.164 dans le contrat : il fait un
                    `tel:` valide sans retouche. */}
                <a href={`tel:${tenant.contactPhone}`}>{tenant.contactPhone}</a>
              </dd>
            </div>
          )}

          <div className="spa-salon__info-row">
            <dt className="spa-salon__info-term">Fuseau horaire</dt>
            <dd className="spa-salon__info-value">
              {humanTimeZone(tenant.timezone)}
              <span className="spa-salon__hint">
                {' '}
                — les horaires de rendez-vous sont donnés dans ce fuseau.
              </span>
            </dd>
          </div>
        </dl>
      ) : (
        <div className="spa-card spa-card--empty">
          <p className="spa-empty-state__title">Informations non communiquées</p>
          <p className="spa-empty-state__description">
            Ce salon n’a pas encore publié ses coordonnées, son adresse ni ses horaires. La
            réservation en ligne reste ouverte.
          </p>
        </div>
      )}
    </section>
  );
}
