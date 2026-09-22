/**
 * La semaine de travail d'un praticien, telle que l'écran la lit et la saisit
 * (#53, deuxième critère).
 *
 * ## Aucun instant ici, et c'est le point
 *
 * Les bornes d'une plage récurrente sont des **heures murales** — ce que montre
 * l'horloge du salon. « Ouvre à 09:00 » vaut `08:00Z` en hiver et `07:00Z` en
 * été à Paris : les convertir côté navigateur les figerait sur l'un des deux, et
 * l'agenda glisserait d'une heure six mois par an. Ce module ne manipule donc
 * que des chaînes `HH:MM` et des jours ISO ; la conversion en instants est faite
 * par le serveur, date par date.
 *
 * ## Pourquoi une couche de présentation séparée du composant
 *
 * Nommer un jour, composer les lignes du formulaire, refuser un chevauchement :
 * ce sont des décisions vérifiables sans monter un arbre React ni simuler un
 * routeur. Le composant n'a plus qu'à peindre ce que ces fonctions rendent —
 * même partage que `calendar-grid.ts` pour le planning.
 *
 * Ce module ne porte **que ce que l'éditeur appelle**. Le regroupement par
 * journée et la déduction des coupures méridiennes y ont figuré un temps, sans
 * consommateur : la grille est éditable, elle affiche les lignes de saisie
 * elles-mêmes et non une vue recomposée. Ils reviendront le jour où un écran en
 * lecture seule les demandera — pas avant.
 */

import {
  ISO_WEEKDAYS,
  MAX_STAFF_SCHEDULE_ENTRIES,
  END_OF_DAY_LOCAL_TIME,
  setStaffScheduleRequestSchema,
  type IsoWeekday,
  type Locale,
  type SetStaffScheduleRequest,
  type StaffScheduleEntry,
} from '@spa/shared';

import { weekStartOf, type WeekStart } from './calendar-range';
import { fillMessage, staffWords, STAFF_FALLBACK_LOCALE } from './staff-messages';

/**
 * Les sept jours, dans l'ordre ISO 8601 — lundi ouvre la semaine.
 *
 * Réexportés du contrat plutôt que redéclarés ici : c'est la même liste que celle
 * dont `isoWeekdaySchema` tire son type, et deux écritures de « du lundi au
 * dimanche » sont deux écritures susceptibles de diverger. Le `0`-dimanche de
 * `Date.getDay` n'y apparaît pas, délibérément : `0` est *falsy*, et un seul
 * `?? défaut` mal placé ferait disparaître l'horaire du dimanche sans qu'aucun
 * test de forme ne rougisse.
 */
export { ISO_WEEKDAYS };

/**
 * Les sept jours **dans l'ordre où le salon les lit** — #848, deuxième critère.
 *
 * `ISO_WEEKDAYS` reste la liste canonique du contrat, lundi en tête : c'est elle
 * qui numérote les plages, et elle ne bouge pas. Ce qui bouge est l'ordre dans
 * lequel la grille de saisie les **présente**, et il suit la région de
 * l'établissement — un salon de Boston ouvre sa semaine le dimanche, y compris
 * quand une gérante francophone la saisit.
 *
 * Aucun numéro n'est réécrit au passage : la rotation ne change que l'ordre du
 * rendu, si bien qu'une plage enregistrée le dimanche reste `weekday: 7` des
 * deux côtés du comptoir.
 */
export function weekdaysFrom(weekStart: WeekStart): readonly IsoWeekday[] {
  // `weekStart` est en numérotation `Date.getUTCDay` — `0` dimanche —, quand les
  // jours du contrat sont en ISO 8601 — `7` dimanche. Le dimanche est le seul
  // écart entre les deux, et c'est celui-là qu'on ramène.
  const first: IsoWeekday = weekStart === 0 ? 7 : 1;
  const index = ISO_WEEKDAYS.indexOf(first);

  return [...ISO_WEEKDAYS.slice(index), ...ISO_WEEKDAYS.slice(0, index)];
}

/** Les sept jours dans l'ordre de la région de l'établissement. */
export function weekdaysForRegion(
  countryCode?: string | null | undefined,
): readonly IsoWeekday[] {
  return weekdaysFrom(weekStartOf(countryCode));
}

