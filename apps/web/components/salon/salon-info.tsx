import type { PublicTenant } from '@spa/shared';
import { useLocale, useTranslations } from 'next-intl';

import { Icon } from '@/components/ui/icon';
import type { DisplayLocale } from '@/lib/format';
import { formatPhoneForDisplay } from '@/lib/phone';

import { formatOpeningRange, salonClock, weekSchedule } from './opening-hours';
import { addressLines, directionsUrl } from './salon-address';
import { telUri } from './salon-contact';

/** Identifiant du titre de la carte « Horaires », repris par `aria-labelledby`. */
export const HOURS_HEADING_ID = 'horaires';

/** Identifiant du titre de la carte « Nous trouver ». */
export const PLACE_HEADING_ID = 'nous-trouver';

/**
 * Informations pratiques du salon (#43, complété par #343, remis en forme par
 * #1046).
 *
 * ## Ce qu'elles étaient
 *
 * « Une liste de définitions brute, jusqu'à une ligne “Fuseau horaire
 * Europe/Paris” » (audit `d20260918-1`). Deux cartes la remplacent, celles que
 * le marché pose au même endroit : **Horaires** (BM-VITRINE-03) et **Nous
 * trouver** (BM-VITRINE-07). Elles vivent dans la colonne latérale de la
 * vitrine, collante au-delà de 64 rem, et repassent sous le catalogue au pouce.
 *
 * ## Les horaires disent la semaine entière, fermetures comprises
 *
 * BM-VITRINE-03 : « sept lignes “Lundi … 10:00 - 20:00” ; un jour fermé porte
 * “Fermé” au lieu d'être omis ; le jour courant est mis en évidence. » Le jour
 * courant est calculé dans le fuseau **du salon** et porte, en plus de sa
 * graisse, un « (aujourd'hui) » en lecture d'écran : la mise en évidence ne
 * repose pas sur la seule apparence (WCAG 1.4.1).
 *
 * La règle qui autorise à écrire « Fermé » est dans `weekSchedule` : un salon
 * qui n'a publié **aucune** plage n'a pas de carte « Horaires » du tout, et la
 * question « fermé, ou pas encore saisi ? » ne se pose donc jamais.
 *
 * ## La ligne « Fuseau horaire » a disparu
 *
 * Elle occupait une ligne de la page publique pour une information
 * d'exploitation. Le fuseau reste nommé **là où il sert** — sous les horaires,
 * qui sont les seules heures de cette page — conformément à BM-RDV-06 : « le
 * fuseau est nommé quand la cliente pourrait se trouver ailleurs ». Le comparer
 * au fuseau de la visiteuse demanderait de le lire dans son navigateur ;
 * `timeZoneMention` de `lib/format.ts` le fait, et n'a rien à faire dans un
 * Server Component, où elle comparerait au fuseau d'une machine d'AWS.
 *
 * ## Ce qui ne s'invente pas
 *
 * Une carte n'apparaît que si l'API a rendu de quoi la remplir. Quand rien n'est
 * renseigné, la section rend son état vide plutôt que de disparaître : une page
 * sans informations pratiques se lit comme une page incomplète, là où un état
 * vide explicite dit ce qu'il en est.
 *
 * ## Le lot de consolation n'est plus affirmé à tort (#773)
 *
 * Cet état vide rassurait d'un « La réservation en ligne reste ouverte » écrit
 * en toutes circonstances. Sur la vitrine d'un salon qui n'a **ni** coordonnées
 * **ni** prestation, c'était faux : le tunnel refusait de démarrer deux clics
 * plus loin. La phrase n'est donc plus dite que quand elle est vraie.
 *
 * ## La langue (#846)
 *
 * Les titres des deux cartes, « Fermé », « (aujourd'hui) », la mention du fuseau
 * et l'état vide viennent du catalogue, sous `salon.info` et `salon.hours`. Ce
 * qui n'en vient pas : l'**adresse**, le **numéro** et l'**adresse e-mail**, qui
 * sont du contenu de salon, et les **heures d'ouverture**, qui sont des heures
 * murales telles que la gérante les a saisies.
 *
 * Les **noms de jours** sont calculés par `opening-hours.ts` à partir d'`Intl`,
 * dans la langue résolue et avec la région de l'établissement : la carte écrit
 * « Lundi » ou « Monday » sans qu'aucune table de noms n'existe nulle part. Le
 * **fuseau** ne bouge pas — c'est toujours celui du salon.
 */
