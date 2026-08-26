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
 *
 * Confondre les deux, c'est décaler un agenda d'un jour au changement d'heure —
 * un bug de sévérité haute selon CLAUDE.md.
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
