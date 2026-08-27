/**
 * Conversion heure locale du tenant ↔ UTC (#41).
 *
 * La base ne stocke que de l'UTC (`timestamptz`), le salon ne raisonne qu'en
 * heure murale. Tout le module `availability` vit sur cette frontière, et c'est
 * ici — et nulle part ailleurs — qu'on la traverse.
 *
 * ## Pourquoi aucun décalage n'est figé
 *
 * Écrire « Paris, c'est UTC+1 » est faux la moitié de l'année. Stocker l'offset
 * d'un tenant à la création de son compte l'est tout autant : il change deux
 * fois par an, et rien ne repasserait le corriger. Un agenda calculé sur un
 * offset figé décale **toute** la saison suivante d'une heure — CDC §6, sévérité
 * haute.
 *
 * L'offset est donc systématiquement **recalculé pour l'instant considéré**, en
 * interrogeant la base tzdata IANA embarquée dans l'ICU de Node via `Intl`.
 * C'est la même source que `isValidTimeZone` du contrat partagé, elle suit les
 * mises à jour de Node, et elle connaît l'historique des règles — un
 * rendez-vous archivé en 2019 se relit avec les règles de 2019.
 *
 * ## Les deux anomalies du changement d'heure
 *
 * Une heure murale n'est pas toujours un instant. Deux fois par an, la fonction
 * « heure locale → UTC » cesse d'être une bijection :
 *
 * | Sens | Exemple `Europe/Paris` | Anomalie |
 * |---|---|---|
 * | Printemps | 2026-03-29, l'horloge saute 02:00 → 03:00 | `02:30` **n'existe pas** |
 * | Automne | 2026-10-25, l'horloge recule 03:00 → 02:00 | `02:30` **existe deux fois** |
 *
 * Une bibliothèque qui rend un seul `Date` sans le dire tranche en silence. Ce
 * module rend au contraire une **résolution explicite** (`exact`, `skipped`,
 * `ambiguous`) : l'appelant qui s'en moque lit `.instant`, celui que ça regarde
 * — la création d'un rendez-vous — branche sur `.kind` et refuse.
 *
 * ## Ce que ce module ne fait pas
 *
 * Il ne connaît ni Prisma, ni HTTP, ni le modèle d'horaires récurrents du
 * personnel — celui-ci relève de #32 et n'existe pas encore. Ce sont des
 * fonctions pures : un fuseau, une date, une heure, rien d'autre.
 */

/** Heure murale d'un fuseau donné — ce que montre l'horloge, sans offset. */
export interface ZonedWallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Résultat de « cette heure murale, quel instant est-ce ? ».
 *
 * `instant` est **toujours** renseigné, y compris sur les deux anomalies : la
 * politique appliquée est celle de `Temporal` (`disambiguation: 'compatible'`),
 * décrite sur chaque variante. L'appelant qui ne peut pas se permettre un choix
 * implicite branche sur `kind` — c'est ce que fait `requireExactInstant`.
 */
export type ZonedResolution =
  /** Cas courant : une heure murale, un instant, sans ambiguïté. */
  | {
      readonly kind: 'exact';
      readonly instant: Date;
      readonly offsetMinutes: number;
    }
  /**
   * Printemps : l'heure murale demandée a été sautée par l'avance de l'horloge.
   *
   * `instant` est la borne **haute** du trou — l'heure murale décalée en avant
   * de la durée du saut, soit `02:30` → `03:30`. C'est le choix de `Temporal` et
   * le seul qui préserve l'ordre : une fenêtre de travail `02:00–10:00` reste
   * une fenêtre, là où reculer en aurait fait `01:00–10:00`, plus longue que
   * demandé.
   */
  | {
      readonly kind: 'skipped';
      readonly instant: Date;
      readonly offsetMinutes: number;
      /** Durée du saut d'horloge, en minutes (60 en Europe, 30 à Lord Howe). */
      readonly gapMinutes: number;
    }
  /**
   * Automne : l'heure murale demandée a lieu deux fois.
   *
   * `instant` est la **première** occurrence — avant le recul de l'horloge. Un
   * rendez-vous affiché « 02:30 » est celui que le client verra arriver en
   * premier ; choisir la seconde le ferait attendre une heure de trop.
   */
  | {
      readonly kind: 'ambiguous';
      readonly instant: Date;
      readonly offsetMinutes: number;
      /** La seconde occurrence — après le recul de l'horloge. */
      readonly alternative: Date;
      readonly alternativeOffsetMinutes: number;
    };

