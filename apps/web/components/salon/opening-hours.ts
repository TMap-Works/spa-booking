import type { Locale, OpeningHoursEntry } from '@spa/shared';

import { formattingLocale, type DisplayLocale } from '@/lib/format';
import en from '@/messages/en/booking.json';
import fr from '@/messages/fr/booking.json';

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
 *
 * ## La langue (#846)
 *
 * Deux natures de mots se croisent ici, et elles ne viennent pas du même
 * endroit :
 *
 * - **les noms de jours** viennent d'`Intl`, jamais d'une table écrite à la
 *   main. Une table de sept noms par langue serait une seconde source de vérité
 *   sur un calendrier que la plateforme connaît déjà, et elle se périmerait à la
 *   première langue ajoutée. L'étiquette BCP 47 passée à `Intl`, elle, vient de
 *   `formattingLocale` (`lib/format.ts`) : c'est le seul endroit du front qui
 *   décide de la région à partir du pays de l'établissement, et le nom d'un jour
 *   n'a pas à en décider autrement que les dates qu'il coiffe ;
 * - **les phrases** — « Fermé », « Ouvert — ferme à 19:00 » — viennent du
 *   catalogue, comme tout ce qu'un humain lit.
 *
 * Ce module est **pur et sans React** : il ne peut appeler aucun crochet. Il lit
 * donc les deux catalogues par import direct, exactement comme `lib/format.ts`
 * pour les mots qu'`Intl` ne sait pas dire et comme `public-exits.tsx` pour son
 * registre de sorties. Le mécanisme est le même, et la raison aussi : trois
 * appelants de ce module vivent hors de l'empreinte de #846 — la carte du salon
 * de l'espace client, le cadre d'accueil de la connexion et la grille horaire
 * des réglages — et un libellé rendu sous forme de clé les aurait cassés tous
 * les trois.
 *
 * Chaque fonction qui écrit un mot reçoit donc un `DisplayLocale` **en dernier
 * paramètre, facultatif**. Le défaut est le français, celui d'avant le ticket :
 * il tombera avec le dernier ticket d'écran de l'épique #843, et `tsc` nommera
 * alors ce qui reste à brancher. Même arbitrage, et mêmes mots, que
 * `FALLBACK_LOCALE` de `lib/format.ts`.
 */

/** Les catalogues, dans les deux langues — la même source que les composants. */
const CATALOG = { fr, en } as const;

/** Le contexte d'affichage employé quand l'appelant n'en passe pas encore. */
const FALLBACK_DISPLAY: DisplayLocale = { locale: 'fr' };

/** Les phrases de cette section du catalogue, dans la langue demandée. */
function words(display: DisplayLocale): (typeof CATALOG)[Locale]['salon']['hours'] {
  return CATALOG[display.locale].salon.hours;
}

/**
 * Le remplacement des paramètres d'un message lu **hors de React**.
 *
 * Même raison, et même forme, que le `fill` de `lib/format.ts` : ce module est
 * fait de fonctions pures, appelées depuis des Server Components et depuis des
 * tests sans DOM, où aucun crochet de `next-intl` n'est disponible. Les messages
 * concernés n'ont qu'un ou deux paramètres et aucune forme plurielle — un
 * remplacement littéral suffit.
 */
function fill(message: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    message,
  );
}

/** Les sept jours, en numérotation ISO — l'ordre de la carte « Horaires ». */
const ISO_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Une semaine de référence dont le premier jour est un lundi.
 *
 * Le 1er janvier 2024 est un lundi : `Date.UTC(2024, 0, weekday)` tombe donc sur
 * le jour ISO `weekday`, de 1 (lundi) à 7 (dimanche), sans qu'aucune table de
 * noms n'ait à être écrite. Lu en UTC, le résultat ne dépend d'aucun fuseau.
 */
function isoWeekdayDate(weekday: number): Date {
  return new Date(Date.UTC(2024, 0, weekday));
}

/**
 * Le nom du jour tel qu'`Intl` l'écrit dans la langue demandée — « lundi »,
 * « Monday ».
 *
 * La **casse est celle de la langue**, et c'est délibéré : le français écrit les
 * jours en minuscules au fil d'une phrase (« ouvre samedi à 10:00 »), l'anglais
 * en capitales (« opens Saturday at 10:00 »). C'est {@link weekdayLabel} qui
 * capitalise pour un emploi autonome, en tête d'une ligne d'horaires.
 *
 * `null` hors des bornes ISO, ou si `Intl` refuse l'étiquette : l'appelant
 * décide alors de son repli plutôt que de recevoir une chaîne inventée.
 */
