/**
 * Disponibilité — ce que la page publique interroge avant de réserver.
 *
 * La requête raisonne en **dates civiles** (`from`, `to`), la réponse en
 * **instants UTC** (`startsAt`, `endsAt`). Ce n'est pas une incohérence : le
 * client demande « les créneaux de la semaine du 3 mars », ce qui n'a de sens
 * que dans le calendrier du salon, et reçoit des points sur la ligne du temps,
 * qui sont les seuls comparables. La conversion se fait côté serveur, avec le
 * fuseau du tenant — le front n'a pas à le deviner.
 *
 * Un créneau retourné n'est **pas une réservation**. Il peut être pris entre
 * l'affichage et la validation ; c'est le rôle de la contrainte d'exclusion en
 * base de trancher, et de `SLOT_NO_LONGER_AVAILABLE` de le dire au front.
 */

import { z } from 'zod';

import { reasonSchema, uuidSchema } from '../common/identifiers';
import {
  calendarDateSchema,
  calendarDaysBetween,
  localTimeSchema,
  localTimeToMinutes,
  offsetDateTimeSchema,
  timeZoneSchema,
  utcInstantSchema,
  type CalendarDate,
} from '../common/time';
import { MAX_AVAILABILITY_RANGE_DAYS, MAX_TIME_OFF_RANGE_DAYS } from '../constants/limits';

/**
 * Interrogation des créneaux libres.
 *
 * `staffId` optionnel signifie « n'importe quel praticien qui pratique ce
 * soin » — c'est le cas le plus courant sur le parcours public, où la cliente
 * choisit d'abord une heure.
 *
 * Le `refine` borne la fenêtre à `MAX_AVAILABILITY_RANGE_DAYS`. Le calcul des
 * créneaux se fait à la demande : une plage non bornée est un déni de service à
 * une requête. Le refus sort en `AVAILABILITY_RANGE_TOO_WIDE` plutôt qu'en
 * temps de réponse qui s'allonge.
 *
 * ## `excludeAppointmentId` — le rendez-vous qu'un report déplace (#442)
 *
 * Un report d'un quart d'heure sur un soin d'une heure vise nécessairement un
 * créneau qui **chevauche le rendez-vous en cours de déplacement**. Le
 * calendrier n'y voyait qu'un praticien occupé, et ne le proposait donc jamais :
 * la cliente ne pouvait pas atteindre le geste que la route de report accepte
 * pourtant depuis #316.
 *
 * Ce champ nomme le rendez-vous à ne pas compter comme occupant, et lui seul. Il
 * est **facultatif** : la réservation ne le renseigne jamais, et son calcul est
 * rigoureusement celui d'avant.
 *
 * Trois bornes le tiennent, et elles sont écrites dans le README du module
 * `availability` :
 *
 * - il sert à **proposer**, jamais à garantir : l'unicité reste jugée par la
 *   contrainte d'exclusion `appointments_no_overlap` (booking-engine §1) ;
 * - il est **sans effet hors de l'établissement** : la lecture des rendez-vous
 *   est scopée, et l'identifiant d'un voisin n'y retire rien ;
 * - une requête qui le porte **ne voit pas le cache**, ni en lecture ni en
 *   écriture : la clé est `(serviceId, staffId, journée)` et ne dit rien d'une
 *   exclusion, si bien qu'une vue ainsi calculée se servirait ensuite à tous les
 *   lecteurs.
 */
