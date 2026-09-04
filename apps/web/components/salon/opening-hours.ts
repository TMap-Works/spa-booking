import type { OpeningHoursEntry } from '@spa/shared';

/**
 * Présentation des horaires d'ouverture de la vitrine (#343).
 *
 * Logique pure, sans JSX : ce module décide de l'ordre, du regroupement et des
 * libellés, et il se teste comme une fonction — là où la même logique enfouie
 * dans le composant ne se vérifierait qu'à l'œil, sur un rendu.
 *
 * Il ne trie pas : l'API rend déjà les plages par jour ISO croissant puis par
 * heure d'ouverture, et deux tris successifs finissent par diverger sur les cas
 * d'égalité. Il regroupe, ce qui est autre chose — une journée à coupure
 * méridienne porte deux plages et doit s'afficher sur une seule ligne.
 */

/**
 * Les sept jours, en numérotation ISO 8601 : 1 lundi … 7 dimanche.
 *
 * Un `Record` et non un tableau indexé à partir de zéro : l'index d'un tableau
 * ferait du lundi la case `1` et laisserait une case `0` vide, que le premier
 * `.map` afficherait comme un jour sans nom.
 */
export const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: 'Lundi',
  2: 'Mardi',
  3: 'Mercredi',
  4: 'Jeudi',
  5: 'Vendredi',
  6: 'Samedi',
  7: 'Dimanche',
};

/**
 * Les mêmes jours pour `schema.org/DayOfWeek`.
 *
 * En URL absolue plutôt qu'en nom nu : c'est la forme que la documentation de
 * schema.org emploie, et la seule qui reste non ambiguë hors du contexte d'un
 * `@context`.
 */
export const SCHEMA_ORG_WEEKDAYS: Readonly<Record<number, string>> = {
  1: 'https://schema.org/Monday',
  2: 'https://schema.org/Tuesday',
  3: 'https://schema.org/Wednesday',
  4: 'https://schema.org/Thursday',
  5: 'https://schema.org/Friday',
  6: 'https://schema.org/Saturday',
  7: 'https://schema.org/Sunday',
};

/** Une journée d'ouverture, telle que la section « informations pratiques » la rend. */
export interface OpeningDay {
  readonly weekday: number;
  readonly label: string;
  /** Les plages du jour, dans l'ordre où l'API les a rendues. */
  readonly ranges: readonly OpeningHoursEntry[];
}

/**
 * Regroupe les plages par journée, en conservant l'ordre reçu.
 *
 * Un jour absent du tableau est un jour **fermé** : il ne produit pas de ligne.
 * Afficher « Lundi : fermé » demanderait de savoir que le salon a bien voulu
 * dire « fermé » et non « pas encore saisi », et l'API ne distingue pas les
 * deux — elle omet les horaires plutôt que de rendre une semaine vide.
 */
export function groupOpeningHoursByDay(
  entries: readonly OpeningHoursEntry[],
): readonly OpeningDay[] {
  const days: OpeningDay[] = [];
  const byWeekday = new Map<number, OpeningHoursEntry[]>();

  for (const entry of entries) {
    const existing = byWeekday.get(entry.weekday);

    if (existing === undefined) {
      const ranges: OpeningHoursEntry[] = [entry];
      byWeekday.set(entry.weekday, ranges);
      days.push({
        weekday: entry.weekday,
        label: WEEKDAY_LABELS[entry.weekday] ?? `Jour ${String(entry.weekday)}`,
        ranges,
      });
      continue;
    }

    existing.push(entry);
  }

  return days;
}

/**
 * « 09:00 – 12:00 », avec un tiret demi-cadratin et des espaces insécables.
 *
 * L'espace insécable n'est pas une coquetterie : sans lui, un retour à la ligne
 * peut tomber entre l'heure et le tiret, et la plage se lit alors comme deux
 * heures sans rapport.
 */
export function formatOpeningRange(entry: OpeningHoursEntry): string {
  return `${entry.opensAt}\u00a0\u2013\u00a0${entry.closesAt}`;
}