function weekdayName(weekday: number, display: DisplayLocale): string | null {
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > ISO_WEEK.length) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat(formattingLocale(display.locale, display.countryCode), {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(isoWeekdayDate(weekday));
  } catch {
    return null;
  }
}

/**
 * Le jour tel qu'on l'écrit **seul**, avec un repli qui se voit.
 *
 * Point d'écriture **unique** du repli « jour sans nom » dans `apps/web` (#652).
 * Il n'apparaît jamais en usage normal — la numérotation ISO ne sort pas de
 * 1–7 —, et c'est bien ce qui le rendait dangereux en double : une branche
 * qu'aucun écran n'exerce laisse deux copies diverger sans que rien ne le
 * signale. Or l'une des deux alimentait le nom accessible des 28 champs de la
 * grille horaire des réglages, c'est-à-dire ce qu'un lecteur d'écran annonce.
 *
 * Le nom vient d'`Intl` (#846) ; seul le repli est un message du catalogue,
 * « Jour {weekday} », parce qu'aucun calendrier ne sait nommer un huitième jour.
 *
 * La capitale initiale est posée ici, dans la langue d'affichage : `Intl` rend
 * « lundi » en français, et la carte « Horaires » aligne sept lignes qui
 * commencent par un nom de jour — pas par le milieu d'une phrase.
 *
 * À ne pas confondre avec le `weekdayLabel` de `lib/admin/staff-schedule.ts`,
 * qui reste distinct : celui-là est typé sur `IsoWeekday` et traite
 * délibérément la case 0 comme un jour manquant. Les rapprocher changerait son
 * comportement.
 */
export function weekdayLabel(
  weekday: number,
  display: DisplayLocale = FALLBACK_DISPLAY,
): string {
  const name = weekdayName(weekday, display);

  if (name === null) {
    return fill(words(display).unknownDay, { weekday: String(weekday) });
  }

  const tag = formattingLocale(display.locale, display.countryCode);

  return `${name.charAt(0).toLocaleUpperCase(tag)}${name.slice(1)}`;
}

/**
 * Les mêmes jours pour `schema.org/DayOfWeek`.
 *
 * En URL absolue plutôt qu'en nom nu : c'est la forme que la documentation de
 * schema.org emploie, et la seule qui reste non ambiguë hors du contexte d'un
 * `@context`. Ce sont des **identifiants**, pas des mots : ils ne se traduisent
 * pas, quelle que soit la langue de la page (#846).
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
  display: DisplayLocale = FALLBACK_DISPLAY,
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
        label: weekdayLabel(entry.weekday, display),
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
 *
 * Aucun mot ici, et donc rien à traduire (#846) : deux heures murales telles que
 * le salon les a saisies, séparées par de la ponctuation.
 */
export function formatOpeningRange(entry: OpeningHoursEntry): string {
  return `${entry.opensAt}\u00a0\u2013\u00a0${entry.closesAt}`;
}

// ---------------------------------------------------------------------------
// La semaine entière, jours fermés compris — BM-VITRINE-03 (#1046)
// ---------------------------------------------------------------------------

/** Minutes d'une journée civile — la valeur de `24:00`, borne haute légitime. */
const MINUTES_IN_CIVIL_DAY = 24 * 60;

/**
 * Minutes depuis minuit d'une heure murale « HH:MM ».
 *
 * Écrit ici plutôt qu'emprunté à `lib/admin/appointment-desk.ts`, qui en tient
 * déjà un : ce module-ci est chargé par la **vitrine publique**, dont le budget
 * de LCP est de 2,5 s en 4G (skill web-frontend §7), et importer un module du
 * back-office ferait entrer tout son graphe de dépendances dans ce chemin-là.
 * Quelques lignes de lecture valent mieux qu'un couplage de couches.
 *
 * `24:00` est traité à part, comme dans le contrat : c'est la borne haute d'un
 * salon ouvert jusqu'à minuit (`scheduleEndTimeSchema`), et non une heure de
 * début. Une valeur illisible rend `null` et sera ignorée — la validation du
 * contrat l'a déjà refusée à l'écriture, et la vitrine ne doit pas blanchir sur
 * une donnée héritée.
 */