export const availabilityQuerySchema = z
  .object({
    serviceId: uuidSchema,
    staffId: uuidSchema.optional(),
    from: calendarDateSchema,
    to: calendarDateSchema,
    excludeAppointmentId: uuidSchema.optional(),
  })
  .strict()
  .refine((query) => query.to >= query.from, {
    message: 'la fin de la plage ne peut pas précéder son début',
    path: ['to'],
  })
  .refine((query) => calendarDaysBetween(query.from, query.to) <= MAX_AVAILABILITY_RANGE_DAYS, {
    message: `la plage demandée dépasse ${String(MAX_AVAILABILITY_RANGE_DAYS)} jours`,
    path: ['to'],
  });

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/**
 * Un créneau proposable.
 *
 * `staffId` est présent même quand la requête n'en demandait aucun : la
 * réservation qui suit doit désigner un praticien précis, et le laisser choisir
 * au moment du `POST` rouvrirait la fenêtre de concurrence que le créneau
 * servait justement à fermer.
 *
 * ## Les bornes sont celles du **soin**, pas celles de l'agenda (#34)
 *
 * `startsAt` est l'instant où la cliente est prise en charge, `endsAt` celui où
 * elle repart : `endsAt - startsAt` vaut exactement `service.durationMinutes`.
 * Les tampons de préparation et de remise en état encadrent ce créneau et
 * occupent le praticien plus longtemps, mais ils ne sont **ni facturés ni
 * montrés** (CDC §2.3).
 *
 * Ce n'est pas une commodité d'affichage, c'est la seule forme calculable côté
 * client : `PublicServiceView` ne porte délibérément pas les tampons, si bien
 * qu'un front qui recevrait l'intervalle occupé n'aurait aucun moyen d'en
 * déduire l'heure du rendez-vous. Le serveur, lui, a les deux — c'est le moteur
 * de disponibilité qui place le soin dans l'agenda, et la création de rendez-vous
 * (#37) qui réécrit l'intervalle occupé à partir de la prestation.
 */
export const availabilitySlotSchema = z
  .object({
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
    staffId: uuidSchema,
  })
  .strict();

export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

/**
 * Créneaux d'une journée civile, regroupés pour l'affichage.
 *
 * Le regroupement est fait par le serveur et non par le front : découper une
 * liste d'instants UTC en journées demande le fuseau du tenant, et c'est
 * exactement le calcul qu'on ne veut pas voir réimplémenté côté navigateur.
 * Une journée sans créneau est renvoyée avec `slots: []` plutôt qu'omise — le
 * calendrier doit pouvoir afficher « complet » sans deviner les trous.
 */
export const dayAvailabilitySchema = z
  .object({
    date: calendarDateSchema,
    slots: z.array(availabilitySlotSchema),
  })
  .strict();

export type DayAvailability = z.infer<typeof dayAvailabilitySchema>;

export const availabilityResponseSchema = z
  .object({
    serviceId: uuidSchema,
    /** Fuseau ayant servi au découpage en journées — celui de l'établissement. */
    timezone: timeZoneSchema,
    days: z.array(dayAvailabilitySchema),
  })
  .strict();

export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

// ---------------------------------------------------------------------------
// Horaires récurrents du personnel — #32
// ---------------------------------------------------------------------------

/**
 * Jour de la semaine, en numérotation **ISO 8601** : `1` lundi … `7` dimanche.
 *
 * Deux raisons de ne pas reprendre le `0`-dimanche de `Date.prototype.getDay` :
 *
 * - `0` est *falsy*. Un `if (entry.weekday)` — ou un `weekday ?? défaut`, ou un
 *   `weekday || 1` — traiterait le dimanche comme une valeur absente, et le
 *   praticien qui travaille le dimanche verrait son horaire disparaître sans
 *   qu'aucun test de forme ne rougisse ;
 * - la semaine du calendrier public commence le lundi, comme celle d'ISO 8601 —
 *   qui est déjà le référentiel des dates de ce contrat.
 *
 * La conversion depuis `getUTCDay()` se fait par `isoWeekdayOf`, écrite une fois.
 */
export const isoWeekdaySchema = z
  .number()
  .int({ message: 'un jour de semaine s’exprime en entier' })
  .min(1, { message: 'jour de semaine ISO attendu : 1 (lundi) à 7 (dimanche)' })
  .max(7, { message: 'jour de semaine ISO attendu : 1 (lundi) à 7 (dimanche)' });

export type IsoWeekday = z.infer<typeof isoWeekdaySchema>;

