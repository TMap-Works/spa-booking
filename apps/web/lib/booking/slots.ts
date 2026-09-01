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
 * La journée effectivement affichée.
 *
 * Elle est cherchée **dans le rechargement en cours**, jamais conservée telle
 * quelle : entre deux passages, la dernière place de la journée choisie a pu
 * partir. S'y tenir laisserait un sélecteur pointant une option qui n'existe
 * plus au-dessus d'une liste vide, sans un mot. On retombe sur la première
 * journée encore ouverte.
 */
export function resolveActiveDay(
  days: readonly SelectableDay[],
  selectedDate: CalendarDate | null,
): SelectableDay | null {
  const open = openDays(days);

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
