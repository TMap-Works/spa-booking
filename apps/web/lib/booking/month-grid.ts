/**
 * La trame du calendrier mensuel de réservation (#827).
 *
 * Le choix de la date était une **bande de journées à faire défiler** : quatorze
 * pastilles en ligne, dont trois et demie visibles à 360 px, et « Voir plus de
 * jours » pour en obtenir trente et une. Le CDC §1.4 prescrit pourtant un
 * « calendrier de disponibilité temps réel », et
 * `docs/design/appointments/wireframes.md` étape 3 en dessine un : « ‹ août 2026 › »,
 * une ligne `L M M J V S D`, la date retenue mise en avant.
 *
 * Ce module ne rend rien. Il tient la seule chose qu'un calendrier ait de
 * délicat — l'arithmétique des dates civiles et le déplacement du clavier — hors
 * du composant, pour qu'elle s'éprouve sans monter de DOM. Les mêmes raisons que
 * [`slots.ts`](slots.ts), et le même voisinage : les dates civiles de base
 * (`addCalendarDays`, `formatCalendarMonth`) restent dans
 * [`calendar.ts`](calendar.ts).
 *
 * ## Une date civile, jamais un instant
 *
 * Tout ce fichier raisonne en `YYYY-MM-DD` de l'établissement. C'est le
 * référentiel de `availabilityQuerySchema`, et le seul dans lequel « le 1er
 * octobre » veut dire la même chose pour la cliente et pour le moteur de
 * disponibilité. La comparaison de deux dates est donc une comparaison de
 * chaînes : sur un `YYYY-MM-DD` zéro-complété, l'ordre lexicographique **est**
 * l'ordre chronologique, et cela évite d'ouvrir un `Date` — donc un fuseau —
 * pour savoir laquelle des deux précède l'autre.
 *
 * ## La langue (#846)
 *
 * Ce module ne lit pas le catalogue : c'est une règle de l'épique, et elle a sa
 * raison d'être ici — il n'importe pas React, et le faire dépendre d'un contexte
 * de requête le rendrait inéprouvable sans DOM. Les sept colonnes de l'en-tête
 * sont donc des **clés** (`WEEKDAY_KEYS`) que le calendrier traduit, et le seul
 * texte que ce fichier produit encore — le nom du mois — vient d'`Intl`, à qui
 * l'on passe le `DisplayLocale` reçu.
 */

import { MAX_AVAILABILITY_RANGE_DAYS, isoWeekdayOf, type CalendarDate } from '@spa/shared';

import type { DisplayLocale } from '@/lib/format';

import { addCalendarDays, formatCalendarMonth } from './calendar';

/**
 * Un mois civil, `YYYY-MM`.
 *
 * Un type distinct de `CalendarDate` bien qu'il lui ressemble : les deux se
 * confondraient sans cela dans toutes les signatures de ce fichier, et
 * `firstDayOfMonth('2026-10-01')` rendrait « 2026-10-01 » sans que rien ne
 * proteste. Il reste une chaîne — la marque est nominale, portée par la
 * documentation et par les fonctions qui le produisent.
 */
export type CalendarMonth = string;

/** Sept jours — la largeur d'une ligne de calendrier. */
export const DAYS_IN_WEEK = 7;

/**
 * Les sept colonnes de l'en-tête, du lundi au dimanche — **des clés**, jamais
 * des mots (#846).
 *
 * La semaine commence le **lundi**, et la langue n'y touche pas : c'est la
 * numérotation ISO 8601 que le contrat a déjà retenue (`ISO_WEEKDAYS`, « la
 * semaine du calendrier public commence le lundi »), celle du wireframe —
 * `L M M J V S D` —, et un repère de l'établissement plutôt que du lecteur.
 *
 * Le calendrier en tire **deux** libellés par colonne : l'initiale, visible, et
 * le nom complet, porté par le `columnheader` accessible — trois colonnes
 * s'appellent « M » ou « S » à l'écran, et un lecteur d'écran qui les énonce
 * ainsi ne dit rien.
 *
 * Ces quatorze libellés vivent dans le catalogue et non dans `Intl`, pour la
 * raison qu'expose `spokenTime` dans le sélecteur de créneau : la forme abrégée
 * d'une locale dépend de la version d'ICU du moteur — « lun. », « lu », « L »
 * selon les versions —, si bien que l'en-tête différerait entre la CI et le
 * poste, et avec lui les requêtes par nom accessible. Sept mots par langue ne
 * changent pas.
 */
