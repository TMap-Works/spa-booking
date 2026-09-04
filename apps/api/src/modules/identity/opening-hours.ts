/**
 * Heures murales des plages d'ouverture — la conversion, et rien d'autre (#343).
 *
 * ## Pourquoi la base compte en minutes et l'API parle en `HH:MM`
 *
 * « Ouvre à 09:00 » n'est pas un instant : à Paris, cette heure murale vaut
 * `08:00Z` en hiver et `07:00Z` en été. Stocker l'un des deux décalerait
 * l'affichage six mois par an. La colonne est donc un entier — les minutes
 * écoulées depuis minuit local — qui ne peut se lire que pour ce qu'il est.
 *
 * L'API, elle, rend `"09:00"` : un écran affiche une horloge, pas un compte de
 * minutes, et le contrat partagé (`openingHoursEntrySchema`) le déclare ainsi.
 * La conversion a lieu **à la frontière**, ici.
 *
 * ## Pourquoi ces fonctions sont écrites ici et non importées
 *
 * `availability/availability.schedule.ts` porte les jumelles pour les horaires
 * du personnel. Un module n'importe pas un fichier profond d'un autre
 * (api-module §3) — même précédent, et même arbitrage, que la duplication
 * assumée de `OptionalPresent` entre `catalog/dto/validation.ts` et
 * `availability/dto/validation.ts`. Leur place définitive est `@spa/shared`,
 * qui les porte déjà (`wallMinutesOrNull`, `minutesToLocalTime`) : c'est #26 qui
 * câblera la dépendance et permettra de les retirer d'ici.
 */

/** Minutes d'une journée civile de 24 heures — la borne haute d'une plage. */
export const MINUTES_IN_CIVIL_DAY = 1440;

/**
 * Minuit **de fin de journée**, la seule heure de fermeture que `HH:MM` ne sait
 * pas dire.
 *
 * `23:59` perdrait une minute, et la borne haute d'une plage est **exclue** :
 * elle ne désigne pas une heure vécue mais la fin de l'intervalle. Un salon qui
 * ferme à minuit n'a pas d'autre façon exacte de le dire.
 */
export const END_OF_DAY_WALL_CLOCK = '24:00';

/** Heure murale `HH:MM`, 00:00 à 23:59 — le format de saisie. */
export const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Borne haute d'une plage : `HH:MM`, ou `24:00` pour minuit. */
export const CLOSING_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/**
 * Minutes depuis minuit local, ou `null` — la lecture **totale** d'une heure
 * murale.
 *
 * Totale, et non levante, parce qu'un validateur est précisément appelé sur ce
 * qui n'a pas encore été validé : lever ici ferait sortir une exception brute du
 * pipe de validation, et le 400 attendu deviendrait un 500. Même arbitrage que
 * `wallMinutesOrNull` du contrat partagé.
 */
export function wallClockToMinutesOrNull(value: unknown): number | null {
  if (typeof value !== 'string' || !CLOSING_TIME_PATTERN.test(value)) {
    return null;
  }
  if (value === END_OF_DAY_WALL_CLOCK) {
    return MINUTES_IN_CIVIL_DAY;
  }

  const [hours, minutes] = value.split(':');

  return Number(hours) * 60 + Number(minutes);
}

/**
 * L'inverse, borné à la journée civile : `540` → `"09:00"`, `1440` → `"24:00"`.
 *
 * Ce sens-ci n'a pas à être total : il lit une colonne bornée par
 * `tenant_opening_hours_minutes_check`, donc une valeur que la base garantit
 * déjà. Une valeur hors bornes serait une corruption, et la taire en rendant une
 * chaîne plausible serait pire que de la laisser paraître.
 */
export function minutesToWallClock(minutes: number): string {
  if (minutes === MINUTES_IN_CIVIL_DAY) {
    return END_OF_DAY_WALL_CLOCK;
  }

  const hours = Math.floor(minutes / 60);

  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
