/**
 * La trame de la bande de jours (#1049).
 *
 * ## Ce qu'elle remplace, et pourquoi
 *
 * #827 avait fait du choix de la date un **calendrier mensuel** posé en tête de
 * l'étape. À 360 px, cela met trente-cinq cases de 40 px — cinq à six lignes —
 * entre le titre de la prestation et le premier horaire : la grille des créneaux
 * passe intégralement sous la ligne de flottaison, et l'écran ne montre plus le
 * choix qu'on est venu faire. C'est le constat de l'audit `d20260918-1`.
 *
 * Le benchmark du marché décrit l'inverse à cette étape-là :
 * `BM-CRENEAU-01` — *« une rangée de jours défilante (jour abrégé, numéro, mois)
 * avec des flèches ; le calendrier du mois complet s'ouvre à la demande ; sous la
 * rangée, les seuls horaires du jour sélectionné »* — observé chez les cinq
 * plateformes de `docs/design/benchmark/parcours-client.md`. Le calendrier ne
 * disparaît pas : il devient le second geste, celui qu'on fait pour aller loin.
 *
 * ## Une fenêtre **dans** la plage déjà chargée
 *
 * La bande ne repose aucune question au serveur : elle montre quatorze journées
 * consécutives prises dans le mois que l'appelant a demandé — celui-là même dont
 * le calendrier tourne les pages. C'est ce qui permet au report de l'espace
 * client d'hériter de la bande sans qu'une ligne de son écran ne change : il
 * charge déjà un mois, et le critère d'acceptation de l'issue interdit de toucher
 * à l'API de disponibilité.
 *
 * Les dates sont donc calculées, jamais déduites de la réponse : une bande qui
 * n'existerait qu'une fois les journées reçues laisserait l'écran sans aucun
 * choix de date pendant le chargement, ce que `states.md` étape 3 refuse
 * explicitement — *« en gardant la barre de dates interactive »*.
 *
 * ## Une date civile, jamais un instant
 *
 * Comme [`month-grid.ts`](month-grid.ts), dont ce module prolonge l'arithmétique :
 * tout y est `YYYY-MM-DD` de l'établissement, et comparer deux dates est
 * comparer deux chaînes.
 */

import type { CalendarDate } from '@spa/shared';

import { addCalendarDays } from './calendar';
import { monthRange, type BookingWindow, type CalendarMonth } from './month-grid';

/**
 * Le nombre de journées que la bande montre d'un coup.
 *
 * Quatorze, comme la direction proposée par l'issue et comme la fenêtre glissante
 * d'avant #827 : deux semaines couvrent le « cette semaine ou la prochaine » qui
 * fait l'essentiel des réservations, et le reste passe par le calendrier. À
 * 360 px cinq blocs tiennent à l'écran et le doigt fait défiler les autres, ce
 * qui est précisément le geste que `BM-CRENEAU-01` décrit.
 */
export const BAND_DAYS = 14;

/**
 * Ce qu'un chevron de la bande avance ou recule.
 *
 * Une semaine et non quatorze jours : garder la moitié des journées à l'écran
 * conserve le repère, là où une page entière oblige à relire toute la bande pour
 * savoir où l'on est.
 */
export const BAND_STEP = 7;

/**
 * Les journées que la bande peut montrer — celles du mois chargé, rognées aux
 * bornes réservables.
 *
 * C'est exactement la plage que l'appelant a demandée au serveur
 * (`monthRange`) : la bande ne peut pas montrer une journée dont personne n'a
 * demandé les créneaux. Vide quand le mois est entièrement hors de la fenêtre de
 * réservation.
 */
export function bandDates(
  month: CalendarMonth,
  bounds: BookingWindow,
): readonly CalendarDate[] {
  const range = monthRange(month, bounds);

  if (range === null) {
    return [];
  }

  const dates: CalendarDate[] = [];

  for (let date = range.from; date <= range.to; date = addCalendarDays(date, 1)) {
    dates.push(date);
  }

  return dates;
}

/** Le plus grand début de fenêtre qui laisse encore `BAND_DAYS` journées derrière lui. */
function lastStart(length: number): number {
  return Math.max(0, length - BAND_DAYS);
}

/**
 * Le début de la fenêtre visible.
 *
 * Trois sources, dans cet ordre :
 *
 * 1. `from` — la journée que les chevrons ont posée en tête de bande. Elle n'est
 *    retenue que si elle appartient encore à la plage : un changement de mois la
 *    laisse en arrière, et la bande repart alors de son point de départ naturel.
 * 2. `focus` — la journée déjà retenue, quand on rouvre l'étape sur un créneau
 *    choisi (#947) ou qu'on revient d'un report. La bande doit s'ouvrir sur
 *    **elle**, pas sur le premier jour du mois.
 * 3. À défaut, la première journée qui a quelque chose à proposer —
 *    `BM-CRENEAU-02`, *« le premier jour qui a des créneaux est sélectionné »* :
 *    la cliente ne tombe jamais sur un écran vide au premier affichage.
 *
 * La journée visée n'est pas ramenée en tête de bande quand elle tient déjà dans
 * la première fenêtre : décaler la bande pour un jour libre situé au troisième
 * rang effacerait aujourd'hui et demain de l'écran sans rien apporter.
 */
export function bandStart(
  dates: readonly CalendarDate[],
  from: CalendarDate | null,
  focus: CalendarDate | null,
): number {
  const last = lastStart(dates.length);

  if (from !== null) {
    const held = dates.indexOf(from);

    if (held >= 0) {
      return Math.min(held, last);
    }
  }

  const wanted = focus === null ? -1 : dates.indexOf(focus);

  if (wanted < 0) {
    return 0;
  }

  return wanted < BAND_DAYS ? 0 : Math.min(wanted, last);
}

