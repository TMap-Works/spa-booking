/**
 * Mise en forme des instants et des montants pour l'affichage.
 *
 * Deux règles de `CLAUDE.md` se tiennent ici, et nulle part ailleurs dans le
 * front :
 *
 * - **tout est stocké en UTC, converti à l'affichage selon le fuseau du
 *   tenant.** Aucun composant n'appelle `toLocaleString` sans fuseau : ce serait
 *   celui du navigateur, et une cliente qui réserve en voyage verrait un
 *   rendez-vous décalé ;
 * - **l'argent est un entier plus une devise.** Aucun composant ne divise un
 *   montant lui-même.
 */

import { AMOUNT_MINOR_MAX, type CalendarDate, type Money, type TimeZone, type UtcInstant } from '@spa/shared';

/** Locale d'affichage du MVP — une seule, l'internationalisation est hors périmètre. */
const LOCALE = 'fr-FR';

/** « lundi 1 septembre 2026 à 11:00 », dans le fuseau de l'établissement. */
export function formatDateTimeInTimeZone(instant: UtcInstant, timeZone: TimeZone): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(instant));
}

/** « 11:00 » — pour une liste de créneaux, où la date est déjà en titre. */
export function formatTimeInTimeZone(instant: UtcInstant, timeZone: TimeZone): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, timeStyle: 'short' }).format(
    new Date(instant),
  );
}

/** « lundi 1 septembre 2026 » — l'en-tête d'une journée de créneaux. */
export function formatCalendarDate(date: CalendarDate): string {
  // Une date civile **est déjà** celle de l'établissement : le serveur l'a
  // découpée dans son fuseau (`dayAvailabilitySchema`). La reprojeter dans ce
  // fuseau la décalerait — `2026-09-01T12:00Z` lu à Auckland (UTC+12/+13) est
  // déjà le 2 septembre, et l'en-tête annoncerait un jour de plus que les
  // créneaux qu'il coiffe. On la met donc en forme telle quelle, en lisant
  // minuit UTC dans le référentiel UTC : la sortie ne dépend d'aucun fuseau.
  return new Intl.DateTimeFormat(LOCALE, { timeZone: 'UTC', dateStyle: 'full' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

/**
 * Le fuseau de l'établissement, tel qu'on le mentionne à un visiteur qui n'y est
 * pas — « heure de Indian/Antananarivo ».
 *
 * Rendu `null` quand le visiteur est déjà dans ce fuseau : la mention n'apprend
 * alors rien et alourdit chaque ligne du parcours.
 */
export function timeZoneMention(timeZone: TimeZone): string | null {
  const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return viewerTimeZone === timeZone ? null : `heure de ${timeZone.replace(/_/g, ' ')}`;
}

/**
 * Nombre de décimales d'une devise — deux pour l'euro, zéro pour l'ariary ou le
 * yen. Lu d'`Intl` plutôt que codé en dur : une table locale finirait par
 * diverger de la norme ISO 4217.
 */
function fractionDigitsOf(currency: string): number {
  // `maximumFractionDigits` est déclaré optionnel : le repli à deux décimales
  // est celui de la très grande majorité des devises, et il vaut mieux qu'une
  // exception au milieu d'un montant affiché.
  return (
    new Intl.NumberFormat(LOCALE, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * « 35,00 € » à partir de `{ amountMinor: 3500, currency: 'EUR' }`.
 *
 * La division par la puissance de dix est le seul flottant du parcours, et il
 * est cantonné à l'affichage : aucun calcul n'en dépend, `Intl` arrondit à la
 * précision de la devise, et les montants du MVP tiennent dans un entier 32 bits
 * — donc très en deçà du seuil où un `number` cesse d'être exact.
 */
export function formatMoney(amount: Money): string {
  const digits = fractionDigitsOf(amount.currency);

  return new Intl.NumberFormat(LOCALE, {
    style: 'currency',
    currency: amount.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount.amountMinor / 10 ** digits);
}

/**
 * Le montant tel qu'un champ de saisie le pré-remplit — « 35,00 », sans devise.
 *
 * Aucune division : l'entier est découpé **en chaîne**, partie entière d'un
 * côté, décimales de l'autre. Le formatage d'affichage (`formatMoney`) peut se
 * permettre le flottant parce que rien n'en dépend ; ici la valeur est
 * réinjectée dans un formulaire puis renvoyée à l'API, et un centième perdu à
 * l'aller reviendrait modifier le prix au retour.
 */
export function formatAmountInput(amount: Money): string {
  const digits = fractionDigitsOf(amount.currency);
  const sign = amount.amountMinor < 0 ? '-' : '';
  const raw = String(Math.abs(amount.amountMinor)).padStart(digits + 1, '0');
  const units = raw.slice(0, raw.length - digits);

  return digits === 0 ? `${sign}${units}` : `${sign}${units},${raw.slice(raw.length - digits)}`;
}

/**
 * « 35,00 » → `{ amountMinor: 3500, currency: 'EUR' }`, ou `null` si la saisie
 * n'est pas un montant de cette devise.
 *
 * **Aucun flottant nulle part** : `Number('35.00') * 100` rend `3499.9999…` sur
 * certaines valeurs, et un prix faux d'un centime est un prix faux. Les chiffres
 * sont donc concaténés en chaîne puis convertis une seule fois, en entier.
 *
 * Le nombre de décimales est celui de la devise — deux pour l'euro, zéro pour
 * l'ariary. Une saisie plus précise que la devise (« 35,005 » en euros) est
 * **refusée** plutôt qu'arrondie en silence : arrondir déciderait à la place de
 * la gérante du prix qu'elle vend.
 */
export function parseAmountInput(text: string, currency: string): Money | null {
  const digits = fractionDigitsOf(currency);
  // Espaces de groupement compris : la classe `\s` de JavaScript couvre
  // l'insécable (U+00A0) et l'espace fine insécable (U+202F), celles qu'`Intl`
  // insère dans « 1 200,00 € » et qui reviennent telles quelles quand on
  // recopie un montant affiché.
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(cleaned);

  if (match === null) {
    return null;
  }

  const units = match[1] ?? '';
  const fraction = match[2] ?? '';

  if (fraction.length > digits) {
    return null;
  }

  const amountMinor = Number(`${units}${fraction.padEnd(digits, '0')}`);

  return amountMinor > AMOUNT_MINOR_MAX ? null : { amountMinor, currency };
}

/** « 1 h 15 » à partir d'une durée en minutes. */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours === 0) {
    return `${String(rest)} min`;
  }

  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest).padStart(2, '0')}`;
}