/** Intervalle d'instants UTC, borne haute exclue — la forme d'un créneau. */
export interface UtcRange {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Formateurs ICU mémoïsés par fuseau.
 *
 * Construire un `Intl.DateTimeFormat` coûte cher — assez pour dominer le calcul
 * de créneaux, qui en demande un par instant testé. Le cache est borné par le
 * nombre de fuseaux **valides** : `formatterFor` valide avant d'insérer, si bien
 * qu'aucune chaîne arbitraire ne peut le faire enfler.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * Le formateur du fuseau, construit à la demande.
 *
 * `hourCycle: 'h23'` et non `hour12: false` : ce dernier produit `24` pour
 * minuit sur plusieurs versions d'ICU, ce qui décale la date d'un jour au
 * moment de recomposer l'instant. Le bogue ne se voit qu'à minuit pile, donc
 * jamais en développement.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);

  if (cached !== undefined) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  FORMATTERS.set(timeZone, formatter);

  return formatter;
}

/**
 * `true` si l'ICU connaît ce fuseau — la question posée **au travers du cache**.
 *
 * Le garde passe par `formatterFor` plutôt que de construire un
 * `Intl.DateTimeFormat` jetable : la construction coûte à elle seule une dizaine
 * de fois une lecture d'heure murale, si bien qu'un garde naïf reviendrait plus
 * cher que la conversion qu'il protège. Ici, le premier appel pour un fuseau
 * paie la construction que la conversion suivante aurait payée de toute façon,
 * et les suivants ne paient rien.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);

    return true;
  } catch {
    return false;
  }
}

/**
 * Recompose un instant à partir de composants **lus comme s'ils étaient UTC**.
 *
 * `Date.UTC` n'est pas utilisable tel quel : il interprète les années 0 à 99
 * comme 1900-1999. Le détour par `setUTCFullYear` sur une date à l'époque évite
 * ce piège, et coûte le même prix.
 */
function utcFromParts(wall: ZonedWallTime): number {
  const date = new Date(0);

  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0);

  return date.getTime();
}

function partsOf(formatter: Intl.DateTimeFormat, instant: Date): ZonedWallTime {
  const read = new Map<string, string>();

  for (const part of formatter.formatToParts(instant)) {
    read.set(part.type, part.value);
  }

  return {
    year: Number(read.get('year')),
    month: Number(read.get('month')),
    day: Number(read.get('day')),
    hour: Number(read.get('hour')),
    minute: Number(read.get('minute')),
    second: Number(read.get('second')),
  };
}

/**
 * Heure murale d'un instant dans un fuseau — le sens « UTC → local ».
 *
 * Lève si le fuseau est inconnu de l'ICU : mieux vaut échouer ici que rendre
 * silencieusement de l'UTC, ce que ferait un repli sur `undefined`.
 */
export function utcToZonedWallTime(instant: Date, timeZone: string): ZonedWallTime {
  return partsOf(formatterFor(timeZone), instant);
}

/**
 * Décalage du fuseau **à cet instant précis**, en minutes signées.
 *
 * `+120` pour `Europe/Paris` en août, `+60` en janvier. C'est cette fonction qui
 * remplace tout offset stocké : elle est appelée à chaque conversion, jamais
 * mémorisée sur un tenant.
 *
 * Le calcul compare l'heure murale relue à l'instant d'origine tronqué à la
 * seconde — les millisecondes ne franchissent pas le formateur ICU, et les
 * inclure ferait apparaître un décalage fractionnaire là où il n'y en a pas.
 */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const wall = partsOf(formatterFor(timeZone), instant);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;

  return (utcFromParts(wall) - truncated) / MINUTE_MS;
}

/**
 * Heure murale → instant, en nommant l'anomalie quand il y en a une.
 *
 * L'algorithme est celui de `Temporal.TimeZone.getPossibleInstantsFor` :
 *
 * 1. lire l'heure murale **comme si** elle était UTC — un repère, pas un instant ;
 * 2. relever l'offset du fuseau un jour avant et un jour après ce repère, ce qui
 *    encadre à coup sûr toute transition ;
 * 3. les deux offsets donnent deux instants candidats ;
 * 4. ne garder que ceux qui, relus dans le fuseau, redonnent bien l'heure murale
 *    demandée.
 *
 * Le nombre de survivants **est** le diagnostic : un seul, l'heure est ordinaire ;
 * deux, elle est ambiguë ; aucun, elle n'existe pas. Aucune table de transitions
 * n'est nécessaire, et le cas des fuseaux dont le saut ne vaut pas une heure
 * (Lord Howe, 30 minutes) est traité sans clause particulière.
 *
 * Chaque candidat **porte l'offset qui l'a produit** : survivre au filtre, c'est
 * précisément que cet offset est celui en vigueur à cet instant-là. La résolution
 * le rend donc tel quel plutôt que de le redemander à l'ICU, ce qui économise une
 * lecture par occurrence sur un chemin appelé une fois par créneau testé.
 */