/**
 * Jour de semaine ISO d'une **date civile du tenant**.
 *
 * Le fuseau n'entre pas dans ce calcul, et c'est le point : une date civile est
 * déjà exprimée dans le calendrier de l'établissement. « Le 3 mars » y est un
 * mardi, quelle que soit l'heure qu'il est à Paris — chercher l'instant
 * correspondant avant de lire son jour ferait au contraire dépendre le résultat
 * du fuseau de la machine, et déplacerait un horaire d'un jour entier.
 */
export function isoWeekdayOf(date: CalendarDate): IsoWeekday {
  const parsed = calendarDateSchema.parse(date);
  const day = new Date(`${parsed}T00:00:00Z`).getUTCDay();

  // `getUTCDay` rend 0 pour dimanche ; ISO 8601 le numérote 7.
  return day === 0 ? 7 : day;
}

/** Minutes d'une journée civile de 24 heures — la borne haute d'une plage. */
export const MINUTES_IN_CIVIL_DAY = 1440;

/**
 * Minuit **de fin de journée**, la seule heure de fermeture que `HH:MM` ne sait
 * pas dire.
 *
 * `localTimeSchema` s'arrête à `23:59`, et c'est juste pour une heure murale :
 * `24:00` n'existe pas sur une horloge. Mais la borne haute d'une plage est
 * **exclue** — elle ne désigne pas une heure vécue, elle désigne la fin de
 * l'intervalle. Un salon qui ferme à minuit n'a donc aucune façon exacte de le
 * dire en `HH:MM` : `23:59` perdrait une minute et, à un pas de créneau de
 * quinze minutes, le dernier créneau de la soirée avec elle.
 *
 * Le littéral est admis pour la **fin** seulement. Un début à `24:00` désignerait
 * une plage vide, que le `refine` refuse de toute façon.
 */
export const END_OF_DAY_LOCAL_TIME = '24:00';

export const scheduleEndTimeSchema = z.union([
  localTimeSchema,
  z.literal(END_OF_DAY_LOCAL_TIME),
]);

export type ScheduleEndTime = z.infer<typeof scheduleEndTimeSchema>;

/** Minutes depuis minuit local d'une borne haute de plage — `24:00` vaut 1440. */
export function scheduleEndToMinutes(time: ScheduleEndTime): number {
  return time === END_OF_DAY_LOCAL_TIME ? MINUTES_IN_CIVIL_DAY : localTimeToMinutes(time);
}

/**
 * La même lecture, **totale** : `null` plutôt qu'une exception sur une valeur
 * mal formée.
 *
 * Nécessaire parce qu'un `refine` de Zod s'exécute encore lorsque le corps de
 * l'objet est *dirty* — c'est-à-dire lorsqu'un champ a déjà échoué à sa propre
 * validation. Un `refine` qui lèverait alors ferait sortir une exception brute
 * de `safeParse`, là où l'appelant attend un verdict : le 400 attendu
 * deviendrait un 500.
 *
 * Exportée parce que les plages d'ouverture de l'établissement
 * (`openingHoursEntrySchema`, #343) partagent exactement cette forme d'heure
 * murale et ont le même `refine` à écrire. Une seconde copie aurait fini par
 * lire `24:00` autrement que celle-ci, et deux plages identiques auraient été
 * jugées différemment selon la table où elles sont saisies.
 */
export function wallMinutesOrNull(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (value === END_OF_DAY_LOCAL_TIME) {
    return MINUTES_IN_CIVIL_DAY;
  }

  const parsed = localTimeSchema.safeParse(value);

  return parsed.success ? localTimeToMinutes(parsed.data) : null;
}

/**
 * Une plage de travail récurrente : ce jour-là, de telle à telle heure murale.
 *
 * Les deux bornes sont des **heures murales** (`HH:MM`) et non des instants :
 * « ouvre à 09:00 » vaut `08:00Z` en hiver et `07:00Z` en été à Paris. Figer
 * l'un des deux décalerait l'agenda six mois par an — la conversion se fait à la
 * volée, date par date, côté serveur.
 *
 * La borne haute est **exclue**, comme celle d'un créneau : deux plages
 * adjacentes (`09:00–12:00` et `12:00–18:00`) ne se chevauchent pas.
 */