function wallMinutes(time: string): number | null {
  if (time === '24:00') {
    return MINUTES_IN_CIVIL_DAY;
  }

  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);

  if (match === null) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

/** Une journée de la semaine, telle que la carte « Horaires » la rend. */
export interface ScheduledDay {
  readonly weekday: number;
  readonly label: string;
  /** Les plages du jour — **vide** quand le salon est fermé ce jour-là. */
  readonly ranges: readonly OpeningHoursEntry[];
}

/**
 * La semaine complète, du lundi au dimanche, jours fermés compris (BM-VITRINE-03).
 *
 * ## Ce qui change, et la raison qui l'autorise
 *
 * `groupOpeningHoursByDay` ci-dessus n'affiche que les jours reçus, au motif —
 * exact — que l'API ne distingue pas « le salon ferme le lundi » de « le salon
 * n'a pas encore saisi ses horaires ». Elle reste employée par les données
 * structurées, qui ne doivent affirmer que ce qui a été publié.
 *
 * Pour un lecteur humain, la distinction se tranche un cran plus haut : dès que
 * le salon a publié **une** plage, sa semaine est saisie, et un jour qui n'y
 * figure pas est un jour fermé. C'est la seule lecture qui rende la carte utile
 * — sept lignes dont les fermetures sont écrites — sans rien inventer, puisque
 * le cas « rien de saisi » est écarté par le tableau vide.
 *
 * Un tableau **vide** rend donc un tableau vide, et non sept jours « Fermé » :
 * un salon qui n'a rien renseigné n'est pas un salon fermé toute la semaine.
 *
 * Le mot « Fermé » lui-même n'est pas écrit ici : ce que rend cette fonction est
 * une journée **sans plage**, et c'est la carte qui la nomme, avec le catalogue
 * sous la main (#846).
 */
export function weekSchedule(
  entries: readonly OpeningHoursEntry[],
  display: DisplayLocale = FALLBACK_DISPLAY,
): readonly ScheduledDay[] {
  if (entries.length === 0) {
    return [];
  }

  return ISO_WEEK.map((weekday) => ({
    weekday,
    label: weekdayLabel(weekday, display),
    ranges: entries.filter((entry) => entry.weekday === weekday),
  }));
}

// ---------------------------------------------------------------------------
// L'état d'ouverture, calculé pour maintenant — BM-VITRINE-02 (#1046)
// ---------------------------------------------------------------------------

/** L'horloge du salon : le jour ISO et l'heure qu'il est **chez lui**. */
export interface SalonClock {
  readonly weekday: number;
  /** Minutes écoulées depuis minuit, dans le fuseau du salon. */
  readonly minutes: number;
}

/** Les abréviations qu'`Intl` rend en `en-US`, ramenées à la numérotation ISO. */
const ISO_WEEKDAY_OF: Readonly<Record<string, number>> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/**
 * L'instant courant lu à l'horloge du salon.
 *
 * `hourCycle: 'h23'` et non `hour12: false` — les deux se contredisent sur
 * certains moteurs, et `hour12: false` seul peut rendre `24` pour minuit, ce qui
 * placerait 00 h 15 après la fermeture de la veille. Même précaution que
 * `lib/admin/calendar-grid.ts`, pour la même raison.
 *
 * `en-US` et non la locale d'affichage : ce sont les clés d'un `Record` qu'on
 * lit, pas un texte qu'on montre. La langue de la page n'a donc rien à y faire
 * (#846) — la changer casserait la table ci-dessus. Un fuseau inconnu fait lever
 * `Intl` — la fonction rend alors `null`, et l'appelant se tait plutôt que
 * d'annoncer un état d'ouverture faux.
 */
export function salonClock(timezone: string, now: Date): SalonClock | null {
  let parts: readonly Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return null;
  }

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const weekday = ISO_WEEKDAY_OF[value('weekday')];
  const hour = Number(value('hour'));
  const minute = Number(value('minute'));

  if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  return { weekday, minutes: hour * 60 + minute };
}

/** Ce que le bandeau d'identité écrit de l'ouverture du salon. */
export interface OpeningStatus {
  /** Le salon est-il ouvert **en ce moment**, à son horloge à lui ? */
  readonly open: boolean;
  /** « Ouvert — ferme à 19:00 », « Fermé — ouvre demain à 10:00 », « Fermé ». */
  readonly label: string;
}

