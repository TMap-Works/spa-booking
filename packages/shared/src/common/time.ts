/**
 * Instants et dates du contrat — règle non négociable : **tout est stocké et
 * transporté en UTC**, converti à l'affichage selon le fuseau du tenant.
 *
 * La distinction qui tient ce fichier, et qu'on ne peut pas escamoter dans une
 * application de rendez-vous :
 *
 * - un **instant** (`UtcInstant`) est un point sur la ligne du temps, sans
 *   ambiguïté possible. Le début d'un rendez-vous en est un.
 * - une **date civile** (`CalendarDate`) est « le 3 mars » dans le calendrier de
 *   l'établissement. Ce n'est *pas* un instant : « le 3 mars » à Papeete et à
 *   Paris ne commencent pas au même moment. Les requêtes de disponibilité
 *   raisonnent en dates civiles, parce que c'est ce qu'affiche un calendrier.
 * - une **heure murale** (`LocalTime`) est « 09:00 » sur l'horloge du salon. Pas
 *   davantage un instant : `09:00` à Paris vaut `08:00Z` en hiver et `07:00Z` en
 *   été. Les horaires du personnel sont de cette nature (#32), et c'est ce qui
 *   interdit de les figer en UTC.
 *
 * Les confondre, c'est décaler un agenda d'un jour ou d'une heure au changement
 * d'heure — un bug de sévérité haute selon CLAUDE.md. Le passage d'une heure
 * murale à un instant demande un fuseau IANA **et** une date, et n'est pas
 * toujours défini : c'est le rôle du moteur de conversion du module
 * `availability` (#41), pas du contrat.
 */

import { z } from 'zod';

/**
 * Instant ISO 8601 **en UTC**, suffixé `Z`.
 *
 * `offset: false` est le point important : Zod refuse alors
 * `2026-03-03T10:00:00+01:00`. Ce refus est délibéré — accepter un décalage
 * reviendrait à laisser chaque client choisir son référentiel, et à ne plus
 * pouvoir comparer deux horodatages sans les normaliser d'abord. Le fuseau
 * d'affichage est une propriété du tenant, pas de la charge utile.
 */
export const utcInstantSchema = z.string().datetime({
  offset: false,
  message: 'un instant doit être en ISO 8601 UTC, suffixé « Z »',
});

export type UtcInstant = z.infer<typeof utcInstantSchema>;

/**
 * Motif d'une date-heure ISO 8601 **porteuse d'un offset explicite** — `Z` ou
 * `±HH:MM`.
 *
 * Il y a trois formes possibles pour une date-heure ISO 8601, et une seule est
 * acceptable en entrée d'API :
 *
 * | Forme | Exemple | Verdict |
 * |---|---|---|
 * | UTC | `2026-03-29T01:30:00Z` | acceptée — `Z` **est** un offset explicite |
 * | décalée | `2026-03-29T03:30:00+02:00` | acceptée, normalisée en UTC |
 * | nue | `2026-03-29T03:30:00` | **refusée** |
 *
 * La forme nue est celle qui décale les agendas : elle n'a de sens que rapportée
 * à un fuseau, et le serveur ne peut que **deviner** lequel — celui du tenant ?
 * celui du navigateur ? celui de la machine, qui n'est le fuseau de personne ?
 * Trois réponses défendables, donc aucune. La refuser à la frontière est la
 * seule façon de ne jamais avoir à choisir.
 *
 * Les secondes sont facultatives et les fractions acceptées jusqu'à la
 * nanoseconde : c'est la latitude que laisse le profil RFC 3339, et la refuser
 * rejetterait des horodatages parfaitement formés produits par d'autres piles.
 *
 * L'heure, elle, est **bornée** à `00`-`23`, comme celle de
 * `LOCAL_TIME_PATTERN` : le profil RFC 3339 ne connaît pas `24:00`, et un
 * `\d{2}` complaisant laisserait `2026-03-29T24:00:00Z` franchir la frontière
 * pour être normalisé, sans un mot, au 30 mars — un rendez-vous déplacé d'un
 * jour par une saisie que rien n'a refusée.
 */
