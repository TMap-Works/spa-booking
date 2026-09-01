import type { PublicTenant } from '@spa/shared';

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
 * Informations pratiques du salon (#43).
 *
 * ## Ce que l'API expose, et ce qu'elle n'expose pas
 *
 * Le critère d'acceptation demande « adresse, horaires, contact ». Seul le
 * **contact** est servi : `publicTenantSchema` porte `contactEmail` et
 * `contactPhone`, et rien d'autre de cette nature. L'adresse postale n'existe
 * ni dans le contrat partagé ni dans le modèle Prisma `Tenant` ; les horaires
 * d'ouverture ne sont exposés par aucune route publique — `closing-days` et
 * `staff/{id}/schedule` sont derrière authentification et décrivent des agendas
 * de praticiens, pas les heures d'ouverture d'un établissement.
 *
 * Les inventer côté front serait pire que de les taire. La section rend donc ce
 * qui existe et renvoie vers le salon pour le reste ; le jour où l'API portera
 * ces champs, ce sont deux lignes de `<dl>` à ajouter ici, et le renvoi
 * disparaît.
 */
export function SalonInfo({ tenant }: { readonly tenant: PublicTenant }) {
  const hasContact = tenant.contactEmail !== undefined || tenant.contactPhone !== undefined;

  return (
    <section className="spa-salon__section" aria-labelledby={INFO_HEADING_ID}>
      <h2 className="spa-salon__section-title" id={INFO_HEADING_ID}>
        Informations pratiques
      </h2>

      {hasContact ? (
        <dl className="spa-salon__info">
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
          <p className="spa-empty-state__title">Coordonnées non communiquées</p>
          <p className="spa-empty-state__description">
            Ce salon n’a pas encore publié ses coordonnées. La réservation en ligne reste ouverte.
          </p>
        </div>
      )}

      {hasContact ? (
        <p className="spa-salon__hint">
          Adresse et horaires d’ouverture : contactez directement le salon.
        </p>
      ) : null}
    </section>
  );
}