export const staffScheduleEntrySchema = z
  .object({
    weekday: isoWeekdaySchema,
    startsAt: localTimeSchema,
    endsAt: scheduleEndTimeSchema,
  })
  .strict()
  .refine(
    (entry) => {
      const start = wallMinutesOrNull(entry.startsAt);
      const end = wallMinutesOrNull(entry.endsAt);

      return start !== null && end !== null && end > start;
    },
    {
      message: 'la fin d’une plage doit être strictement postérieure à son début',
      path: ['endsAt'],
    },
  );

export type StaffScheduleEntry = z.infer<typeof staffScheduleEntrySchema>;

/**
 * Nombre maximal de plages dans une semaine de travail.
 *
 * Quatre coupures par jour laissent largement la place à la coupure méridienne
 * du CDC — et au salon qui rouvre en soirée — tout en bornant le coût du calcul
 * de créneaux, qui parcourt ces plages pour chaque journée demandée.
 */
export const MAX_STAFF_SCHEDULE_ENTRIES = 28;

/**
 * `true` si deux plages du **même jour** se recouvrent, borne haute exclue.
 *
 * Une plage dont les bornes ne se lisent pas est **ignorée** plutôt que refusée
 * ici : sa propre validation l'a déjà rejetée, et lever une exception depuis un
 * `refine` transformerait le 400 attendu en 500.
 */
export function staffScheduleEntriesOverlap(entries: readonly StaffScheduleEntry[]): boolean {
  const byWeekday = new Map<IsoWeekday, { start: number; end: number }[]>();

  for (const entry of entries) {
    const start = wallMinutesOrNull(entry.startsAt);
    const end = wallMinutesOrNull(entry.endsAt);

    if (start === null || end === null) {
      continue;
    }

    const range = { start, end };
    const sameDay = byWeekday.get(entry.weekday) ?? [];

    // Adjacence tolérée (`end === start`) : c'est une journée continue décrite
    // en deux morceaux, pas un double emploi.
    if (sameDay.some((other) => range.start < other.end && other.start < range.end)) {
      return true;
    }

    sameDay.push(range);
    byWeekday.set(entry.weekday, sameDay);
  }

  return false;
}

/**
 * Remplacement **intégral** de la semaine de travail d'un praticien.
 *
 * Un `PUT` de la semaine entière, et non un CRUD plage par plage : la seule
 * invariante qui compte — aucune plage ne se recouvre — porte sur l'ensemble, et
 * la vérifier à chaque ajout ferait dépendre le résultat de l'ordre des appels.
 * Un tableau vide est licite : c'est ainsi qu'un praticien cesse d'être
 * proposable sans être désactivé.
 */
export const setStaffScheduleRequestSchema = z
  .object({
    entries: z.array(staffScheduleEntrySchema).max(MAX_STAFF_SCHEDULE_ENTRIES, {
      message: `au plus ${String(MAX_STAFF_SCHEDULE_ENTRIES)} plages par semaine`,
    }),
  })
  .strict()
  .refine((request) => !staffScheduleEntriesOverlap(request.entries), {
    message: 'deux plages du même jour se recouvrent',
    path: ['entries'],
  });

export type SetStaffScheduleRequest = z.infer<typeof setStaffScheduleRequestSchema>;

/**
 * La semaine de travail telle que l'API la rend.
 *
 * `timezone` accompagne les heures murales parce que sans lui elles ne veulent
 * rien dire : c'est le fuseau dans lequel l'écran doit les lire, et celui dans
 * lequel le serveur les convertira. Il est **rendu**, jamais accepté en entrée —
 * il appartient à l'établissement, pas à la charge utile.
 */
export const staffScheduleSchema = z
  .object({
    staffId: uuidSchema,
    timezone: timeZoneSchema,
    entries: z.array(staffScheduleEntrySchema),
  })
  .strict();