export const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/**
 * `true` si `value` est une date-heure ISO 8601 avec offset explicite **et**
 * désigne un instant réel.
 *
 * Le motif seul ne suffit pas : `2026-02-31T10:00:00Z` le satisfait, et
 * `Date.parse` le ramènerait au 3 mars sans rien signaler. La date civile est
 * donc rejouée composant par composant, comme pour `calendarDateSchema`.
 */
export function isOffsetDateTime(value: string): boolean {
  if (!OFFSET_DATE_TIME_PATTERN.test(value)) {
    return false;
  }

  const calendarPart = value.slice(0, 10);

  return isRealCalendarDate(calendarPart) && !Number.isNaN(Date.parse(value));
}

/**
 * Date-heure entrante : ISO 8601 avec offset explicite, **normalisée en UTC**.
 *
 * C'est le pendant en entrée d'`utcInstantSchema`, qui reste le format de
 * sortie. La dissymétrie est voulue :
 *
 * - **En sortie**, l'API n'émet que du `Z`. Un seul référentiel, donc deux
 *   horodatages toujours comparables par simple ordre lexicographique.
 * - **En entrée**, elle accepte aussi `+02:00` et le convertit tout de suite.
 *   Refuser un offset explicite ferait porter la conversion au client, qui la
 *   ferait avec le fuseau de son navigateur — exactement l'erreur qu'on cherche
 *   à rendre impossible.
 *
 * La normalisation est faite **ici**, à la frontière, et pas plus loin : passé ce
 * schéma, plus aucune couche n'a à se demander dans quel référentiel elle lit un
 * horodatage.
 */
export const offsetDateTimeSchema = z
  .string()
  .refine(isOffsetDateTime, {
    message:
      'une date-heure doit être en ISO 8601 avec offset explicite (« Z » ou « ±HH:MM »)',
  })
  .transform((value): UtcInstant => toUtcInstant(new Date(value)));

/**
 * Heure locale murale `HH:MM`, dans le fuseau de l'établissement.
 *
 * « Murale » au sens propre : c'est ce que montre l'horloge du salon, sans
 * offset et sans date. Un horaire de personnel (« ouvre à 09:00 ») est de cette
 * nature, et c'est précisément ce qui interdit de le stocker en UTC : `09:00`
 * vaut `08:00Z` en hiver et `07:00Z` en été à Paris. Figer l'un des deux décale
 * l'agenda six mois par an.
 *
 * L'instant ne naît qu'en **combinant** cette heure murale avec une date civile
 * et le fuseau du tenant — c'est le rôle du moteur de conversion du module
 * `availability`, pas du contrat.
 */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const localTimeSchema = z.string().regex(LOCAL_TIME_PATTERN, {
  message: 'heure locale attendue au format HH:MM (00:00 à 23:59)',
});

export type LocalTime = z.infer<typeof localTimeSchema>;

/**
 * Minutes écoulées depuis minuit local — la forme comparable d'une heure murale.
 *
 * Comparer deux `HH:MM` en chaînes marche par accident (l'ordre lexicographique
 * coïncide avec l'ordre chronologique sur ce format zéro-préfixé) ; les
 * soustraire, non. Un horaire de travail se manipule en minutes.
 */
export function localTimeToMinutes(time: LocalTime): number {
  const [hours, minutes] = localTimeSchema.parse(time).split(':');

  return Number(hours) * 60 + Number(minutes);
}

/**
 * Inverse de `localTimeToMinutes`, borné à la journée civile de 24 heures.
 *
 * Le refus au-delà de `1439` est délibéré : une fenêtre de travail qui déborde
 * sur le lendemain se décrit par deux plages, pas par un `25:30` que rien ne
 * saurait afficher.
 */
export function minutesToLocalTime(minutes: number): LocalTime {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1439) {
    throw new RangeError(
      `minutes depuis minuit hors de la journée civile : ${String(minutes)}`,
    );
  }

  const hours = Math.floor(minutes / 60);

  return `${pad2(hours)}:${pad2(minutes % 60)}`;
}

