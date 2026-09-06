/**
 * Dates civiles du parcours de réservation.
 *
 * Une **date civile** n'est pas un instant : « aujourd'hui » à Antananarivo et
 * « aujourd'hui » à Papeete ne désignent pas la même journée au même moment. Les
 * bornes de la requête de disponibilité sont des dates civiles de
 * l'établissement (voir `availabilityQuerySchema`), et c'est le seul endroit du
 * front qui les calcule.
 */

import type { CalendarDate, TimeZone } from '@spa/shared';

/** Millisecondes dans une journée — les bornes se déplacent en UTC, pas en heure murale. */
const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * La date civile qu'affiche l'horloge de `timeZone` à cet instant.
 *
 * `formatToParts` plutôt qu'une locale complaisante : `en-CA` rend bien
 * `2026-09-01`, mais c'est une propriété de cette locale et non une garantie.
 * Les composants extraits un par un, la sortie est un `YYYY-MM-DD` par
 * construction.
 */
export function calendarDateInTimeZone(instant: Date, timeZone: TimeZone): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * `date` décalée de `days` journées civiles.
 *
 * Le calcul passe par midi UTC : sur une date lue à minuit, une bascule d'heure
 * d'été suffirait à faire retomber l'addition sur la veille.
 */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.parse(`${date}T12:00:00Z`) + days * MILLISECONDS_IN_DAY);

  return shifted.toISOString().slice(0, 10);
}

/**
 * Les `length` dates civiles consécutives à partir de `from`, bornes comprises.
 *
 * C'est la fenêtre que la requête de disponibilité demande, et elle se calcule
 * **sans le serveur** : ce sont des dates, pas des agendas. La barre de dates du
 * sélecteur s'en sert pour rester affichée et opérable pendant le chargement —
 * `states.md` étape 3 le demande explicitement, « en gardant la barre de dates
 * interactive pour changer de jour sans attendre ». La déduire de la réponse
 * aurait exigé d'attendre la réponse, ce qui est exactement le contraire.
 *
 * Une longueur nulle ou négative rend une fenêtre vide plutôt qu'une erreur :
 * l'appelant affiche alors une barre sans journée, ce qui est le rendu correct
 * de « rien à proposer ».
 */
export function calendarWindow(from: CalendarDate, length: number): readonly CalendarDate[] {
  return Array.from({ length: Math.max(length, 0) }, (_unused, index) =>
    addCalendarDays(from, index),
  );
}

/**
 * La forme courte d'une date civile — « mar. 1 ».
 *
 * C'est ce qu'affiche une pastille de la barre de dates, où quatorze journées
 * tiennent sur une ligne : « mardi 1 septembre 2026 » y serait illisible. Le
 * libellé complet reste porté par l'`aria-label` de la pastille, si bien qu'un
 * lecteur d'écran entend la date entière et non l'abrégé.
 *
 * Lue dans le référentiel UTC, pour la raison qu'expose `formatCalendarDate` :
 * une date civile **est déjà** celle de l'établissement, et la reprojeter dans
 * son fuseau la décalerait d'un jour sur la moitié du globe.
 */
export function formatCalendarDayShort(date: CalendarDate): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}
