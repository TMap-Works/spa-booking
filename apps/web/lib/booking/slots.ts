/**
 * Ce que le sélecteur de créneau (#44) calcule à partir d'une réponse de
 * disponibilité — et rien de plus.
 *
 * Le découpage en journées, lui, reste au serveur : il demande le fuseau de
 * l'établissement, et `dayAvailabilitySchema` dit pourquoi on ne le refait pas
 * dans un navigateur. Ce fichier ne fait donc que **choisir quoi montrer** parmi
 * ce que le serveur a déjà découpé.
 *
 * La logique est extraite du composant pour être éprouvée sans monter de DOM :
 * le sélecteur de créneau est le contrôle le plus souvent raté du parcours, et
 * les règles qui décident ce qu'il affiche méritent leurs propres tests.
 */

import type { AvailabilitySlot, CalendarDate, DayAvailability, TimeZone } from '@spa/shared';

/** Une journée telle que le sélecteur la manipule : ses créneaux déjà dédoublonnés. */
export interface SelectableDay {
  readonly date: CalendarDate;
  readonly slots: readonly AvailabilitySlot[];
}

/**
 * Les créneaux d'une journée, **un par heure de début**, du plus tôt au plus tard.
 *
 * Sans préférence de praticien, l'API rend un créneau *par praticien libre* :
 * deux esthéticiennes disponibles à 09:00 donnent deux créneaux à 09:00. Les
 * afficher tels quels poserait deux boutons « 09:00 » côte à côte, entre
 * lesquels la cliente n'a aucun moyen de choisir — elle a demandé une heure, pas
 * une personne. On n'en garde qu'un ; le premier rendu par le serveur, dont
 * l'ordre porte déjà sa propre logique d'affectation.
 *
 * Le tri passe par `Date.parse` et non par une comparaison de chaînes : rien
 * dans `utcInstantSchema` ne garantit que deux instants soient écrits avec la
 * même précision, et `…T09:00:00Z` se classerait après `…T09:00:00.000Z` alors
 * qu'ils désignent le même moment.
 */
export function distinctSlotTimes(
  slots: readonly AvailabilitySlot[],
): readonly AvailabilitySlot[] {
  const firstByStart = new Map<string, AvailabilitySlot>();

  for (const slot of slots) {
    if (!firstByStart.has(slot.startsAt)) {
      firstByStart.set(slot.startsAt, slot);
    }
  }

  return [...firstByStart.values()].sort(
    (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
  );
}

/** La réponse de disponibilité, mise en forme pour le sélecteur. */
export function selectableDays(days: readonly DayAvailability[]): readonly SelectableDay[] {
  return days.map((day) => ({ date: day.date, slots: distinctSlotTimes(day.slots) }));
}

/** Les journées qui ont quelque chose à proposer — les seules qu'on peut retenir. */
export function openDays(days: readonly SelectableDay[]): readonly SelectableDay[] {
  return days.filter((day) => day.slots.length > 0);
}

/**
 * La journée effectivement affichée, choisie **parmi les journées ouvertes**.
 *
 * Elle est cherchée dans le rechargement en cours, jamais conservée telle
 * quelle : entre deux passages, la dernière place de la journée choisie a pu
 * partir. S'y tenir laisserait un sélecteur pointant une option qui n'existe
 * plus au-dessus d'une liste vide, sans un mot. On retombe sur la première
 * journée encore ouverte.
 *
 * L'appelant passe les journées **déjà filtrées** par `openDays`. Refiltrer ici
 * referait, à chaque rendu, un travail que le composant mémoïse déjà — et,
 * surtout, laisserait planer un doute sur laquelle des deux listes fait foi.
 */
export function resolveActiveDay(
  open: readonly SelectableDay[],
  selectedDate: CalendarDate | null,
): SelectableDay | null {
  return open.find((day) => day.date === selectedDate) ?? open[0] ?? null;
}

// ---------------------------------------------------------------------------
// La grille de créneaux — docs/design/appointments/keyboard-navigation.md
// ---------------------------------------------------------------------------

/**
 * Les lignes de la grille : les moments de la journée.
 *
 * Le document de conception les nomme, et ce n'est pas un habillage. Une
 * journée de salon fait facilement trente créneaux ; les présenter en une seule
 * suite oblige à tout lire pour trouver « un début d'après-midi ». Les moments
 * donnent au clavier un axe vertical qui saute de bloc en bloc plutôt que de
 * quart d'heure en quart d'heure.
 */
export const SLOT_ROW_LABELS = ['Matin', 'Après-midi', 'Soir'] as const;

export type SlotRowLabel = (typeof SLOT_ROW_LABELS)[number];

export interface SlotRow {
  readonly label: SlotRowLabel;
  readonly slots: readonly AvailabilitySlot[];
}

/** Première heure de l'après-midi et première heure du soir, horloge du salon. */
const AFTERNOON_FROM_HOUR = 12;
const EVENING_FROM_HOUR = 18;

/**
 * L'heure qu'affiche l'horloge du salon à cet instant, de 0 à 23.
 *
 * `hourCycle: 'h23'` et non la locale d'affichage : c'est un nombre pour
 * comparer, pas un texte pour lire, et `fr-FR` rendrait « 24 » à minuit.
 */
function hourInTimeZone(instant: string, timeZone: TimeZone): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));

  return Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
}

