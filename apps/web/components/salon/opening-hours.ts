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
 * Le jour tel qu'on l'écrit, avec un repli qui se voit.
 *
 * Point d'écriture **unique** du repli « jour sans nom » dans `apps/web` (#652).
 * Il n'apparaît jamais en usage normal — la numérotation ISO ne sort pas de
 * 1–7 —, et c'est bien ce qui le rendait dangereux en double : une branche
 * qu'aucun écran n'exerce laisse deux copies diverger sans que rien ne le
 * signale. Or l'une des deux alimentait le nom accessible des 28 champs de la
 * grille horaire des réglages, c'est-à-dire ce qu'un lecteur d'écran annonce.
 *
 * `noUncheckedIndexedAccess` rend la lecture du `Record` optionnelle, et c'est
 * heureux : sans le repli, un jour hors bornes écrirait « undefined ».
 *
 * À ne pas confondre avec le `weekdayLabel` de `lib/admin/staff-schedule.ts`,
 * qui reste distinct : celui-là est typé sur `IsoWeekday` et traite
 * délibérément la case 0 comme un jour manquant. Les rapprocher changerait son
 * comportement.
 */
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? `Jour ${String(weekday)}`;
}

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
        label: weekdayLabel(entry.weekday),
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

// ---------------------------------------------------------------------------
// La semaine enti\u00e8re, jours ferm\u00e9s compris \u2014 BM-VITRINE-03 (#1046)
// ---------------------------------------------------------------------------

/** Les sept jours, en num\u00e9rotation ISO \u2014 l'ordre de la carte \u00ab Horaires \u00bb. */
const ISO_WEEK = [1, 2, 3, 4, 5, 6, 7] as const;

/** Minutes d'une journ\u00e9e civile \u2014 la valeur de `24:00`, borne haute l\u00e9gitime. */
const MINUTES_IN_CIVIL_DAY = 24 * 60;

/**
 * Minutes depuis minuit d'une heure murale \u00ab HH:MM \u00bb.
 *
 * \u00c9crit ici plut\u00f4t qu'emprunt\u00e9 \u00e0 `lib/admin/appointment-desk.ts`, qui en tient
 * d\u00e9j\u00e0 un : ce module-ci est charg\u00e9 par la **vitrine publique**, dont le budget
 * de LCP est de 2,5 s en 4G (skill web-frontend \u00a77), et importer un module du
 * back-office ferait entrer tout son graphe de d\u00e9pendances dans ce chemin-l\u00e0.
 * Quelques lignes de lecture valent mieux qu'un couplage de couches.
 *
 * `24:00` est trait\u00e9 \u00e0 part, comme dans le contrat : c'est la borne haute d'un
 * salon ouvert jusqu'\u00e0 minuit (`scheduleEndTimeSchema`), et non une heure de
 * d\u00e9but. Une valeur illisible rend `null` et sera ignor\u00e9e \u2014 la validation du
 * contrat l'a d\u00e9j\u00e0 refus\u00e9e \u00e0 l'\u00e9criture, et la vitrine ne doit pas blanchir sur
 * une donn\u00e9e h\u00e9rit\u00e9e.
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

/** Une journ\u00e9e de la semaine, telle que la carte \u00ab Horaires \u00bb la rend. */
export interface ScheduledDay {
  readonly weekday: number;
  readonly label: string;
  /** Les plages du jour \u2014 **vide** quand le salon est ferm\u00e9 ce jour-l\u00e0. */
  readonly ranges: readonly OpeningHoursEntry[];
}

/**
 * La semaine compl\u00e8te, du lundi au dimanche, jours ferm\u00e9s compris (BM-VITRINE-03).
 *
 * ## Ce qui change, et la raison qui l'autorise
 *
 * `groupOpeningHoursByDay` ci-dessus n'affiche que les jours re\u00e7us, au motif \u2014
 * exact \u2014 que l'API ne distingue pas \u00ab le salon ferme le lundi \u00bb de \u00ab le salon
 * n'a pas encore saisi ses horaires \u00bb. Elle reste employ\u00e9e par les donn\u00e9es
 * structur\u00e9es, qui ne doivent affirmer que ce qui a \u00e9t\u00e9 publi\u00e9.
 *
 * Pour un lecteur humain, la distinction se tranche un cran plus haut : d\u00e8s que
 * le salon a publi\u00e9 **une** plage, sa semaine est saisie, et un jour qui n'y
 * figure pas est un jour ferm\u00e9. C'est la seule lecture qui rende la carte utile
 * \u2014 sept lignes dont les fermetures sont \u00e9crites \u2014 sans rien inventer, puisque
 * le cas \u00ab rien de saisi \u00bb est \u00e9cart\u00e9 par le tableau vide.
 *
 * Un tableau **vide** rend donc un tableau vide, et non sept jours \u00ab Ferm\u00e9 \u00bb :
 * un salon qui n'a rien renseign\u00e9 n'est pas un salon ferm\u00e9 toute la semaine.
 */
export function weekSchedule(entries: readonly OpeningHoursEntry[]): readonly ScheduledDay[] {
  if (entries.length === 0) {
    return [];
  }

  return ISO_WEEK.map((weekday) => ({
    weekday,
    label: weekdayLabel(weekday),
    ranges: entries.filter((entry) => entry.weekday === weekday),
  }));
}

// ---------------------------------------------------------------------------
// L'\u00e9tat d'ouverture, calcul\u00e9 pour maintenant \u2014 BM-VITRINE-02 (#1046)
// ---------------------------------------------------------------------------