export const WEEKDAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

/** Une colonne de l'en-tête, telle que le catalogue la nomme. */
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/** Le mois auquel une date appartient. */
export function monthOf(date: CalendarDate): CalendarMonth {
  return date.slice(0, 7);
}

/** Le premier jour d'un mois. */
export function firstDayOfMonth(month: CalendarMonth): CalendarDate {
  return `${month}-01`;
}

/**
 * Le mois décalé de `delta` mois.
 *
 * Le calcul se fait sur un rang de mois absolu — `année × 12 + mois` — et non
 * par un `Date` : `new Date(2026, 0, 31)` avancé d'un mois rend le 3 mars, la
 * bibliothèque standard reportant le débordement du 31 février. Un calendrier
 * qui saute février une année sur quatre serait un bug difficile à voir.
 */
export function addMonths(month: CalendarMonth, delta: number): CalendarMonth {
  const rank = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const year = Math.floor(rank / 12);
  const index = rank - year * 12 + 1;

  return `${String(year).padStart(4, '0')}-${String(index).padStart(2, '0')}`;
}

/** Le dernier jour d'un mois — la veille du premier jour du suivant. */
export function lastDayOfMonth(month: CalendarMonth): CalendarDate {
  return addCalendarDays(firstDayOfMonth(addMonths(month, 1)), -1);
}

/** Le quantième, tel qu'il s'écrit dans la case — « 17 ». */
export function dayOfMonth(date: CalendarDate): number {
  return Number(date.slice(8, 10));
}

/**
 * Le mois tel qu'il se lit — « septembre 2026 ».
 *
 * Un mince relais sur `formatCalendarMonth`, qui met en forme une **date** :
 * l'année y est portée parce qu'un calendrier ouvert en décembre navigue vers
 * janvier, et que « janvier » seul ne dirait pas lequel.
 */
export function formatMonth(month: CalendarMonth, display?: DisplayLocale): string {
  return formatCalendarMonth(firstDayOfMonth(month), display);
}

/**
 * Une ligne du calendrier : sept cases, du lundi au dimanche.
 *
 * `null` est une case **hors du mois** — le 31 août sur la première ligne de
 * septembre. Elle est rendue vide plutôt que remplie par le jour du mois voisin :
 * la fenêtre chargée est celle du mois visible, et une case d'août y afficherait
 * une disponibilité qu'on n'a pas demandée.
 */
export type CalendarWeek = readonly (CalendarDate | null)[];

/**
 * Les lignes d'un mois, alignées sur les colonnes de l'en-tête.
 *
 * Le nombre de lignes suit le mois — quatre pour un février commençant un lundi,
 * six pour un mois de 31 jours commençant un samedi — plutôt que d'être fixé à
 * six. Une sixième ligne vide ajoutée par principe coûterait 44 px de hauteur sur
 * un téléphone, là où l'enjeu du ticket est précisément de remonter la grille des
 * créneaux au-dessus de la ligne de flottaison.
 */
export function monthWeeks(month: CalendarMonth): readonly CalendarWeek[] {
  const first = firstDayOfMonth(month);
  const last = lastDayOfMonth(month);
  const lead = isoWeekdayOf(first) - 1;
  const weeks: CalendarWeek[] = [];

  for (let start = -lead; start <= dayOfMonth(last) - 1; start += DAYS_IN_WEEK) {
    weeks.push(
      Array.from({ length: DAYS_IN_WEEK }, (_unused, column) => {
        const offset = start + column;

        return offset < 0 || offset > dayOfMonth(last) - 1 ? null : addCalendarDays(first, offset);
      }),
    );
  }

  return weeks;
}

