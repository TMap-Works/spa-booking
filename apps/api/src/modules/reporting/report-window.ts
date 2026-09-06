import {
  MAX_REPORT_WINDOW_DAYS,
  ReportWindowInvalidError,
  ReportWindowTooWideError,
} from './reporting.errors';
import type { ReportWindow } from './reporting.types';

/**
 * Les deux règles que partagent les trois rapports de #74.
 *
 * Elles vivent ici plutôt que recopiées dans chaque méthode de
 * `ReportingService` parce qu'elles doivent rester **identiques** : trois
 * écrans du même tableau de bord qui n'auraient pas la même idée d'une fenêtre
 * valable se contrediraient sur la même période — le revenu du mois répondrait
 * là où le volume du mois refuserait.
 *
 * Jumelles d'`assertOrderedWindow` de `payments/history.ts`, et volontairement
 * séparées : un module n'importe pas un fichier profond d'un autre
 * (api-module §3). La différence de fond justifie de toute façon la seconde
 * écriture — les bornes sont ici **obligatoires**, et il s'y ajoute un plafond
 * d'étendue que l'historique paginé n'a pas besoin d'avoir.
 *
 * Fonctions pures, sans dépendance Nest : elles s'exercent sans monter quoi que
 * ce soit.
 */

/** Millisecondes dans une journée de 24 h — l'unité du calcul d'étendue. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * L'étendue d'une fenêtre en jours, arrondie **au supérieur**.
 *
 * Une durée en millisecondes divisée par 24 h, et non un décompte de dates
 * civiles : le plafond borne le volume de lignes à balayer, qui se mesure en
 * temps écoulé, pas en changements de quantième. L'arrondi au supérieur fait
 * qu'une fenêtre d'une heure compte pour un jour — c'est ce qu'on veut, une
 * fenêtre non vide ne pesant jamais zéro.
 *
 * Les heures d'été ne l'égarent pas : les deux bornes sont des instants absolus,
 * et un jour de 23 h ne se voit pas dans leur différence.
 */
export function windowSpanInDays(window: ReportWindow): number {
  return Math.ceil((window.to.getTime() - window.from.getTime()) / MS_PER_DAY);
}

/**
 * Refuse une fenêtre inexploitable — à l'envers, vide, ou trop large.
 *
 * L'ordre des deux contrôles compte : une fenêtre inversée a une étendue
 * négative, que le plafond laisserait passer sans rien dire. C'est
 * `ReportWindowInvalidError` qui doit répondre là, pas un rapport vide.
 *
 * @throws {ReportWindowInvalidError} `from >= to` — la borne haute étant exclue,
 * une fenêtre dont les deux bornes coïncident est vide elle aussi.
 * @throws {ReportWindowTooWideError} l'étendue dépasse
 * {@link MAX_REPORT_WINDOW_DAYS}.
 */
export function assertReportWindow(window: ReportWindow): void {
  if (window.from.getTime() >= window.to.getTime()) {
    throw new ReportWindowInvalidError();
  }

  const days = windowSpanInDays(window);
  if (days > MAX_REPORT_WINDOW_DAYS) {
    throw new ReportWindowTooWideError(days);
  }
}
