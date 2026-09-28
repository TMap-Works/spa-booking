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
 *
 * ## Plus aucun message de l'API n'arrive à l'écran — #1298
 *
 * Les deux chemins n'apportaient pas la même chose, et c'est ce qui a longtemps
 * masqué l'écart :
 *
 * - l'action serveur rend un refus dont le `message` est **déjà** dans la langue
 *   de la session — soit une phrase que le planning a lui-même écrite
 *   (`invalid(t('actions.invalidDate'))`, dans `calendrier/actions.ts`), soit
 *   celle que `errorMessage` a posée dans `action-result.ts` depuis #1234 ;
 * - le premier rendu, lui, appelle l'API directement et n'a que le corps
 *   d'erreur. Le `message` y est celui que l'API a écrit, c'est-à-dire **du
 *   français** : l'API n'a pas de langue de requête, ses `DomainError` sont
 *   rédigées une fois pour le journal et le diagnostic (voir l'en-tête de
 *   `packages/shared/src/errors/error-messages.ts`). Un planning ouvert en
 *   anglais repassait donc au français dès qu'un refus n'était pas le 404 — une
 *   fenêtre trop large, une session refusée, une panne de l'API.
 *
 * La traduction se fait donc là où manque la phrase, et nulle part ailleurs :
 * `calendarApiFailureMessage` la tire de `errorMessage(code, locale)` pour le
 * chemin qui n'en a pas. La traduire aussi dans `calendarFailureMessage`
 * écraserait les phrases du planning par la phrase générique de
 * `VALIDATION_ERROR` — « Certaines informations sont incomplètes » là où le
 * planning disait quelle date il n'avait pas su lire.
 */

import { ERROR_CODES, errorMessage, type Locale } from '@spa/shared';

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

/**
 * Le message à afficher pour ce refus.
 *
 * `displayMessage` est la phrase **déjà affichable** que l'appelant tient — dans
 * la langue de la session, et non celle d'un corps d'erreur de l'API. C'est le
 * contrat de ce paramètre depuis #1298, et c'est ce que rend un refus d'action
 * serveur : `calendrier/actions.ts` écrit les siennes par `invalid(t(…))`, et
 * `action-result.ts` tire les autres de `errorMessage`. Un appelant qui n'a
 * qu'un corps d'erreur de l'API passe par `calendarApiFailureMessage`, juste
 * en dessous, plutôt que de tendre ici le `message` qu'il a reçu.
 */
export function calendarFailureMessage(
  code: string,
  displayMessage: string,
  locale: Locale = CALENDAR_FALLBACK_LOCALE,
): string {
  return MISSING_ROUTE_CODES.includes(code) ? calendarRouteMissingMessage(locale) : displayMessage;
}

/**
 * Le même message, pour un refus dont on n'a que le **code** de l'API.
 *
 * C'est le cas du premier rendu du planning : il appelle l'API directement, et
 * le `message` de l'`ApiClientError` est celui que l'API a écrit — du français,
 * pour le journal. La phrase affichable se tire donc du code, par la table
 * bilingue du contrat partagé (#1298). Un code que cette table ne connaît pas —
 * les `HTTP_<statut>` que le filtre d'exception de l'API fabrique — y retombe
 * sur la phrase générique d'`INTERNAL_ERROR`, traduite elle aussi.
 *
 * Nommée ici plutôt qu'écrite au point d'appel : c'est la composition qui doit
 * être éprouvée — le 404 garde son diagnostic propre, tout le reste se traduit —
 * et une expression recopiée dans `page.tsx` ne se teste qu'en la recopiant une
 * seconde fois dans la suite.
 */
export function calendarApiFailureMessage(
  code: string,
  locale: Locale = CALENDAR_FALLBACK_LOCALE,
): string {
  return calendarFailureMessage(code, errorMessage(code, locale), locale);
}