/**
 * Les créneaux d'une journée, répartis en lignes de grille.
 *
 * Une ligne vide n'est **pas** rendue : une grille qui annoncerait « Soir »
 * au-dessus de rien ferait chercher des créneaux qui n'existent pas.
 */
export function slotRows(
  slots: readonly AvailabilitySlot[],
  timeZone: TimeZone,
): readonly SlotRow[] {
  const buckets: Record<SlotRowLabel, AvailabilitySlot[]> = {
    Matin: [],
    'Après-midi': [],
    Soir: [],
  };

  for (const slot of slots) {
    const hour = hourInTimeZone(slot.startsAt, timeZone);
    const label: SlotRowLabel =
      hour < AFTERNOON_FROM_HOUR ? 'Matin' : hour < EVENING_FROM_HOUR ? 'Après-midi' : 'Soir';

    buckets[label].push(slot);
  }

  return SLOT_ROW_LABELS.filter((label) => buckets[label].length > 0).map((label) => ({
    label,
    slots: buckets[label],
  }));
}

/** Position d'un créneau dans la grille — ligne, puis rang dans la ligne. */
export interface GridPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * Déplacement demandé par une touche dans la grille.
 *
 * `null` = cette touche ne nous regarde pas ; le composant la laisse au
 * navigateur plutôt que d'avaler une tabulation ou un raccourci système.
 */
export type GridMove = 'previous' | 'next' | 'up' | 'down' | 'rowStart' | 'rowEnd' | 'gridStart' | 'gridEnd';

/** Le tableau des touches de `keyboard-navigation.md`, et rien de plus. */
export function gridMoveForKey(key: string, ctrlKey: boolean): GridMove | null {
  switch (key) {
    case 'ArrowLeft':
      return 'previous';
    case 'ArrowRight':
      return 'next';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Home':
      return ctrlKey ? 'gridStart' : 'rowStart';
    case 'End':
      return ctrlKey ? 'gridEnd' : 'rowEnd';
    default:
      return null;
  }
}

/** Le rang le plus proche de `column` dans une ligne de `length` créneaux. */
function clampColumn(column: number, length: number): number {
  return Math.min(column, length - 1);
}

/**
 * La position visée par un déplacement, `rowLengths` donnant la taille de chaque
 * ligne.
 *
 * **Le parcours ne boucle pas** — c'est la règle explicite du document de
 * conception, et elle vaut mieux qu'un enroulement : une flèche droite qui
 * ramène silencieusement du dernier créneau du soir au premier du matin fait
 * réserver 09:00 pour 19:45. En bord de grille, la position ne bouge pas.
 *
 * `←` et `→` traversent les lignes plutôt que de s'arrêter à leur bord : ce
 * sont « le créneau précédent » et « le créneau suivant » de la journée, et
 * s'arrêter à midi obligerait à connaître l'axe vertical pour continuer.
 */
export function moveInGrid(
  rowLengths: readonly number[],
  from: GridPosition,
  move: GridMove,
): GridPosition {
  const lastRow = rowLengths.length - 1;

  if (lastRow < 0) {
    return from;
  }

  const row = Math.min(Math.max(from.row, 0), lastRow);
  const column = clampColumn(Math.max(from.column, 0), rowLengths[row] ?? 1);

  switch (move) {
    case 'previous':
      if (column > 0) {
        return { row, column: column - 1 };
      }

      return row === 0 ? { row, column } : { row: row - 1, column: (rowLengths[row - 1] ?? 1) - 1 };
    case 'next':
      if (column < (rowLengths[row] ?? 1) - 1) {
        return { row, column: column + 1 };
      }

      return row === lastRow ? { row, column } : { row: row + 1, column: 0 };
    case 'up':
      return row === 0 ? { row, column } : { row: row - 1, column: clampColumn(column, rowLengths[row - 1] ?? 1) };
    case 'down':
      return row === lastRow
        ? { row, column }
        : { row: row + 1, column: clampColumn(column, rowLengths[row + 1] ?? 1) };
    case 'rowStart':
      return { row, column: 0 };
    case 'rowEnd':
      return { row, column: (rowLengths[row] ?? 1) - 1 };
    case 'gridStart':
      return { row: 0, column: 0 };
    case 'gridEnd':
      return { row: lastRow, column: (rowLengths[lastRow] ?? 1) - 1 };
  }
}

// ---------------------------------------------------------------------------
// La barre de dates — keyboard-navigation.md, « Barre de dates »
// ---------------------------------------------------------------------------