interface SalonInfoProps {
  readonly tenant: PublicTenant;
  /**
   * La réservation en ligne est-elle ouverte, c'est-à-dire le salon a-t-il
   * publié au moins une prestation ? (#773)
   *
   * La section n'a pas à charger le catalogue pour le savoir : la page le tient
   * déjà, elle le lui dit.
   */
  readonly bookable: boolean;
  /**
   * L'instant auquel « aujourd'hui » est déterminé — voir `SalonHeader` (#1046).
   */
  readonly now?: Date;
}

export function SalonInfo({ tenant, bookable, now = new Date() }: SalonInfoProps) {
  const t = useTranslations('booking');
  const locale = useLocale();
  const display: DisplayLocale = { locale, countryCode: tenant.address?.country ?? null };
  const week = weekSchedule(tenant.openingHours ?? [], display);
  const today = salonClock(tenant.timezone, now)?.weekday ?? null;
  const hasPlace =
    tenant.address !== undefined ||
    tenant.contactPhone !== undefined ||
    tenant.contactEmail !== undefined;

  if (week.length === 0 && !hasPlace) {
    return (
      <div className="spa-card spa-card--empty">
        <p className="spa-empty-state__title">{t('salon.info.emptyTitle')}</p>
        <p className="spa-empty-state__description">
          {bookable ? t('salon.info.emptyBookable') : t('salon.info.emptyUnavailable')}
        </p>
      </div>
    );
  }

  return (
    <>
      {week.length === 0 ? null : (
        <section className="spa-salon-card" aria-labelledby={HOURS_HEADING_ID}>
          <h2 className="spa-salon-card__title" id={HOURS_HEADING_ID}>
            <Icon name="clock" />
            {t('salon.info.hoursTitle')}
          </h2>

          <ul className="spa-salon-hours">
            {week.map((day) => (
              <li
                aria-current={day.weekday === today ? 'date' : undefined}
                className="spa-salon-hours__row"
                key={day.weekday}
              >
                <span className="spa-salon-hours__day">
                  {day.label}
                  {day.weekday === today ? (
                    <span className="spa-visually-hidden"> {t('salon.info.today')}</span>
                  ) : null}
                </span>
                <span className="spa-salon-hours__ranges">
                  {day.ranges.length === 0
                    ? t('salon.hours.closed')
                    : day.ranges.map((range) => formatOpeningRange(range)).join(', ')}
                </span>
              </li>
            ))}
          </ul>

          <p className="spa-salon-card__hint">
            {t('salon.info.timeZoneHint', { timeZone: humanTimeZone(tenant.timezone) })}
          </p>
        </section>
      )}

      {hasPlace ? (
        <section className="spa-salon-card" aria-labelledby={PLACE_HEADING_ID}>
          <h2 className="spa-salon-card__title" id={PLACE_HEADING_ID}>
            <Icon name="pin" />
            {t('salon.info.placeTitle')}
          </h2>

          {tenant.address === undefined ? null : (
            <>
              <address className="spa-salon-card__address">
                {/* Clé positionnelle, et non le texte de la ligne : deux lignes
                    d'une même adresse peuvent coïncider — un complément qui
                    reprend la voie —, et React n'admet pas deux clés identiques
                    entre frères. La liste est de longueur fixe et sans
                    réordonnancement, l'index y est stable. */}
                {addressLines(tenant.address, display).map((line, index) => (
                  <span key={index}>{line}</span>
                ))}
              </address>
              <a
                className="spa-salon-card__link"
                href={directionsUrl(tenant.name, tenant.address)}
                rel="noopener noreferrer"
                target="_blank"
              >
                <Icon name="external" />
                {t('salon.info.directions')}
                <span className="spa-visually-hidden"> {t('salon.info.newTab')}</span>
              </a>
            </>
          )}

          {tenant.contactPhone === undefined ? null : (
            // Le texte garde l'écriture du salon ; la destination, elle, passe
            // par `telUri` — `storedPhoneSchema` conserve espaces et
            // parenthèses, que RFC 3966 n'admet pas (#773).
            <a className="spa-salon-card__link" href={telUri(tenant.contactPhone)}>
              <Icon name="phone" />
              {formatPhoneForDisplay(tenant.contactPhone)}
            </a>
          )}

          {tenant.contactEmail === undefined ? null : (
            <a className="spa-salon-card__link" href={`mailto:${tenant.contactEmail}`}>
              <Icon name="mail" />
              {tenant.contactEmail}
            </a>
          )}
        </section>
      ) : null}
    </>
  );
}

/**
 * Le fuseau de l'établissement, écrit pour un humain : « Indian/Antananarivo »
 * perd ses tirets bas.
 */
function humanTimeZone(timezone: string): string {
  return timezone.replace(/_/g, ' ');
}