/**
 * L'état d'ouverture du salon **maintenant**, dans son fuseau (BM-VITRINE-02).
 *
 * Une ligne d'état plutôt qu'un tableau à interpréter : « la cliente sait tout
 * de suite si elle peut venir, et quand ». La carte « Horaires » reste là pour
 * qui veut la semaine.
 *
 * `now` est un paramètre et non un `new Date()` enfoui : c'est ce qui rend la
 * fonction testable sans geler l'horloge du processus, et c'est la page qui
 * décide de l'instant — elle est rendue à chaque requête (`force-dynamic`).
 *
 * `display` est le dernier paramètre, et il est facultatif : les phrases
 * viennent du catalogue (#846), et le défaut français garde le comportement
 * d'avant le ticket pour les appelants hors empreinte — voir l'en-tête.
 *
 * `null` quand le salon n'a publié aucun horaire, ou quand son fuseau est
 * illisible : on ne dit rien plutôt que de dire faux. Un salon annoncé « fermé »
 * à tort est une cliente qui n'appelle pas.
 */
export function openingStatus(
  entries: readonly OpeningHoursEntry[],
  timezone: string,
  now: Date,
  display: DisplayLocale = FALLBACK_DISPLAY,
): OpeningStatus | null {
  if (entries.length === 0) {
    return null;
  }

  const clock = salonClock(timezone, now);

  if (clock === null) {
    return null;
  }

  for (const entry of entries) {
    if (entry.weekday !== clock.weekday) {
      continue;
    }

    const opens = wallMinutes(entry.opensAt);
    const closes = wallMinutes(entry.closesAt);

    if (opens === null || closes === null || closes <= opens) {
      continue;
    }

    if (clock.minutes >= opens && clock.minutes < closes) {
      return { open: true, label: fill(words(display).openUntil, { time: entry.closesAt }) };
    }
  }

  const next = nextOpening(entries, clock, display);

  return { open: false, label: next ?? words(display).closed };
}

/**
 * La prochaine ouverture, dite comme on la dit : « Fermé — ouvre à 14:00 »,
 * « Fermé — ouvre demain à 10:00 », « Fermé — ouvre samedi à 10:00 ».
 *
 * La semaine entière est parcourue, **jour de départ compris une seconde fois**
 * (`offset` va jusqu'à 7) : un salon qui n'ouvre qu'un jour par semaine
 * n'annoncerait sinon aucune prochaine ouverture une fois ce jour-là refermé,
 * et sa vitrine se bornerait à « Fermé » le soir même. `null` ne subsiste que
 * quand aucune plage lisible n'existe — un salon dont toutes les plages sont
 * illisibles se dit « Fermé », sans promesse.
 *
 * Le nom du jour est celui qu'`Intl` écrit **au fil d'une phrase**, sans
 * capitale forcée : « ouvre samedi » en français, « opens Saturday » en anglais
 * (#846). Le forcer d'un côté ou de l'autre aurait fait écrire l'une des deux
 * langues comme l'autre.
 */
function nextOpening(
  entries: readonly OpeningHoursEntry[],
  clock: SalonClock,
  display: DisplayLocale,
): string | null {
  for (let offset = 0; offset <= ISO_WEEK.length; offset += 1) {
    const weekday = ((clock.weekday - 1 + offset) % ISO_WEEK.length) + 1;

    const opens = entries
      .filter((entry) => entry.weekday === weekday)
      .map((entry) => wallMinutes(entry.opensAt))
      .filter((minutes): minutes is number => minutes !== null)
      // Aujourd'hui, une ouverture déjà passée n'est pas la prochaine.
      .filter((minutes) => offset > 0 || minutes > clock.minutes)
      .sort((left, right) => left - right);

    const earliest = opens[0];

    if (earliest === undefined) {
      continue;
    }

    const time = formatWallMinutes(earliest);

    if (offset === 0) {
      return fill(words(display).closedOpensAt, { time });
    }

    if (offset === 1) {
      return fill(words(display).closedOpensTomorrow, { time });
    }

    return fill(words(display).closedOpensOnDay, {
      day: weekdayName(weekday, display) ?? weekdayLabel(weekday, display),
      time,
    });
  }

  return null;
}

/** L'inverse de `wallMinutes`, pour réécrire une heure d'ouverture retenue. */
function formatWallMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