export function resolveZonedWallTime(wall: ZonedWallTime, timeZone: string): ZonedResolution {
  const reference = utcFromParts(wall);
  const offsetBefore = offsetMinutesAt(new Date(reference - DAY_MS), timeZone);
  const offsetAfter = offsetMinutesAt(new Date(reference + DAY_MS), timeZone);

  const offsets = offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];

  const valid = offsets
    .map((offsetMinutes) => ({ instant: reference - offsetMinutes * MINUTE_MS, offsetMinutes }))
    .filter(
      ({ instant, offsetMinutes }) => offsetMinutesAt(new Date(instant), timeZone) === offsetMinutes,
    )
    .sort((left, right) => left.instant - right.instant);

  const [first, second] = valid;

  if (first !== undefined && second !== undefined) {
    return {
      kind: 'ambiguous',
      instant: new Date(first.instant),
      offsetMinutes: first.offsetMinutes,
      alternative: new Date(second.instant),
      alternativeOffsetMinutes: second.offsetMinutes,
    };
  }

  if (first !== undefined) {
    return {
      kind: 'exact',
      instant: new Date(first.instant),
      offsetMinutes: first.offsetMinutes,
    };
  }

  // Trou d'horloge : aucun candidat ne se relit à l'heure demandée. L'offset
  // d'avant transition mène à l'instant qui suit le saut — l'heure murale
  // décalée en avant de la durée du trou.
  const shifted = reference - offsetBefore * MINUTE_MS;

  return {
    kind: 'skipped',
    instant: new Date(shifted),
    offsetMinutes: offsetMinutesAt(new Date(shifted), timeZone),
    gapMinutes: offsetAfter - offsetBefore,
  };
}

/**
 * Heure murale → instant, politique `compatible` appliquée sans rien dire.
 *
 * À réserver aux calculs où l'anomalie n'a pas de conséquence métier — bornes
 * d'une fenêtre de travail, découpage d'un calendrier. Tout ce qui **crée** un
 * rendez-vous passe par `requireExactInstant`.
 */
export function zonedWallTimeToUtc(wall: ZonedWallTime, timeZone: string): Date {
  return resolveZonedWallTime(wall, timeZone).instant;
}

/**
 * Date civile `YYYY-MM-DD` — la forme de `calendarDateSchema` du contrat.
 *
 * Exporté pour la même raison que `LOCAL_TIME_PATTERN` : les horaires récurrents
 * (#32) découpent eux aussi des dates civiles, et deux copies de ce motif
 * dériveraient l'une de l'autre sans que rien ne le signale.
 */
export const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Heure murale `HH:MM`, 00:00 à 23:59 — la forme que `zonedDateTimeToUtc` sait
 * lire, et la seule.
 *
 * Exporté parce que `dto/validation.ts` s'en sert pour `@IsLocalTime()` : le
 * DTO doit refuser en 400 exactement ce que le moteur refuserait en `RangeError`
 * — c'est-à-dire en 500. Deux copies de ce motif dériveraient l'une de l'autre
 * sans que rien ne le signale.
 */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Découpe une date civile `YYYY-MM-DD` en heure murale.
 *
 * Le format est celui de `calendarDateSchema` du contrat partagé, et le refus
 * est un `RangeError` et non une erreur de domaine : arriver ici avec une date
 * mal formée est un défaut de programmation — le DTO l'aurait refusée en 400
 * bien avant. Le garde existe pour que ce défaut se voie tout de suite, plutôt
 * que de produire un `NaN` qui se propagerait en `Invalid Date` à trois couches
 * de là.
 */