/**
 * Date civile `YYYY-MM-DD`, dans le fuseau de l'établissement.
 *
 * La regex ne suffit pas : `2026-02-31` la satisfait. Le `refine` rejoue la date
 * par `Date.UTC` et vérifie qu'elle est revenue intacte — c'est ce qui attrape
 * le 31 février et le 30 du mois de février d'une année non bissextile.
 */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'date attendue au format YYYY-MM-DD' })
  .refine(isRealCalendarDate, { message: 'cette date n’existe pas au calendrier' });

export type CalendarDate = z.infer<typeof calendarDateSchema>;

/**
 * Identifiant de fuseau IANA (« Europe/Paris »).
 *
 * Validé en demandant au moteur ICU s'il le connaît, plutôt que contre une
 * liste figée : la base tzdata bouge (fusions, créations, renommages) et une
 * liste recopiée serait fausse à la première mise à jour de Node. `Intl` est
 * présent aussi bien dans Node 20 que dans les navigateurs ciblés.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimeZone, { message: 'fuseau horaire IANA inconnu' });

export type TimeZone = z.infer<typeof timeZoneSchema>;

/** Durée en minutes — entière et strictement positive (un soin de 0 min n'existe pas). */
export const durationMinutesSchema = z
  .number()
  .int({ message: 'une durée s’exprime en minutes entières' })
  .min(1, { message: 'une durée doit être strictement positive' });

/**
 * Intervalle `[startsAt, endsAt[` en UTC.
 *
 * Le `refine` exige un intervalle **non vide**, en écho au
 * `CHECK ("ends_at" > "starts_at")` déjà posé en base : un intervalle vide ne
 * chevauche rien et passerait sous la contrainte d'exclusion
 * anti-double-réservation sans jamais la déclencher — deux rendez-vous sur le
 * même praticien au même instant. La borne haute est exclue, de sorte que deux
 * créneaux adjacents ne se chevauchent pas.
 */
export const utcIntervalSchema = z
  .object({
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
  })
  .strict()
  .refine((interval) => Date.parse(interval.endsAt) > Date.parse(interval.startsAt), {
    message: 'la fin doit être strictement postérieure au début',
    path: ['endsAt'],
  });

export type UtcInterval = z.infer<typeof utcIntervalSchema>;

/** Deux chiffres, zéro-préfixés — la brique de tout format ISO 8601. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `true` si `value` est un identifiant de fuseau connu du moteur ICU. */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `true` si `value` — déjà au format `YYYY-MM-DD` — désigne une date réelle. */
export function isRealCalendarDate(value: string): boolean {
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const replayed = new Date(Date.UTC(year, month - 1, day));

  return (
    replayed.getUTCFullYear() === year &&
    replayed.getUTCMonth() === month - 1 &&
    replayed.getUTCDate() === day
  );
}

/** Sérialise une `Date` en instant UTC du contrat. */
export function toUtcInstant(date: Date): UtcInstant {
  return utcInstantSchema.parse(date.toISOString());
}

/** Relit un instant du contrat en `Date`. */
export function fromUtcInstant(instant: UtcInstant): Date {
  return new Date(instant);
}

/**
 * Nombre de jours civils entre deux dates, bornes comprises.
 *
 * Le calcul passe par `Date.UTC` et non par une soustraction de `Date` locales :
 * une différence en millisecondes entre deux minuits locaux vaut 23 ou 25 heures
 * les jours de changement d'heure, et l'arrondi qui en découle fait perdre ou
 * gagner un jour à la fenêtre de disponibilité.
 */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);

  return Math.round((end - start) / 86_400_000) + 1;
}

/** Ajoute `minutes` à un instant UTC — sert à dériver `endsAt` d'une durée de soin. */
export function addMinutes(instant: UtcInstant, minutes: number): UtcInstant {
  return toUtcInstant(new Date(Date.parse(instant) + minutes * 60_000));
}