export type StaffSchedule = z.infer<typeof staffScheduleSchema>;

/**
 * Jours de fermeture **récurrents** de l'établissement — « fermé le dimanche et
 * le lundi ».
 *
 * Ils s'appliquent à tous les praticiens : un horaire récurrent posé sur un jour
 * de fermeture ne produit aucune fenêtre de travail. Décrire la fermeture ici
 * plutôt que d'exiger qu'elle soit retirée de chaque semaine de travail évite
 * qu'un praticien embauché après coup rouvre le salon à lui seul.
 *
 * Les fermetures **ponctuelles** — un jour férié, une semaine de congés — ne
 * sont pas de cette nature : elles portent une date et relèvent des plages
 * bloquées (#33).
 */
export const closingDaysSchema = z
  .object({
    weekdays: z.array(isoWeekdaySchema),
  })
  .strict();

export type ClosingDays = z.infer<typeof closingDaysSchema>;

export const setClosingDaysRequestSchema = z
  .object({
    weekdays: z
      .array(isoWeekdaySchema)
      .max(7, { message: 'un jour de semaine ne se déclare qu’une fois' })
      .refine((weekdays) => new Set(weekdays).size === weekdays.length, {
        message: 'un jour de semaine ne se déclare qu’une fois',
      }),
  })
  .strict();

export type SetClosingDaysRequest = z.infer<typeof setClosingDaysRequestSchema>;

// ---------------------------------------------------------------------------
// Plages bloquées et congés — #33
// ---------------------------------------------------------------------------

/**
 * Une indisponibilité de praticien, telle que le back-office la manipule.
 *
 * Plage bloquée ponctuelle et congé sur plusieurs jours sont la **même** forme :
 * un intervalle `[startsAt, endsAt[` en UTC. Seule leur durée les distingue, et
 * aucun consommateur n'a de raison de les traiter différemment — le moteur de
 * créneaux les soustrait des fenêtres de travail sans savoir laquelle il tient.
 *
 * `reason` est nullable et **ne sort jamais du back-office** : aucune projection
 * publique ne le porte, et `staffBusyIntervalSchema` — la forme que consomme le
 * calcul de créneaux — ne le déclare pas. Voir la note qui l'accompagne.
 */
export const staffTimeOffSchema = z
  .object({
    id: uuidSchema,
    staffId: uuidSchema,
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
    reason: reasonSchema.nullable(),
  })
  .strict();

export type StaffTimeOff = z.infer<typeof staffTimeOffSchema>;

/**
 * Un intervalle d'occupation, tel que le calcul de créneaux le consomme.
 *
 * **Sans `reason`, et c'est tout l'objet de ce schéma.** Le motif d'une absence
 * — « arrêt maladie », « rendez-vous médical » — est une donnée de gestion du
 * personnel : elle regarde le back-office, jamais la page de réservation
 * publique où le créneau manquant se manifeste. Une projection qui le
 * transporterait jusqu'au moteur le rendrait disponible à tout ce qui vient
 * après, et c'est ainsi qu'un motif finit dans une réponse publique.
 *
 * `id` en est également absent : le moteur soustrait des intervalles, il n'a
 * aucune ligne à désigner.
 */
export const staffBusyIntervalSchema = z
  .object({
    staffId: uuidSchema,
    startsAt: utcInstantSchema,
    endsAt: utcInstantSchema,
  })
  .strict();

export type StaffBusyInterval = z.infer<typeof staffBusyIntervalSchema>;

/**
 * `true` si l'intervalle est non vide et ne dépasse pas `MAX_TIME_OFF_RANGE_DAYS`.
 *
 * Les deux bornes sont vérifiées ensemble parce qu'elles décrivent la même
 * propriété — « cet intervalle est plausible » — et qu'un appelant qui n'en
 * vérifierait qu'une laisserait passer l'autre. Le refus sort en
 * `TIME_OFF_RANGE_INVALID`, `details.rule` disant laquelle a cédé.
 */
