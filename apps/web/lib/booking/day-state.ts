/**
 * Ce qu'une journée dit d'elle-même, au-delà de sa date (#1049).
 *
 * ## Pourquoi ce module existe
 *
 * Le choix de la date se rend maintenant à **deux** endroits : la bande de jours
 * (`components/booking/date-band.tsx`), qui est le contrôle de premier plan, et
 * le calendrier mensuel (`components/booking/availability-calendar.tsx`), qu'un
 * bouton ouvre en panneau pour aller plus loin. Les deux peignent les mêmes
 * journées, et doivent donc en dire exactement la même chose — « fermé » là où le
 * salon n'ouvre pas, « complet » là où il ouvre sans place, « hors de la période
 * de réservation » au-delà de la fenêtre.
 *
 * Deux implémentations de cette règle, ce sont deux vocabulaires qui divergent au
 * premier correctif — c'est le raisonnement qui a déjà fait remonter `SlotPicker`
 * puis `AvailabilityCalendar` dans `components/booking/` (#622, #827). Elle vit
 * donc ici, hors de tout composant, et s'éprouve sans monter de DOM.
 *
 * ## Ce qu'il ne décide pas
 *
 * Rien de ce qui touche à l'agenda. Les horaires publiés ne **nomment** qu'une
 * journée dont le moteur a déjà dit qu'elle n'avait aucun créneau — voir
 * [`opening-days.ts`](opening-days.ts), dont l'avertissement vaut mot pour mot
 * ici.
 */

import type { CalendarDate, IsoWeekday } from '@spa/shared';

import { isPublishedClosedDay } from './opening-days';
import { isWithinWindow, monthOf, type BookingWindow, type CalendarMonth } from './month-grid';

/**
 * Ce qu'une case dit d'elle-même, au-delà de sa date.
 *
 * `hors-fenetre` s'est longtemps appelé `ferme`, du temps où le calendrier
 * n'avait qu'un seul mot pour « on ne peut pas réserver ce jour-là ». Les deux
 * états coexistent depuis #742 et ne disent pas la même chose : l'un porte sur
 * la période que le produit ouvre à la réservation, l'autre sur les horaires que
 * le salon publie.
 */
export type DayState = 'chargement' | 'hors-fenetre' | 'ferme' | 'complet' | 'libre';

/** Ce que le nom accessible d'une case ajoute à sa date, hors journée libre. */
export const DAY_STATE_LABEL: Record<Exclude<DayState, 'libre'>, string> = {
  chargement: 'disponibilités en cours de chargement',
  'hors-fenetre': 'hors de la période de réservation',
  ferme: 'fermé',
  complet: 'complet',
};

/** « 3 créneaux », « 1 créneau » — le pluriel se voit à l'écran. */
export function slotCountLabel(count: number): string {
  return count === 1 ? '1 créneau' : `${String(count)} créneaux`;
}

/** Ce qu'il faut savoir du mois affiché pour qualifier l'une de ses journées. */
export interface DayStateContext {
  /**
   * Le mois chargé, `YYYY-MM`.
   *
   * Une date qui n'en relève pas n'est dans aucune table de comptes : la fenêtre
   * demandée au serveur est celle du mois visible, et « le serveur n'a rien dit »
   * n'est pas « complet ». Seules les flèches y mènent — elles traversent les
   * mois —, et la traiter comme pleine ferait franchir le 30 septembre au focus
   * sans que le 1er octobre se retienne.
   */
  readonly month: CalendarMonth;
  /** Les bornes réservables — au-delà, la journée est rendue mais inerte. */
  readonly bounds: BookingWindow;
  /**
   * Le nombre de créneaux par date, `null` tant que la réponse n'est pas là.
   *
   * « On ne sait pas encore » et « il n'y a rien » ne se rendent ni ne se
   * parcourent pareil : c'est ce qui permet au choix de la date de rester
   * opérable pendant le chargement (`states.md` étape 3). Une date absente de la
   * table est une date dont le serveur n'a rien dit, donc une date sans créneau.
   */
  readonly slotCounts: ReadonlyMap<CalendarDate, number> | null;
  /** Les jours de semaine que le salon annonce ouverts — `null` s'il n'a rien publié. */
  readonly openWeekdays: ReadonlySet<IsoWeekday> | null;
}

/**
 * L'état d'une journée.
 *
 * Hors fenêtre prime sur tout le reste : une date de novembre n'est pas
 * « complète », elle n'est pas encore ouverte à la réservation, et les deux ne se
 * disent pas pareil.
 *
 * « Fermé » vient **en dernier**, et ne fait que renommer ce qui serait
 * « complet » : les horaires publiés décrivent la vitrine, pas l'agenda (#742).
 * Une journée que le moteur rend avec des créneaux reste donc libre, quoi
 * qu'annonce la semaine d'ouverture — un praticien qui ouvre exceptionnellement
 * un samedi ne verra pas son agenda masqué par un horaire d'affichage.
 */
export function dayStateOf(date: CalendarDate, context: DayStateContext): DayState {
  if (!isWithinWindow(date, context.bounds)) {
    return 'hors-fenetre';
  }

  if (context.slotCounts === null || monthOf(date) !== context.month) {
    return 'chargement';
  }

  if ((context.slotCounts.get(date) ?? 0) > 0) {
    return 'libre';
  }

  return isPublishedClosedDay(date, context.openWeekdays) ? 'ferme' : 'complet';
}

/**
 * Ce que le nom accessible d'une journée ajoute à sa date — « 2 créneaux »,
 * « fermé », « complet ».
 *
 * `slotCount` ne peut pas manquer sur une journée libre — l'état en dérive —,
 * mais le compilateur ne le sait pas depuis deux valeurs indépendantes.
 */
export function dayStateSaid(state: DayState, slotCount: number | null): string {
  return state === 'libre' ? slotCountLabel(slotCount ?? 0) : DAY_STATE_LABEL[state];
}

/** Une journée se retient quand elle a — ou peut encore avoir — quelque chose à montrer. */
export function isSelectableState(state: DayState): boolean {
  return state === 'libre' || state === 'chargement';
}
