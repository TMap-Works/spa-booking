import type { PublicTenant } from '@spa/shared';

import { directionsUrl } from '@/components/account/appointment-brief';
import { formatOpeningRange, groupOpeningHoursByDay } from '@/components/salon/opening-hours';
import { telUri } from '@/components/salon/salon-contact';
import { addressLines } from '@/components/salon/salon-info';
import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';

/**
 * La carte du salon, en colonne latérale de l'espace client — #1053.
 *
 * ## Ce qu'elle corrige
 *
 * L'audit `d20260918-1` relève que « rien ne dit à qui appartient l'espace », et
 * qu'à 1280 px l'écran reste une colonne de texte étroite. La direction demande
 * une colonne principale (les rendez-vous) et une colonne latérale portant
 * l'adresse, le téléphone et les horaires du jour — ce que `BM-RDV-04` veut « à
 * un geste ».
 *
 * ## Elle n'est pas le pied de page
 *
 * Le gabarit du salon (#1045) porte déjà l'adresse et le contact **en pied**.
 * L'audit le note : à 360 px, ce pied est sous deux blocs qu'il faut faire
 * défiler. Cette carte est donc rendue **après** les rendez-vous dans le flux du
 * document — elle ne repousse rien sur un petit écran — et remonte à côté d'eux
 * dès que la place existe. Elle ajoute ce que le pied n'a pas : **les horaires
 * du jour**, c'est-à-dire le seul de la semaine qui serve le jour où l'on
 * consulte son rendez-vous.
 *
 * ## Server Component
 *
 * Aucun état. Le jour courant est déduit du fuseau de l'**établissement** — le
 * seul référentiel où « aujourd'hui » veut dire quelque chose pour un salon
 * (ADR 0006) — et non de celui de la machine qui rend la page.
 */
interface SalonAsideProps {
  readonly tenant: PublicTenant;
}

/**
 * Le jour ISO 8601 (1 lundi … 7 dimanche) qu'il est dans le fuseau du salon.
 *
 * `Intl` et non `Date.getDay()` : le second rend le jour de la machine, et
 * `weekday: 'short'` en `en-GB` donne un nom stable qu'aucune locale d'affichage
 * ne vient déplacer. La table part de lundi, comme la numérotation ISO du
 * contrat — jamais du `0`-dimanche de `getDay`.
 */
const ISO_WEEKDAYS: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function todayWeekday(timeZone: string, now: Date = new Date()): number | null {
  const short = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(now);

  return ISO_WEEKDAYS[short] ?? null;
}

export function SalonAside({ tenant }: SalonAsideProps) {
  const directions = directionsUrl(tenant);
  const phone = tenant.contactPhone;
  const weekday = todayWeekday(tenant.timezone);
  /**
   * `true` quand le salon a publié une semaine d'ouverture — et c'est bien de la
   * **publication** qu'il s'agit, pas de l'ouverture du jour.
   *
   * Les deux ne se confondent pas : un salon fermé le dimanche n'a « pas
   * d'horaire aujourd'hui », exactement comme un salon qui n'a rien saisi. Se
   * taire dans les deux cas laisserait une cliente devant la même absence pour
   * deux faits opposés — et c'est le dimanche qu'elle a besoin de savoir qu'il
   * est fermé.
   */
  const publishesHours = tenant.openingHours !== undefined && tenant.openingHours.length > 0;
  const today =
    !publishesHours || weekday === null
      ? null
      : (groupOpeningHoursByDay(tenant.openingHours ?? []).find((day) => day.weekday === weekday) ??
        null);
  const showHours = publishesHours && weekday !== null;

  // Un salon fraîchement inscrit n'a saisi ni adresse, ni téléphone, ni
  // horaires : la carte disparaît alors plutôt que de rendre un cadre vide.
  if (tenant.address === undefined && phone === undefined && !showHours) {
    return null;
  }

  return (
    <aside className="spa-account__aside" aria-labelledby="salon-aside-titre">
      <div className="spa-account__card">
        <p className="spa-account__card-title" id="salon-aside-titre">
          <Avatar name={tenant.name} shape="square" tone="brand" size="sm" />
          {tenant.name}
        </p>

        {tenant.address === undefined ? null : (
          <div className="spa-account__card-row">
            <Icon name="pin" className="spa-account__card-icon" />
            <div>
              <address className="spa-account__card-address">
                {addressLines(tenant.address).map((line, index) => (
                  <span key={index}>{line}</span>
                ))}
              </address>
              {directions === null ? null : (
                <a
                  className="spa-account__card-link"
                  href={directions}
                  target="_blank"
                  rel="noreferrer"
                >
                  Itinéraire
                  <Icon name="external" />
                </a>
              )}
            </div>
          </div>
        )}

        {phone === undefined ? null : (
          <div className="spa-account__card-row">
            <Icon name="phone" className="spa-account__card-icon" />
            <a className="spa-account__card-link" href={telUri(phone)}>
              {phone}
            </a>
          </div>
        )}

        {!showHours ? null : (
          <div className="spa-account__card-row">
            <Icon name="clock" className="spa-account__card-icon" />
            <p className="spa-account__card-hours">
              <span className="spa-account__card-day">Aujourd’hui</span>
              {today === null ? (
                <span>Fermé</span>
              ) : (
                today.ranges.map((range, index) => (
                  <span key={index}>{formatOpeningRange(range)}</span>
                ))
              )}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