/** L'horloge du salon : le jour ISO et l'heure qu'il est **chez lui**. */
export interface SalonClock {
  readonly weekday: number;
  /** Minutes \u00e9coul\u00e9es depuis minuit, dans le fuseau du salon. */
  readonly minutes: number;
}

/** Les abr\u00e9viations qu'`Intl` rend en `en-US`, ramen\u00e9es \u00e0 la num\u00e9rotation ISO. */
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
 * L'instant courant lu \u00e0 l'horloge du salon.
 *
 * `hourCycle: 'h23'` et non `hour12: false` \u2014 les deux se contredisent sur
 * certains moteurs, et `hour12: false` seul peut rendre `24` pour minuit, ce qui
 * placerait 00 h 15 apr\u00e8s la fermeture de la veille. M\u00eame pr\u00e9caution que
 * `lib/admin/calendar-grid.ts`, pour la m\u00eame raison.
 *
 * `en-US` et non la locale d'affichage : ce sont les cl\u00e9s d'un `Record` qu'on
 * lit, pas un texte qu'on montre. Un fuseau inconnu fait lever `Intl` \u2014 la
 * fonction rend alors `null`, et l'appelant se tait plut\u00f4t que d'annoncer un
 * \u00e9tat d'ouverture faux.
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

/** Ce que le bandeau d'identit\u00e9 \u00e9crit de l'ouverture du salon. */
export interface OpeningStatus {
  /** Le salon est-il ouvert **en ce moment**, \u00e0 son horloge \u00e0 lui ? */
  readonly open: boolean;
  /** \u00ab Ouvert \u2014 ferme \u00e0 19:00 \u00bb, \u00ab Ferm\u00e9 \u2014 ouvre demain \u00e0 10:00 \u00bb, \u00ab Ferm\u00e9 \u00bb. */
  readonly label: string;
}

/**
 * L'\u00e9tat d'ouverture du salon **maintenant**, dans son fuseau (BM-VITRINE-02).
 *
 * Une ligne d'\u00e9tat plut\u00f4t qu'un tableau \u00e0 interpr\u00e9ter : \u00ab la cliente sait tout
 * de suite si elle peut venir, et quand \u00bb. La carte \u00ab Horaires \u00bb reste l\u00e0 pour
 * qui veut la semaine.
 *
 * `now` est un param\u00e8tre et non un `new Date()` enfoui : c'est ce qui rend la
 * fonction testable sans geler l'horloge du processus, et c'est la page qui
 * d\u00e9cide de l'instant \u2014 elle est rendue \u00e0 chaque requ\u00eate (`force-dynamic`).
 *
 * `null` quand le salon n'a publi\u00e9 aucun horaire, ou quand son fuseau est
 * illisible : on ne dit rien plut\u00f4t que de dire faux. Un salon annonc\u00e9 \u00ab ferm\u00e9 \u00bb
 * \u00e0 tort est une cliente qui n'appelle pas.
 */
export function openingStatus(
  entries: readonly OpeningHoursEntry[],
  timezone: string,
  now: Date,
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
      return { open: true, label: `Ouvert \u2014 ferme \u00e0 ${entry.closesAt}` };
    }
  }

  const next = nextOpening(entries, clock);

  return { open: false, label: next === null ? 'Ferm\u00e9' : `Ferm\u00e9 \u2014 ${next}` };
}

/**
 * La prochaine ouverture, dite comme on la dit : \u00ab ouvre \u00e0 14:00 \u00bb, \u00ab ouvre
 * demain \u00e0 10:00 \u00bb, \u00ab ouvre samedi \u00e0 10:00 \u00bb.
 *
 * La semaine enti\u00e8re est parcourue, **jour de d\u00e9part compris une seconde fois**
 * (`offset` va jusqu'\u00e0 7) : un salon qui n'ouvre qu'un jour par semaine
 * n'annoncerait sinon aucune prochaine ouverture une fois ce jour-l\u00e0 referm\u00e9,
 * et sa vitrine se bornerait \u00e0 \u00ab Ferm\u00e9 \u00bb le soir m\u00eame. `null` ne subsiste que
 * quand aucune plage lisible n'existe \u2014 un salon dont toutes les plages sont
 * illisibles se dit \u00ab Ferm\u00e9 \u00bb, sans promesse.
 */
function nextOpening(entries: readonly OpeningHoursEntry[], clock: SalonClock): string | null {
  for (let offset = 0; offset <= ISO_WEEK.length; offset += 1) {
    const weekday = ((clock.weekday - 1 + offset) % ISO_WEEK.length) + 1;

    const opens = entries
      .filter((entry) => entry.weekday === weekday)
      .map((entry) => wallMinutes(entry.opensAt))
      .filter((minutes): minutes is number => minutes !== null)
      // Aujourd'hui, une ouverture d\u00e9j\u00e0 pass\u00e9e n'est pas la prochaine.
      .filter((minutes) => offset > 0 || minutes > clock.minutes)
      .sort((left, right) => left - right);

    const earliest = opens[0];

    if (earliest === undefined) {
      continue;
    }

    const time = formatWallMinutes(earliest);

    if (offset === 0) {
      return `ouvre \u00e0 ${time}`;
    }

    if (offset === 1) {
      return `ouvre demain \u00e0 ${time}`;
    }

    return `ouvre ${weekdayLabel(weekday).toLocaleLowerCase('fr-FR')} \u00e0 ${time}`;
  }

  return null;
}

/** L'inverse de `wallMinutes`, pour r\u00e9\u00e9crire une heure d'ouverture retenue. */
function formatWallMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