/**
 * Le jour, tel qu'on l'écrit dans la grille.
 *
 * Les libellés viennent du catalogue `admin-staff`, clés `weekdays.1` à
 * `weekdays.7` — les numéros ISO, `7` pour dimanche. Le repli nomme le jour par
 * son numéro : un `0` venu d'un `Date.getDay` mal converti et forcé au type s'y
 * voit, là où un `undefined` laissé filer écrirait « undefined » en toutes
 * lettres dans la grille.
 */
export function weekdayLabel(
  weekday: IsoWeekday,
  locale: Locale = STAFF_FALLBACK_LOCALE,
): string {
  const words = staffWords(locale);
  const label = (words.weekdays as Readonly<Record<string, string>>)[String(weekday)];

  return label === undefined || label === ''
    ? fillMessage(words.weekdayFallback, { weekday: String(weekday) })
    : label;
}

/**
 * Le même jour, **tel qu'on l'insère au fil d'une phrase** — « la plage du
 * lundi », « the Monday range ».
 *
 * Une seconde table plutôt qu'une mise en bas de casse : le français écrit les
 * jours en minuscules au fil du texte, l'anglais garde la capitale. Un
 * `toLocaleLowerCase` aurait rendu « the monday range », et c'est exactement le
 * genre d'écart qu'une règle unique produit sur deux langues qui n'ont pas la
 * même typographie. Même arbitrage que les deux tables de
 * `lib/appointment-status.ts`.
 */
export function weekdayLabelInSentence(
  weekday: IsoWeekday,
  locale: Locale = STAFF_FALLBACK_LOCALE,
): string {
  const words = staffWords(locale);
  const label = (words.weekdaysInSentence as Readonly<Record<string, string>>)[String(weekday)];

  return label === undefined || label === ''
    ? fillMessage(words.weekdayFallback, { weekday: String(weekday) })
    : label;
}

/** Une plage telle que le formulaire la tient — deux champs de texte et un jour. */
export interface ScheduleRow {
  /**
   * Clé de rendu **stable**, jamais l'index du tableau : une ligne retirée au
   * milieu ferait sinon glisser l'état de saisie de toutes les suivantes.
   */
  readonly id: string;
  readonly weekday: IsoWeekday;
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Ordonne deux plages par heure de début — `HH:MM` se compare lexicalement.
 *
 * Lexicalement et non en minutes : `HH:MM` est zéro-comblé, si bien que l'ordre
 * des chaînes **est** l'ordre des heures. Convertir d'abord n'apporterait rien et
 * échouerait sur la ligne à demi remplie que le formulaire porte le temps d'une
 * frappe.
 */
function byStart(left: StaffScheduleEntry, right: StaffScheduleEntry): number {
  return left.startsAt < right.startsAt ? -1 : left.startsAt > right.startsAt ? 1 : 0;
}

/** L'état initial du formulaire, à partir de ce que l'API a rendu. */
export function rowsFromEntries(entries: readonly StaffScheduleEntry[]): ScheduleRow[] {
  return [...entries]
    .sort((left, right) => (left.weekday === right.weekday ? byStart(left, right) : left.weekday - right.weekday))
    .map((entry, index) => ({
      id: `${String(entry.weekday)}-${entry.startsAt}-${entry.endsAt}-${String(index)}`,
      weekday: entry.weekday,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
    }));
}

/**
 * Ce qui se retourne d'une validation de grille — un corps prêt à partir, ou le
 * message à afficher **sur la ligne fautive**.
 *
 * `rowId` est ce qui permet au composant de poser l'erreur sous le champ
 * concerné plutôt qu'en bloc en haut de page (web-frontend §4). `null` quand la
 * faute porte sur l'ensemble — un chevauchement met en cause deux lignes, pas
 * une.
 */
export type ScheduleValidation =
  | { readonly ok: true; readonly request: SetStaffScheduleRequest }
  | { readonly ok: false; readonly rowId: string | null; readonly message: string };

/**
 * La grille saisie, jugée par **le schéma du contrat partagé** — jamais par une
 * règle réécrite ici.
 *
 * `setStaffScheduleRequestSchema` porte déjà le non-recouvrement, le plafond de
 * plages et l'ordre des bornes ; l'API rejouera exactement le même verdict. Ce
 * qui reste à faire côté écran est de traduire le premier refus en message posé
 * au bon endroit — et de repérer, avant Zod, la ligne restée vide, que le schéma
 * ne saurait rattacher à personne.
 */
export function validateScheduleRows(
  rows: readonly ScheduleRow[],
  locale: Locale = STAFF_FALLBACK_LOCALE,
): ScheduleValidation {
  const words = staffWords(locale).schedule;
  const incomplete = rows.find((row) => row.startsAt === '' || row.endsAt === '');

  if (incomplete !== undefined) {
    return { ok: false, rowId: incomplete.id, message: words.incomplete };
  }

  if (rows.length > MAX_STAFF_SCHEDULE_ENTRIES) {
    return {
      ok: false,
      rowId: null,
      message: fillMessage(words.tooMany, { max: String(MAX_STAFF_SCHEDULE_ENTRIES) }),
    };
  }

  const entries = rows.map((row) => ({
    weekday: row.weekday,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  }));

  /*
   * Le verdict est **celui du schéma**, et lui seul — la phrase vient du
   * catalogue.
   *
   * `setStaffScheduleRequestSchema` porte les deux règles qui restent : une
   * plage finit après avoir commencé, et deux plages du même jour ne se
   * recouvrent pas. Les rejouer ici avant lui les ferait diverger — et les
   * rejouer *dans le mauvais ordre* mentirait : une plage saisie « 12:00 –
   * 10:00 » à côté d'une journée ouverte se lit comme un recouvrement pour
   * `staffScheduleEntriesOverlap`, qui compare des bornes sans se demander
   * laquelle précède l'autre. L'opératrice aurait alors cherché une plage en
   * double là où elle avait inversé deux heures.
   *
   * Ce qui reste à faire ici est donc de **nommer** le refus du schéma sans
   * recopier son message, qui est un littéral français du contrat partagé : il
   * aurait parlé français sous une grille d'horaires en anglais.
   */
  const parsed = setStaffScheduleRequestSchema.safeParse({ entries });

  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }

