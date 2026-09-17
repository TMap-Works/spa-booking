/**
 * Les jours où le salon **annonce** qu'il ouvre (#742).
 *
 * ## Pourquoi ce module existe
 *
 * Le calendrier de réservation écrivait « complet » sur toutes les journées sans
 * créneau, samedis et dimanches compris — alors que la vitrine du même
 * établissement publie des horaires du lundi au vendredi. « Complet » dit à la
 * cliente que tout est réservé et l'invite à repasser plus tard ; « Fermé » lui
 * dirait de choisir un autre jour. C'est l'écart que le CDC §2.3 nomme en propre
 * pour le module Disponibilités & agenda : il distingue les **horaires** des
 * **rendez-vous pris**, et l'interface doit dire lequel des deux empêche de
 * réserver.
 *
 * ## Ce que ces plages sont, et ce qu'elles ne sont pas
 *
 * `openingHours` (`packages/shared/src/schemas/tenant.ts`) décrit ce que le
 * salon **annonce à ses clientes**, et rien d'autre : le moteur de créneaux ne
 * le lit pas — il part des horaires du personnel et des jours de fermeture. Le
 * schéma le dit en toutes lettres, et l'avertissement est à prendre au mot :
 * « les confondre ferait d'un affichage de vitrine une règle d'agenda ».
 *
 * D'où la règle que ce module sert, et la seule : ces plages ne décident
 * **jamais** qu'une journée est indisponible. Elles ne font que **nommer** une
 * journée dont le moteur a déjà dit qu'elle n'a aucun créneau. Une journée qui
 * en a garde les siens, quoi qu'annonce la vitrine — un praticien qui ouvre
 * exceptionnellement un samedi n'a pas à voir son agenda masqué par un horaire
 * d'affichage.
 *
 * ## « Fermé » et « pas encore renseigné » ne se confondent pas
 *
 * L'API **omet** `openingHours` plutôt que de rendre une semaine vide (#343), et
 * un salon fraîchement inscrit n'a donc rien publié. Un tableau absent ou vide
 * ne dit pas « le salon ne travaille jamais » : il dit qu'on ne sait pas. Le
 * calendrier retombe alors sur « complet », qui n'affirme rien de faux. C'est le
 * même arbitrage que `groupOpeningHoursByDay` sur la vitrine, où un jour absent
 * ne produit pas de ligne « fermé ».
 */

import { isoWeekdayOf, type CalendarDate, type IsoWeekday, type OpeningHoursEntry } from '@spa/shared';

/**
 * Les jours ISO — 1 lundi … 7 dimanche — où au moins une plage d'ouverture est
 * publiée. `null` quand le salon n'a pas publié d'horaires : on ne sait pas.
 *
 * Un ensemble et non un prédicat : il se calcule une fois pour le mois entier,
 * là où un prédicat reconstruit sa fermeture à chaque case.
 */
export function publishedOpenWeekdays(
  entries: readonly OpeningHoursEntry[] | undefined,
): ReadonlySet<IsoWeekday> | null {
  if (entries === undefined || entries.length === 0) {
    return null;
  }

  return new Set(entries.map((entry) => entry.weekday));
}

/**
 * Le salon annonce-t-il qu'il n'ouvre pas ce jour-là ?
 *
 * `false` dès que les horaires manquent — sans eux, aucune journée ne peut être
 * déclarée fermée, et le calendrier garde le mot qu'il employait déjà.
 */
export function isPublishedClosedDay(
  date: CalendarDate,
  openWeekdays: ReadonlySet<IsoWeekday> | null,
): boolean {
  return openWeekdays !== null && !openWeekdays.has(isoWeekdayOf(date));
}