function isPlausibleTimeOffRange(startsAt: string, endsAt: string): boolean {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);

  return end > start && end - start <= MAX_TIME_OFF_RANGE_DAYS * 86_400_000;
}

/**
 * Pose d'une plage bloquée ou d'un congé.
 *
 * Les bornes entrent en **date-heure à offset explicite** et non en date civile,
 * ce qui n'est pas un détail de format : « le 3 août » n'est pas un instant, et
 * un congé du 3 au 5 ne commence pas au même moment à Papeete et à Paris. C'est
 * l'appelant — qui connaît le fuseau de l'établissement, l'API le lui rend — qui
 * pose les bornes ; le serveur ne devine jamais un fuseau manquant.
 *
 * Le `refine` est le seul endroit du contrat où la règle vit : elle vaut à la
 * création comme à la modification, et l'écrire deux fois la laisserait diverger.
 */
export const createStaffTimeOffRequestSchema = z
  .object({
    staffId: uuidSchema,
    startsAt: offsetDateTimeSchema,
    endsAt: offsetDateTimeSchema,
    reason: reasonSchema.optional(),
  })
  .strict()
  .refine((body) => isPlausibleTimeOffRange(body.startsAt, body.endsAt), {
    message: `la fin doit suivre le début, et l’absence ne peut excéder ${String(MAX_TIME_OFF_RANGE_DAYS)} jours`,
    path: ['endsAt'],
  });

export type CreateStaffTimeOffRequest = z.infer<typeof createStaffTimeOffRequestSchema>;

/**
 * Modification d'une absence — un **patch** : un champ absent n'est pas touché.
 *
 * `staffId` n'y figure pas, et c'est délibéré : déplacer une absence d'un
 * praticien à un autre n'est pas une modification, c'est une absence retirée et
 * une autre posée. L'autoriser ferait porter à une seule requête deux
 * invalidations de cache et deux agendas rouverts, pour un geste que personne ne
 * fait.
 *
 * `reason` accepte `null` — il vaut « efface ce motif ». Les bornes, elles,
 * refusent `null` : une absence sans début n'existe pas.
 */
export const updateStaffTimeOffRequestSchema = z
  .object({
    startsAt: offsetDateTimeSchema.optional(),
    endsAt: offsetDateTimeSchema.optional(),
    reason: reasonSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (patch) =>
      patch.startsAt === undefined ||
      patch.endsAt === undefined ||
      isPlausibleTimeOffRange(patch.startsAt, patch.endsAt),
    {
      message: `la fin doit suivre le début, et l’absence ne peut excéder ${String(MAX_TIME_OFF_RANGE_DAYS)} jours`,
      path: ['endsAt'],
    },
  );

export type UpdateStaffTimeOffRequest = z.infer<typeof updateStaffTimeOffRequestSchema>;

/**
 * Interrogation du planning d'absences.
 *
 * La fenêtre est **obligatoire** et bornée, pour la même raison que celle de
 * `availabilityQuerySchema` : sans elle, un établissement de dix ans d'historique
 * rendrait dix ans d'absences à chaque ouverture du planning. Un intervalle est
 * retenu dès qu'il **recoupe** la fenêtre, borne haute exclue — un congé commencé
 * le mois dernier et courant toujours doit apparaître au planning de ce mois-ci.
 *
 * `staffId` absent signifie « tout l'établissement », ce qu'affiche la vue
 * calendrier du back-office.
 */
export const staffTimeOffQuerySchema = z
  .object({
    staffId: uuidSchema.optional(),
    from: offsetDateTimeSchema,
    to: offsetDateTimeSchema,
  })
  .strict()
  .refine((query) => isPlausibleTimeOffRange(query.from, query.to), {
    message: `la fin de la fenêtre doit suivre son début, sans excéder ${String(MAX_TIME_OFF_RANGE_DAYS)} jours`,
    path: ['to'],
  });

export type StaffTimeOffQuery = z.infer<typeof staffTimeOffQuerySchema>;