  const issue = parsed.error.issues[0];
  // `issues[0].path` vaut `['entries', <index>, <champ>]` sur une faute de
  // ligne, et `['entries']` sur une faute d'ensemble : le second segment
  // désigne donc la ligne, quand il existe.
  const index = typeof issue?.path[1] === 'number' ? issue.path[1] : null;

  return {
    ok: false,
    rowId: index === null ? null : (rows[index]?.id ?? null),
    message: scheduleIssueMessage(issue, index, words),
  };
}

/**
 * La phrase du catalogue qui dit **ce que** le schéma vient de refuser.
 *
 * Les deux règles métier du contrat sont des `refine`, donc des issues `custom`,
 * et c'est ce qui les distingue d'une borne illisible : celle de la ligne dit
 * qu'une fin précède son début, celle de l'ensemble que deux plages du même jour
 * se recouvrent. Tout le reste est une faute de **forme** — une borne qui n'est
 * pas `HH:MM` —, que le formulaire écarte déjà en ne servant que des
 * `<input type="time">`, et qui garde donc le repli.
 */
function scheduleIssueMessage(
  issue: { readonly code?: string } | undefined,
  index: number | null,
  words: ReturnType<typeof staffWords>['schedule'],
): string {
  if (issue?.code !== 'custom') {
    return words.invalid;
  }

  return index === null ? words.overlap : words.endBeforeStart;
}

/**
 * Une plage neuve pour un jour donné — celle que propose le bouton « Ajouter ».
 *
 * `09:00 – 12:00` plutôt que deux champs vides : la journée type d'un salon
 * commence le matin, et pré-remplir épargne deux saisies sur trois. La borne
 * haute reste modifiable, `24:00` compris — c'est la seule façon d'écrire minuit
 * de fin de journée.
 */
export function newScheduleRow(weekday: IsoWeekday, seed: string): ScheduleRow {
  return { id: `${String(weekday)}-${seed}`, weekday, startsAt: '09:00', endsAt: '12:00' };
}

/** Le littéral de minuit de fin de journée, rappelé à la saisie. */
export const SCHEDULE_END_OF_DAY = END_OF_DAY_LOCAL_TIME;