/**
 * La fenêtre dans laquelle une date se choisit — première et dernière journée
 * réservables, bornes comprises.
 */
export interface BookingWindow {
  readonly first: CalendarDate;
  readonly last: CalendarDate;
}

/**
 * La fenêtre de réservation ouverte à partir d'aujourd'hui.
 *
 * Elle **ne s'élargit pas** avec le passage au calendrier : c'est exactement
 * l'horizon que « Voir plus de jours » atteignait déjà, `MAX_AVAILABILITY_RANGE_DAYS`
 * journées bornes comprises. Le ticket remplace la présentation du choix, pas la
 * profondeur d'agenda que le produit ouvre — celle-ci est une décision produit,
 * et le contrat plafonne de toute façon une requête à cette même valeur.
 *
 * `- 1` n'est pas une marge : `calendarDaysBetween` compte **les deux bornes**,
 * si bien qu'un `to` posé à `from + 31` demande trente-deux journées et se fait
 * refuser par `availabilityQuerySchema`. C'est le calcul que la page de report
 * faisait déjà pour sa fenêtre élargie.
 */
export function bookingWindow(today: CalendarDate): BookingWindow {
  return { first: today, last: addCalendarDays(today, MAX_AVAILABILITY_RANGE_DAYS - 1) };
}

/** La date rognée aux bornes de la fenêtre. */
export function clampToWindow(date: CalendarDate, window: BookingWindow): CalendarDate {
  return date < window.first ? window.first : date > window.last ? window.last : date;
}

/** La date tombe-t-elle dans la fenêtre de réservation ? */
export function isWithinWindow(date: CalendarDate, window: BookingWindow): boolean {
  return date >= window.first && date <= window.last;
}

/** Le mois se laisse-t-il atteindre par la navigation ? */
export function isNavigableMonth(month: CalendarMonth, window: BookingWindow): boolean {
  return month >= monthOf(window.first) && month <= monthOf(window.last);
}

/**
 * La plage de dates à demander pour afficher `month` — `null` si le mois est
 * entièrement hors de la fenêtre de réservation.
 *
 * C'est le remplaçant de la fenêtre glissante de quatorze jours : on ne demande
 * plus « les N jours à partir d'aujourd'hui » mais **le mois qu'on regarde**,
 * rogné aux deux bouts. Le mois courant part donc d'aujourd'hui et non du 1er —
 * personne ne réserve dans le passé, et l'agenda de la première quinzaine
 * coûterait au moteur de disponibilité un calcul que rien n'affiche.
 *
 * La plage rendue tient toujours dans `MAX_AVAILABILITY_RANGE_DAYS` : un mois
 * civil compte trente et un jours au plus, ce qui est exactement le plafond du
 * contrat, bornes comprises.
 */
export function monthRange(
  month: CalendarMonth,
  window: BookingWindow,
): { readonly from: CalendarDate; readonly to: CalendarDate } | null {
  const first = firstDayOfMonth(month);
  const last = lastDayOfMonth(month);
  const from = first < window.first ? window.first : first;
  const to = last > window.last ? window.last : last;

  return from <= to ? { from, to } : null;
}

/**
 * Déplacement demandé par une touche dans le calendrier.
 *
 * `null` = cette touche ne nous regarde pas ; le composant la laisse au
 * navigateur plutôt que d'avaler une tabulation ou un raccourci système.
 */
export type MonthMove =
  | 'previousDay'
  | 'nextDay'
  | 'previousWeek'
  | 'nextWeek'
  | 'weekStart'
  | 'weekEnd'
  | 'previousMonth'
  | 'nextMonth';

