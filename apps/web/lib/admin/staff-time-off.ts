/**
 * Plages bloquées et congés, côté écran (#53, troisième critère).
 *
 * ## Le problème que ce module résout, et il n'est pas cosmétique
 *
 * L'API refuse une date nue. `createStaffTimeOffRequestSchema` exige des bornes
 * en ISO 8601 **avec offset explicite**, et son en-tête dit pourquoi : « du 3 au
 * 5 août » n'est pas un intervalle — il ne commence pas au même instant à
 * Papeete et à Paris. Le serveur ne devine jamais un fuseau manquant ; c'est à
 * l'appelant, qui connaît celui de l'établissement puisque l'API le lui rend, de
 * poser des bornes non ambiguës.
 *
 * Or le formulaire, lui, saisit bien une date civile et une heure murale : c'est
 * ce qu'une gérante écrit sur un planning. Tout ce module tient dans cette
 * conversion — `2026-08-03` + `00:00` + `Indian/Antananarivo` →
 * `2026-08-03T00:00:00+03:00` — et dans sa réciproque à l'affichage.
 *
 * **Le fuseau du navigateur n'entre jamais dans ce calcul.** Une gérante en
 * déplacement qui pose les congés de son salon doit obtenir les mêmes bornes que
 * si elle était au comptoir ; c'est exactement ce qu'un `new Date(...)` nu
 * casserait, et pourquoi chaque fonction d'ici réclame le fuseau en paramètre.
 */

import {
  MAX_TIME_OFF_RANGE_DAYS,
  createStaffTimeOffRequestSchema,
  type CalendarDate,
  type CreateStaffTimeOffRequest,
  type StaffTimeOff,
  type TimeZone,
  type UtcInstant,
} from '@spa/shared';

import { addCalendarDays } from '../booking/calendar';

const LOCALE = 'fr-FR';

/** Les composantes d'un instant, lues dans le fuseau de l'établissement. */
export interface LocalParts {
  readonly date: CalendarDate;
  /** Heure murale `HH:MM`, celle qu'affiche l'horloge du salon. */
  readonly time: string;
}

/**
 * Le formateur qui sert de règle à tout ce module.
 *
 * `en-US` et `hour12: false` : la locale n'a ici aucune vocation d'affichage,
 * seulement de découpage — on lit des nombres, pas une phrase. Une locale
 * française rendrait les mêmes valeurs, mais `en-US` est celle dont le
 * comportement en `2-digit` est le plus stable d'une plateforme à l'autre.
 */
function partsFormatter(timeZone: TimeZone): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function partValue(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? '00';
}

/** L'instant, lu dans le fuseau de l'établissement. */
export function localPartsOf(instant: UtcInstant | Date, timeZone: TimeZone): LocalParts {
  const parts = partsFormatter(timeZone).formatToParts(
    instant instanceof Date ? instant : new Date(instant),
  );
  // `hour12: false` rend `24` pour minuit sur certaines plateformes — c'est le
  // même jour, à zéro heure. Le laisser passer produirait `2026-08-03T24:00`,
  // que `OFFSET_DATE_TIME_PATTERN` refuse.
  const hour = Number(partValue(parts, 'hour')) % 24;

  return {
    date: `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(parts, 'day')}`,
    time: `${String(hour).padStart(2, '0')}:${partValue(parts, 'minute')}`,
  };
}

/** Décalage du fuseau à cet instant, en minutes — `+180` pour UTC+3. */
function offsetMinutesAt(instant: Date, timeZone: TimeZone): number {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const asIfUtc = Date.UTC(
    Number(partValue(parts, 'year')),
    Number(partValue(parts, 'month')) - 1,
    Number(partValue(parts, 'day')),
    Number(partValue(parts, 'hour')) % 24,
    Number(partValue(parts, 'minute')),
    Number(partValue(parts, 'second')),
  );

  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/** `+03:00`, `-04:30`, `+00:00` — la forme qu'attend `OFFSET_DATE_TIME_PATTERN`. */
export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);

  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/**
 * Une date civile et une heure murale du salon, rendues en date-heure à offset
 * explicite.
 *
 * ## Deux passes, et la seconde n'est pas une précaution superflue
 *
 * Le décalage d'un fuseau dépend de l'instant, et l'instant est justement ce
 * qu'on cherche : la poule et l'œuf. On part donc de l'heure murale lue *comme
 * si* elle était UTC, on en tire un premier décalage, on corrige l'instant, puis
 * on relit le décalage à cet instant-là. Sans la seconde passe, une plage posée
 * le jour d'un changement d'heure repartirait avec le décalage de la veille — et
 * l'absence commencerait une heure trop tôt ou trop tard, dans l'écran même dont
 * l'objet est de fermer un agenda.
 */
export function offsetDateTimeAt(date: CalendarDate, time: string, timeZone: TimeZone): string {
  const naive = Date.parse(`${date}T${time}:00Z`);
  const firstGuess = offsetMinutesAt(new Date(naive), timeZone);
  const offset = offsetMinutesAt(new Date(naive - firstGuess * 60_000), timeZone);

  return `${date}T${time}:00${formatUtcOffset(offset)}`;
}