/** Les journées effectivement rendues, à partir de `start`. */
export function bandSlice(
  dates: readonly CalendarDate[],
  start: number,
): readonly CalendarDate[] {
  return dates.slice(start, start + BAND_DAYS);
}

/**
 * Les journées calculées, complétées de celles que le serveur a réellement
 * rendues.
 *
 * Il rend en principe exactement la plage demandée. **En principe seulement** :
 * une réponse en retard d'un changement de mois, ou une page de report dont
 * l'adresse et la donnée ne s'accordent pas encore, en rend une autre. Une
 * journée rendue mais absente de la bande serait alors une journée dont plus
 * rien ne peut atteindre les créneaux — la grille ne détaillant qu'une journée
 * que la bande montre.
 *
 * Le tri est une comparaison de chaînes : sur un `YYYY-MM-DD` zéro-complété,
 * l'ordre lexicographique **est** l'ordre chronologique.
 */
function withLoadedDates(
  computed: readonly CalendarDate[],
  loaded: readonly CalendarDate[] | null,
): readonly CalendarDate[] {
  if (loaded === null || loaded.length === 0) {
    return computed;
  }

  return [...new Set([...computed, ...loaded])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Ce que la bande montre, et où elle en est dans la plage chargée. */
export interface BandWindow {
  /** Toutes les journées chargées, du premier au dernier jour demandé au serveur. */
  readonly dates: readonly CalendarDate[];
  /** Le rang, dans `dates`, de la première journée visible. */
  readonly start: number;
  /** Les journées effectivement rendues — au plus `BAND_DAYS`. */
  readonly visible: readonly CalendarDate[];
}

/**
 * La fenêtre visible, calculée une seule fois.
 *
 * Le sélecteur de créneau en a besoin autant que la bande elle-même : c'est elle
 * qui décide quelle journée la grille d'horaires détaille, et laisser chacun la
 * recalculer de son côté ferait exister deux vérités pour une seule rangée.
 */
export function bandWindow(
  month: CalendarMonth,
  bounds: BookingWindow,
  /** Les journées que le serveur a rendues — `null` tant qu'il n'a rien rendu. */
  loaded: readonly CalendarDate[] | null,
  from: CalendarDate | null,
  focus: CalendarDate | null,
): BandWindow {
  const dates = withLoadedDates(bandDates(month, bounds), loaded);
  const start = bandStart(dates, from, focus);

  return { dates, start, visible: bandSlice(dates, start) };
}

/**
 * Le début de fenêtre qui rend `target` visible, en bougeant le moins possible.
 *
 * La bande suit le focus plutôt que de le précéder : une flèche qui sort par la
 * droite fait glisser la bande d'un cran, pas d'une page — le repère visuel
 * survit au déplacement.
 */
export function bandStartShowing(length: number, start: number, target: number): number {
  const last = lastStart(length);

  if (target < start) {
    return Math.max(0, Math.min(target, last));
  }

  if (target > start + BAND_DAYS - 1) {
    return Math.min(target - BAND_DAYS + 1, last);
  }

  return Math.min(start, last);
}

/**
 * Déplacement demandé par une touche dans la bande.
 *
 * `null` = cette touche ne nous regarde pas ; le composant la laisse au
 * navigateur plutôt que d'avaler une tabulation ou un raccourci système.
 */
export type BandMove =
  | 'previousDay'
  | 'nextDay'
  | 'bandStart'
  | 'bandEnd'
  | 'previousBand'
  | 'nextBand';

/**
 * Le clavier de la bande.
 *
 * `docs/design/appointments/keyboard-navigation.md`, « Barre de dates » :
 * `←`/`→` au jour, `PagePréc`/`PageSuiv` à la semaine. `Début`/`Fin` s'y
 * ajoutent — le critère d'acceptation de l'issue les nomme, et une rangée
 * horizontale les appelle comme une ligne de grille les appelle déjà dans la
 * grille de créneaux.
 */
export function bandMoveForKey(key: string): BandMove | null {
  switch (key) {
    case 'ArrowLeft':
      return 'previousDay';
    case 'ArrowRight':
      return 'nextDay';
    case 'Home':
      return 'bandStart';
    case 'End':
      return 'bandEnd';
    case 'PageUp':
      return 'previousBand';
    case 'PageDown':
      return 'nextBand';
    default:
      return null;
  }
}

/**
 * Le rang visé par un déplacement, rogné à la plage chargée.
 *
 * **Le parcours ne boucle pas**, comme dans la grille de créneaux et dans le
 * calendrier, et pour la même raison : une flèche droite qui ramènerait
 * silencieusement de la fin du mois au premier jour ferait réserver un mois plus
 * tôt qu'on ne croit. En bord de plage, le rang ne bouge pas — et c'est ce que le
 * composant lit pour décider s'il doit changer de mois.
 *
 * `Début` et `Fin` portent sur la **fenêtre visible** et non sur le mois entier :
 * ce sont les bornes de ce que l'œil voit, et c'est ce qu'une rangée de jours
 * promet. Le mois entier se parcourt aux chevrons ou dans le calendrier.
 */
export function moveInBand(
  length: number,
  start: number,
  index: number,
  move: BandMove,
): number {
  if (length === 0) {
    return 0;
  }

  const target = ((): number => {
    switch (move) {
      case 'previousDay':
        return index - 1;
      case 'nextDay':
        return index + 1;
      case 'bandStart':
        return start;
      case 'bandEnd':
        return start + BAND_DAYS - 1;
      case 'previousBand':
        return index - BAND_STEP;
      case 'nextBand':
        return index + BAND_STEP;
    }
  })();

  return Math.min(Math.max(target, 0), length - 1);
}