/**
 * Le clavier du calendrier.
 *
 * Il prolonge le tableau « Barre de dates » de
 * `docs/design/appointments/keyboard-navigation.md` — `←`/`→` au jour,
 * `PagePréc`/`PageSuiv` au mois — des deux touches qu'une grille bidimensionnelle
 * ajoute à une ligne : `↑`/`↓` à la semaine, et `Début`/`Fin` aux bords de la
 * ligne. C'est le modèle de la grille de créneaux, et celui que le motif
 * « Date Picker Dialog » des ARIA Authoring Practices décrit pour un calendrier.
 *
 * Le document écrivait `PagePréc`/`PageSuiv` « semaine précédente / suivante »
 * sur une bande qui n'avait pas d'axe vertical. Dans un calendrier, la semaine
 * est la ligne — c'est `↑`/`↓` qui la parcourt —, et la page devient le mois,
 * comme l'issue le demande explicitement.
 */
export function monthMoveForKey(key: string): MonthMove | null {
  switch (key) {
    case 'ArrowLeft':
      return 'previousDay';
    case 'ArrowRight':
      return 'nextDay';
    case 'ArrowUp':
      return 'previousWeek';
    case 'ArrowDown':
      return 'nextWeek';
    case 'Home':
      return 'weekStart';
    case 'End':
      return 'weekEnd';
    case 'PageUp':
      return 'previousMonth';
    case 'PageDown':
      return 'nextMonth';
    default:
      return null;
  }
}

/**
 * La date visée par un déplacement, rognée à la fenêtre de réservation.
 *
 * **Le parcours ne boucle pas**, comme dans la grille de créneaux et pour la
 * même raison : une flèche qui ramènerait silencieusement du 30 septembre au 1er
 * ferait réserver un mois plus tôt qu'on ne croit. En bord de fenêtre, la date
 * ne bouge pas — et c'est ce que le composant lit pour éteindre ses chevrons.
 *
 * Les flèches, elles, **traversent** les mois : c'est le comportement d'un
 * calendrier, et s'arrêter au 30 obligerait à connaître `PageSuiv` pour voir le
 * 1er. Le composant suit le mois de la date rendue.
 *
 * Aucune journée n'est sautée, pas même un jour complet : dans une grille de
 * dates, une case qu'on ne peut pas atteindre est une case dont on ne peut pas
 * lire l'état, et « complet » est précisément ce qu'on vient y lire. C'est
 * l'écart avec `moveInDateBar`, qui sautait les journées pleines d'une bande où
 * elles n'avaient rien à dire de plus que leur libellé.
 */
export function moveInMonth(
  from: CalendarDate,
  move: MonthMove,
  window: BookingWindow,
): CalendarDate {
  const target = ((): CalendarDate => {
    switch (move) {
      case 'previousDay':
        return addCalendarDays(from, -1);
      case 'nextDay':
        return addCalendarDays(from, 1);
      case 'previousWeek':
        return addCalendarDays(from, -DAYS_IN_WEEK);
      case 'nextWeek':
        return addCalendarDays(from, DAYS_IN_WEEK);
      case 'weekStart':
        return addCalendarDays(from, -(isoWeekdayOf(from) - 1));
      case 'weekEnd':
        return addCalendarDays(from, DAYS_IN_WEEK - isoWeekdayOf(from));
      case 'previousMonth':
      case 'nextMonth': {
        const month = addMonths(monthOf(from), move === 'previousMonth' ? -1 : 1);
        const last = lastDayOfMonth(month);

        // Le quantième est conservé quand le mois d'arrivée le porte : partir du
        // 31 mars vers avril ne doit pas rendre le 1er mai. Sinon, le dernier
        // jour de ce mois — le geste attendu est « le mois d'avant », pas « un
        // mois plus tôt à trente jours près ».
        return dayOfMonth(from) > dayOfMonth(last)
          ? last
          : `${month}-${String(dayOfMonth(from)).padStart(2, '0')}`;
      }
    }
  })();

  return clampToWindow(target, window);
}