function wallTimeAt(calendarDate: string, hour = 0, minute = 0): ZonedWallTime {
  const matched = CALENDAR_DATE_PATTERN.exec(calendarDate);

  if (matched === null) {
    throw new RangeError(`date civile attendue au format YYYY-MM-DD : « ${calendarDate} »`);
  }

  return {
    year: Number(matched[1]),
    month: Number(matched[2]),
    day: Number(matched[3]),
    hour,
    minute,
    second: 0,
  };
}

/**
 * Bornes UTC d'une **journée civile** du tenant, borne haute exclue.
 *
 * Une journée civile ne dure pas toujours 24 heures : 23 le jour du passage à
 * l'heure d'été, 25 à celui de l'heure d'hiver. La borne haute est donc calculée
 * comme le minuit du **lendemain**, jamais comme « début + 24 h » — cette
 * seconde forme laisse une heure de créneaux hors de la journée en octobre, et
 * en invente une en mars.
 *
 * Minuit local est lui-même sujet aux deux anomalies : il n'existe pas au Brésil
 * les nuits de passage à l'heure d'été. `zonedWallTimeToUtc` applique alors la
 * politique `compatible` — la journée commence à 01:00 locale — ce qui est le
 * comportement attendu : aucun créneau n'existe avant.
 */
export function zonedDayRange(calendarDate: string, timeZone: string): UtcRange {
  const midnight = wallTimeAt(calendarDate);

  // Le lendemain se dérive par `Date`, qui sait seul que le 31 mars est suivi du
  // 1er avril et le 28 février d'une année bissextile du 29.
  const nextDay = new Date(0);
  nextDay.setUTCFullYear(midnight.year, midnight.month - 1, midnight.day + 1);
  nextDay.setUTCHours(0, 0, 0, 0);

  return {
    startsAt: zonedWallTimeToUtc(midnight, timeZone),
    endsAt: zonedWallTimeToUtc(
      {
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      timeZone,
    ),
  };
}

/**
 * Durée réelle d'une journée civile du tenant, en minutes.
 *
 * `1380` (23 h) au printemps, `1500` (25 h) à l'automne, `1440` le reste de
 * l'année. Le calcul de créneaux qui suppose 1440 partout perd — ou invente —
 * une heure de disponibilité deux fois par an.
 */
export function zonedDayLengthMinutes(calendarDate: string, timeZone: string): number {
  const { startsAt, endsAt } = zonedDayRange(calendarDate, timeZone);

  return (endsAt.getTime() - startsAt.getTime()) / MINUTE_MS;
}

/**
 * Instant d'une heure murale posée sur une date civile — la conversion « à la
 * volée » que consommeront les horaires du personnel (#32).
 *
 * `localTime` est au format `HH:MM` du contrat partagé.
 */
export function zonedDateTimeToUtc(
  calendarDate: string,
  localTime: string,
  timeZone: string,
): ZonedResolution {
  const matched = LOCAL_TIME_PATTERN.exec(localTime);

  if (matched === null) {
    throw new RangeError(`heure locale attendue au format HH:MM : « ${localTime} »`);
  }

  return resolveZonedWallTime(
    wallTimeAt(calendarDate, Number(matched[1]), Number(matched[2])),
    timeZone,
  );
}

/**
 * Rend une date-heure en ISO 8601 **avec offset explicite**, dans le fuseau du
 * tenant : `2026-10-25T02:30:00+02:00`.
 *
 * Sert partout où une heure doit être lisible par un humain sans conversion
 * mentale — un e-mail de confirmation, un export comptable, une trace de
 * diagnostic. La sortie porte son offset, donc reste convertible sans rien
 * savoir du tenant : c'est ce qui la distingue d'une heure murale nue.
 *
 * Le format de sortie de l'API, lui, reste l'instant UTC suffixé `Z`
 * (`utcInstantSchema`) — qui est lui aussi un offset explicite, et le seul qui
 * se compare par simple ordre lexicographique.
 */
export function formatOffsetDateTime(instant: Date, timeZone: string): string {
  const wall = utcToZonedWallTime(instant, timeZone);
  const offsetMinutes = offsetMinutesAt(instant, timeZone);

  const date = `${String(wall.year).padStart(4, '0')}-${pad2(wall.month)}-${pad2(wall.day)}`;
  const time = `${pad2(wall.hour)}:${pad2(wall.minute)}:${pad2(wall.second)}`;

  return `${date}T${time}${formatOffset(offsetMinutes)}`;
}

/** `+02:00`, `-09:30`, `Z` — la notation d'offset de la RFC 3339. */
export function formatOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) {
    return 'Z';
  }

  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);

  return `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