/**
 * Une journée de la barre de dates.
 *
 * `slotCount` vaut `null` tant que la réponse n'est pas là. Ce n'est pas un
 * zéro déguisé : « on ne sait pas encore » et « c'est complet » ne se rendent
 * ni ne se parcourent pareil, et c'est exactement ce qui permet à la barre de
 * rester opérable pendant le chargement — `states.md` étape 3, *« en gardant la
 * barre de dates interactive pour changer de jour sans attendre »*.
 */
export interface DateBarDay {
  readonly date: CalendarDate;
  readonly slotCount: number | null;
}

/**
 * Les journées de la barre, dans l'ordre.
 *
 * Deux sources, et une seule à la fois : tant que la réponse manque, la fenêtre
 * civile calculée par `calendarWindow` — des dates, que le navigateur sait
 * poser sans personne ; dès qu'elle est là, la réponse elle-même, qui rend une
 * entrée par jour demandé, journées complètes comprises (`slots: []`). Prendre
 * la fenêtre dans les deux cas obligerait à inventer un compte pour une date
 * dont le serveur n'a rien dit.
 */
export function dateBarDays(
  dates: readonly CalendarDate[],
  days: readonly SelectableDay[] | null,
): readonly DateBarDay[] {
  return days === null
    ? dates.map((date) => ({ date, slotCount: null }))
    : days.map((day) => ({ date: day.date, slotCount: day.slots.length }));
}

/**
 * Une journée sur laquelle le clavier peut se poser.
 *
 * Une journée complète reste **affichée** — le serveur la rend vide plutôt que
 * de l'omettre précisément pour qu'on puisse écrire « complet » plutôt que de
 * laisser un trou —, mais elle est hors du parcours des flèches, comme
 * `keyboard-navigation.md` le prescrit pour tout élément inactif.
 */
export function canSelectDay(day: DateBarDay): boolean {
  return day.slotCount === null || day.slotCount > 0;
}

/** Déplacement demandé par une touche dans la barre de dates. */
export type DateBarMove = 'previous' | 'next' | 'weekBefore' | 'weekAfter';

/** Le tableau « Barre de dates » de `keyboard-navigation.md`, et rien de plus. */
export function dateBarMoveForKey(key: string): DateBarMove | null {
  switch (key) {
    case 'ArrowLeft':
      return 'previous';
    case 'ArrowRight':
      return 'next';
    case 'PageUp':
      return 'weekBefore';
    case 'PageDown':
      return 'weekAfter';
    default:
      return null;
  }
}

/** Sept jours — le pas de `PagePréc` / `PageSuiv`. */
const DAYS_IN_WEEK = 7;

/**
 * Le premier rang sélectionnable en partant de `start` dans le sens `step`,
 * sans dépasser `bound` (inclus). `null` s'il n'y en a aucun.
 */
function nearestSelectableDay(
  days: readonly DateBarDay[],
  start: number,
  step: -1 | 1,
  bound: number,
): number | null {
  for (
    let index = start;
    index >= 0 && index < days.length && (step < 0 ? index >= bound : index <= bound);
    index += step
  ) {
    const day = days[index];

    if (day !== undefined && canSelectDay(day)) {
      return index;
    }
  }

  return null;
}

/**
 * Le rang visé par un déplacement dans la barre de dates.
 *
 * **Pas d'enroulement**, comme dans la grille et pour la même raison : une
 * flèche droite qui ramènerait du 14 septembre au 1er ferait réserver dans
 * treize jours ce qu'on croyait réserver demain. En bord de barre, le rang ne
 * bouge pas.
 *
 * Une semaine tombant sur une journée complète ne fait pas échouer le saut : on
 * prend la journée ouverte la plus proche, d'abord dans le sens du déplacement,
 * puis en revenant vers le point de départ. Sans ce repli, `PageSuiv` serait
 * muette une semaine sur deux sur un agenda chargé.
 */
export function moveInDateBar(
  days: readonly DateBarDay[],
  from: number,
  move: DateBarMove,
): number {
  if (days.length === 0) {
    return from;
  }

  const current = Math.min(Math.max(from, 0), days.length - 1);
  const last = days.length - 1;

  switch (move) {
    case 'previous':
      return nearestSelectableDay(days, current - 1, -1, 0) ?? current;
    case 'next':
      return nearestSelectableDay(days, current + 1, 1, last) ?? current;
    case 'weekBefore': {
      const target = Math.max(current - DAYS_IN_WEEK, 0);

      return (
        nearestSelectableDay(days, target, -1, 0) ??
        nearestSelectableDay(days, target + 1, 1, current - 1) ??
        current
      );
    }
    case 'weekAfter': {
      const target = Math.min(current + DAYS_IN_WEEK, last);

      return (
        nearestSelectableDay(days, target, 1, last) ??
        nearestSelectableDay(days, target - 1, -1, current + 1) ??
        current
      );
    }
  }
}