/**
 * La fenêtre d'interrogation du planning d'absences.
 *
 * `from` et `to` sont **obligatoires** côté API et bornés à
 * `MAX_TIME_OFF_RANGE_DAYS` : sans eux, un salon de dix ans d'historique rendrait
 * dix ans d'absences à chaque ouverture de la fiche. La fenêtre part de
 * minuit local du jour demandé — jamais de « maintenant » —, sans quoi un congé
 * commencé ce matin disparaîtrait de l'écran à midi.
 */
export function timeOffWindow(
  from: CalendarDate,
  days: number,
  timeZone: TimeZone,
): { readonly from: string; readonly to: string } {
  const span = Math.min(Math.max(days, 1), MAX_TIME_OFF_RANGE_DAYS);

  return {
    from: offsetDateTimeAt(from, '00:00', timeZone),
    to: offsetDateTimeAt(addCalendarDays(from, span), '00:00', timeZone),
  };
}

/**
 * `true` si l'absence couvre des journées pleines du salon.
 *
 * Les deux bornes à minuit local : c'est la forme d'un congé, par opposition à
 * la plage bloquée d'un après-midi. La distinction n'est pas décorative — elle
 * décide de l'écriture affichée, et « 2 – 16 sept. » se lit infiniment mieux que
 * « 1 sept. 21:00 → 15 sept. 21:00 » pour la même donnée.
 */
export function isFullDayTimeOff(timeOff: StaffTimeOff, timeZone: TimeZone): boolean {
  return (
    localPartsOf(timeOff.startsAt, timeZone).time === '00:00' &&
    localPartsOf(timeOff.endsAt, timeZone).time === '00:00'
  );
}

/** « 2 septembre 2026 » — une date civile du salon, mise en forme telle quelle. */
function formatDay(date: CalendarDate): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * L'absence, écrite comme un planning l'écrit.
 *
 * La borne haute est **exclue** : un congé du 2 au 16 se termine à minuit local
 * du 17. Afficher `17` ferait croire à un jour de congé de plus — et c'est
 * exactement le genre d'écart qu'une gérante découvre le jour où une cliente
 * n'a pas pu réserver.
 */
export function formatTimeOff(timeOff: StaffTimeOff, timeZone: TimeZone): string {
  const start = localPartsOf(timeOff.startsAt, timeZone);
  const end = localPartsOf(timeOff.endsAt, timeZone);

  if (isFullDayTimeOff(timeOff, timeZone)) {
    const lastDay = addCalendarDays(end.date, -1);

    return start.date === lastDay
      ? formatDay(start.date)
      : `${formatDay(start.date)} – ${formatDay(lastDay)}`;
  }

  return start.date === end.date
    ? `${formatDay(start.date)}, ${start.time} – ${end.time}`
    : `${formatDay(start.date)} ${start.time} – ${formatDay(end.date)} ${end.time}`;
}

/** La saisie du formulaire d'absence, avant toute conversion. */
export interface TimeOffDraft {
  readonly staffId: string;
  readonly fromDate: string;
  readonly fromTime: string;
  readonly toDate: string;
  readonly toTime: string;
  readonly reason: string;
}

export type TimeOffValidation =
  | { readonly ok: true; readonly request: CreateStaffTimeOffRequest }
  | { readonly ok: false; readonly field: keyof TimeOffDraft | null; readonly message: string };

/**
 * La saisie convertie en corps d'API, jugée par **le schéma du contrat** — la
 * même règle des deux côtés, écrite une fois (web-frontend §4).
 *
 * Le champ fautif est rendu avec le message pour que l'écran le pose sous le
 * contrôle concerné, jamais en bloc en haut de page.
 */
export function validateTimeOffDraft(draft: TimeOffDraft, timeZone: TimeZone): TimeOffValidation {
  if (draft.fromDate === '') {
    return { ok: false, field: 'fromDate', message: 'Indiquez le premier jour de l’absence.' };
  }
  if (draft.toDate === '') {
    return { ok: false, field: 'toDate', message: 'Indiquez le jour de reprise.' };
  }

  const parsed = createStaffTimeOffRequestSchema.safeParse({
    staffId: draft.staffId,
    startsAt: offsetDateTimeAt(draft.fromDate, draft.fromTime === '' ? '00:00' : draft.fromTime, timeZone),
    endsAt: offsetDateTimeAt(draft.toDate, draft.toTime === '' ? '00:00' : draft.toTime, timeZone),
    ...(draft.reason.trim() === '' ? {} : { reason: draft.reason.trim() }),
  });

  if (parsed.success) {
    return { ok: true, request: parsed.data };
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path[0];

  return {
    ok: false,
    field: path === 'endsAt' ? 'toDate' : path === 'startsAt' ? 'fromDate' : path === 'reason' ? 'reason' : null,
    message: issue?.message ?? 'L’absence saisie est invalide.',
  };
}

/**
 * Le jour de reprise proposé par défaut : le lendemain du premier jour.
 *
 * La borne haute étant exclue, c'est ainsi que s'écrit « un jour de congé ».
 * Laisser le champ vide obligerait à expliquer l'exclusion à chaque saisie ; le
 * pré-remplir la montre.
 */
export function defaultReturnDate(fromDate: CalendarDate): CalendarDate {
  return addCalendarDays(fromDate, 1);
}
