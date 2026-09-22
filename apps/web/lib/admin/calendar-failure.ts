/**
 * Ce que le planning affiche quand le chargement des rendez-vous échoue (#49).
 *
 * Écrit une fois, parce que l'échec arrive par **deux chemins** : le premier
 * rendu, côté serveur, appelle l'API directement ; les navigations suivantes
 * passent par l'action serveur, qui rend un refus typé. Deux traductions
 * séparées divergeaient à la première correction — et c'est exactement ce que la
 * recette a montré : la journée ouverte affichait un message écrit pour un
 * humain, la semaine suivante recrachait le « Cannot GET /api/v1/appointments »
 * d'Express.
 */

import { ERROR_CODES, type Locale } from '@spa/shared';

import { planningWords, CALENDAR_FALLBACK_LOCALE } from './calendar-messages';

/**
 * Le message du 404, et pourquoi il est nommé à part.
 *
 * Sur cette route, un 404 ne peut vouloir dire qu'une chose : `GET /appointments`
 * n'est pas servie. Le chemin n'a aucun segment dynamique — il n'existe pas de
 * rendez-vous introuvable à ce niveau —, si bien qu'un message générique
 * masquerait un manque parfaitement identifié derrière une phrase qui n'aide
 * personne.
 *
 * Il vient du catalogue `admin-planning` depuis #848 — `failure.routeMissing` —,
 * et non plus d'un littéral : c'est le même texte que celui qu'`useTranslations`
 * sert aux composants, lu ici sans crochet parce que ce module est fait de
 * fonctions pures.
 */
export function calendarRouteMissingMessage(
  locale: Locale = CALENDAR_FALLBACK_LOCALE,
): string {
  return planningWords(locale).failure.routeMissing;
}

/**
 * `HTTP_404` est le repli du client d'API quand le corps d'erreur ne suit pas le
 * contrat — un 404 servi par le cadre HTTP plutôt que par le filtre d'exception.
 * Les deux désignent ici la même absence.
 */
const MISSING_ROUTE_CODES: readonly string[] = [ERROR_CODES.NOT_FOUND, 'HTTP_404'];

/** Le message à afficher, à partir du code et du message rendus par l'API. */
export function calendarFailureMessage(
  code: string,
  message: string,
  locale: Locale = CALENDAR_FALLBACK_LOCALE,
): string {
  return MISSING_ROUTE_CODES.includes(code) ? calendarRouteMissingMessage(locale) : message;
}
