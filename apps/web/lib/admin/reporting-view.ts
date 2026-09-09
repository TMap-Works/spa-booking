/**
 * Ce que l'écran de reporting affiche, calculé hors de React (#75).
 *
 * Séparé des composants pour la raison qui sépare `navigation.ts` du rail : ce
 * sont des décisions — quel indicateur porte quel chiffre, ce qu'un filtre
 * change et ce qu'il ne peut pas changer — et elles se testent sans monter un
 * arbre ni simuler un routeur.
 *
 * ## Trois rapports, cinq lectures, et une raison
 *
 * L'API sert le volume sur **un** axe à la fois (`day`, `staff`, `service`) et
 * ne prend aucun filtre : il n'y a ni `?staffId`, ni `?serviceId` sur
 * `GET /reports/appointments`. Les filtres de cet écran sont donc obtenus en
 * demandant les trois axes et en lisant la ligne voulue — et non en ajoutant un
 * paramètre à une route qui ne l'a pas. Ajouter cet endpoint serait un ticket
 * d'API ; #75 est un ticket `apps/web`, et le README du module `reporting` le
 * dit explicitement.
 *
 * ## Ce qu'un filtre ne peut pas faire, et pourquoi on le dit plutôt que de le
 * simuler
 *
 * 1. **Le revenu ne se ventile ni par praticien ni par prestation.**
 *    `GET /reports/revenue` agrège les encaissements, qui portent un rendez-vous
 *    mais dont la réponse ne rend ni le praticien ni la prestation. Attribuer la
 *    recette au prorata des rendez-vous serait une invention — deux prestations
 *    de prix différents pèseraient pareil. L'indicateur reste donc celui de
 *    l'établissement, et l'écran le **dit** au lieu d'afficher un chiffre faux.
 * 2. **Un praticien et une prestation ne se croisent pas.** Les deux axes sont
 *    servis séparément ; rien ne rend « les coupes de Camille ». C'est pourquoi
 *    le filtre est un choix **unique** — un praticien *ou* une prestation — et
 *    non deux sélecteurs combinables dont la combinaison n'aurait aucune
 *    réponse.
 *
 * ## Le taux de no-show d'un filtre est recalculé, et c'est prévu
 *
 * `GET /reports/no-shows` rend le taux de l'établissement. Sous filtre, l'écran
 * le recalcule depuis `byStatus` de la ligne, avec **la définition du module** —
 * `noShows / (completed + noShows)`. Le README de `reporting` prévoit
 * explicitement ce cas : « les quatre comptes voyagent à côté et font foi : un
 * écran qui préfère une autre définition la recalcule sans redemander la
 * fenêtre. » Ici on ne préfère pas une autre définition : on applique la même à
 * un sous-ensemble.
 */

import type { CalendarDate } from '@spa/shared';

import { addCalendarDays } from '../booking/calendar';
import type {
  AppointmentStatusCounts,
  AppointmentVolumeReport,
  AppointmentVolumeRow,
  DailyRevenueReport,
  NoShowReport,
  RevenueTotal,
} from './reporting-contract';
import type { ReportRange } from './reporting-window';

/** L'axe sur lequel le filtre porte — ou l'établissement entier. */
export const REPORT_SCOPE_KINDS = ['etablissement', 'praticien', 'prestation'] as const;

export type ReportScopeKind = (typeof REPORT_SCOPE_KINDS)[number];

/** Le filtre retenu, résolu contre ce que la période contient réellement. */
export interface ReportScope {
  readonly kind: ReportScopeKind;
  /** `null` sur l'établissement entier. */
  readonly key: string | null;
  /** Ce que l'écran écrit — le nom public du praticien ou de la prestation. */
  readonly label: string;
}

/** L'établissement entier — ce que l'écran affiche sans filtre. */
export const WHOLE_TENANT: ReportScope = {
  kind: 'etablissement',
  key: null,
  label: 'Tout l’établissement',
};

/** Une valeur proposée par le sélecteur de filtre. */
export interface ReportFilterOption {
  readonly key: string;
  readonly label: string;
  readonly total: number;
}

/**
 * Les valeurs de filtre d'un axe, du plus fréquenté au moins fréquenté.
 *
 * Les groupes sans libellé sont écartés : l'axe `staff` rend `label: null` quand
 * le rendez-vous n'a pas de praticien assigné, et un choix « (sans nom) » dans
 * un sélecteur n'apprend rien à qui cherche le rendement de Camille. Le compte
 * de ces rendez-vous reste dans le total de l'établissement, qui lui ne filtre
 * rien.
 */
export function filterOptions(report: AppointmentVolumeReport): ReportFilterOption[] {
  return report.rows
    .filter((row): row is AppointmentVolumeRow & { label: string } => row.label !== null)
    .map((row) => ({ key: row.key, label: row.label, total: row.total }))
    .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label, 'fr'));
}

/**
 * Le filtre lu de la chaîne de requête — `praticien:<id>` ou `prestation:<id>`.
 *
 * Une clé que la période ne contient pas retombe sur l'établissement : un
 * praticien qui n'a vu personne en septembre n'a pas de ligne dans le rapport,
 * et afficher son nom au-dessus de zéros pris ailleurs serait un mensonge. Le
 * lien reste valide, il affiche simplement l'établissement.
 */
export function parseReportScope(
  raw: string | undefined,
  staff: readonly ReportFilterOption[],
  services: readonly ReportFilterOption[],
): ReportScope {
  if (raw === undefined) {
    return WHOLE_TENANT;
  }

  const separator = raw.indexOf(':');

  if (separator < 0) {
    return WHOLE_TENANT;
  }

  const kind = raw.slice(0, separator);
  const key = raw.slice(separator + 1);
  const options = kind === 'praticien' ? staff : kind === 'prestation' ? services : null;
  const found = options?.find((option) => option.key === key);

  return found === undefined || (kind !== 'praticien' && kind !== 'prestation')
    ? WHOLE_TENANT
    : { kind, key: found.key, label: found.label };
}

/** Le filtre tel que l'URL le porte, ou `null` sur l'établissement entier. */
export function formatReportScope(scope: ReportScope): string | null {
  return scope.key === null ? null : `${scope.kind}:${scope.key}`;
}

/** Le revenu de la fenêtre, cumulé par devise — jamais entre devises. */
export interface RevenueIndicator {
  readonly currency: string;
  readonly transactions: number;
  readonly grossAmountMinor: number;
  readonly refundedAmountMinor: number;
  readonly netAmountMinor: number;
}

/**
 * Le cumul par devise des totaux ventilés par moyen de paiement.
 *
 * Les devises ne se somment pas : additionner 3 500 XPF et 3 500 EUR produirait
 * un nombre qui ne veut rien dire. Un salon n'en pratique qu'une en temps
 * normal, et la clé composite fait que le jour où ce ne serait plus vrai,
 * l'indicateur se scinde au lieu de mentir.
 */
export function revenueByCurrency(totals: readonly RevenueTotal[]): RevenueIndicator[] {
  const byCurrency = new Map<string, RevenueIndicator>();

  for (const total of totals) {
    const current = byCurrency.get(total.currency);

    byCurrency.set(total.currency, {
      currency: total.currency,
      transactions: (current?.transactions ?? 0) + total.transactions,
      grossAmountMinor: (current?.grossAmountMinor ?? 0) + total.grossAmountMinor,
      refundedAmountMinor: (current?.refundedAmountMinor ?? 0) + total.refundedAmountMinor,
      netAmountMinor: (current?.netAmountMinor ?? 0) + total.netAmountMinor,
    });
  }

  return [...byCurrency.values()].sort((left, right) => right.netAmountMinor - left.netAmountMinor);
}

/** Une journée de caisse, une devise — un point du graphique de revenu. */
export interface DailyRevenuePoint {
  readonly date: CalendarDate;
  readonly transactions: number;
  readonly grossAmountMinor: number;
  readonly refundedAmountMinor: number;
  readonly netAmountMinor: number;
}

/** Le revenu quotidien d'une devise, sur toute la période. */
export interface RevenueSeries {
  readonly currency: string;
  readonly days: readonly DailyRevenuePoint[];
}

/**
 * Le revenu quotidien, une série par devise, **tous les jours de la période**.
 *
 * L'API omet les jours sans recette — « un rapport ne fabrique pas les jours où
 * le salon était fermé ». Un graphique, lui, a besoin d'un axe continu : sans
 * les jours vides, deux barres voisines pourraient être séparées d'une semaine
 * et la courbe d'activité serait fausse à l'œil. Les zéros sont donc ajoutés
 * **ici**, à l'affichage, et non demandés au serveur.
 */
export function revenueSeries(
  report: DailyRevenueReport,
  range: ReportRange,
): readonly RevenueSeries[] {
  const currencies = [...new Set(report.days.map((day) => day.currency))].sort();
  const days = daysOfRange(range);

  const series = currencies.map((currency) => {
    const points = new Map<CalendarDate, DailyRevenuePoint>();

    for (const row of report.days) {
      if (row.currency !== currency) {
        continue;
      }

      const current = points.get(row.date);

      points.set(row.date, {
        date: row.date,
        transactions: (current?.transactions ?? 0) + row.transactions,
        grossAmountMinor: (current?.grossAmountMinor ?? 0) + row.grossAmountMinor,
        refundedAmountMinor: (current?.refundedAmountMinor ?? 0) + row.refundedAmountMinor,
        netAmountMinor: (current?.netAmountMinor ?? 0) + row.netAmountMinor,
      });
    }

    return {
      currency,
      days: days.map(
        (date) =>
          points.get(date) ?? {
            date,
            transactions: 0,
            grossAmountMinor: 0,
            refundedAmountMinor: 0,
            netAmountMinor: 0,
          },
      ),
    };
  });

  return series;
}

/** Les journées civiles d'une plage, bornes incluses. */
export function daysOfRange(range: ReportRange): readonly CalendarDate[] {
  const days: CalendarDate[] = [];

  for (let day = range.from; day <= range.to; day = addCalendarDays(day, 1)) {
    days.push(day);
  }

  return days;
}

/** Le suivi des no-shows d'un périmètre — les comptes, et le taux. */
export interface NoShowIndicator {
  readonly noShows: number;
  readonly honored: number;
  readonly cancelled: number;
  readonly pending: number;
  readonly total: number;
  /** `noShows / (honored + noShows)`, ou `null` si rien n'était à honorer. */
  readonly rate: number | null;
}

/**
 * Le taux de no-show d'un couple de comptes.
 *
 * `null` — et non `0` — quand le dénominateur est nul : « aucun rendez-vous à
 * honorer sur la période » n'est pas « aucun no-show », et un 0 % affiché sur un
 * salon fermé se lirait comme une performance. Même définition, mot pour mot,
 * que celle du service côté API.
 */
export function noShowRate(noShows: number, honored: number): number | null {
  const due = honored + noShows;

  return due === 0 ? null : Math.round((noShows / due) * 10_000) / 10_000;
}

/** Les no-shows d'une ligne de volume — la même définition, un sous-ensemble. */
export function noShowsOfCounts(counts: AppointmentStatusCounts): NoShowIndicator {
  const noShows = counts.no_show;
  const honored = counts.completed;

  return {
    noShows,
    honored,
    cancelled: counts.cancelled,
    pending: counts.pending + counts.confirmed,
    total: noShows + honored + counts.cancelled + counts.pending + counts.confirmed,
    rate: noShowRate(noShows, honored),
  };
}

/** Le rapport d'établissement, ramené à la même forme que les lignes filtrées. */
export function noShowsOfReport(report: NoShowReport): NoShowIndicator {
  return {
    noShows: report.noShows,
    honored: report.honored,
    cancelled: report.cancelled,
    pending: report.pending,
    total: report.total,
    rate: report.rate,
  };
}

/** Une barre du graphique de volume — un jour, un praticien ou une prestation. */
export interface VolumePoint {
  readonly key: string;
  readonly label: string;
  readonly total: number;
  readonly noShows: number;
  /** `true` sur la valeur que le filtre désigne — la barre mise en avant. */
  readonly selected: boolean;
}

/**
 * L'axe du graphique de volume suit le filtre.
 *
 * Sans filtre, c'est la période découpée en journées — la lecture d'un tableau
 * de bord. Sous filtre, c'est l'axe du filtre entier, la valeur retenue mise en
 * avant : montrer la seule barre sélectionnée priverait du seul repère qui
 * compte, ce que font les autres.
 */
export function volumePoints(
  scope: ReportScope,
  report: AppointmentVolumeReport,
  range: ReportRange,
  dayLabel: (date: CalendarDate) => string,
): readonly VolumePoint[] {
  if (report.groupBy === 'day') {
    const rows = new Map(report.rows.map((row) => [row.key, row]));

    return daysOfRange(range).map((date) => {
      const row = rows.get(date);

      return {
        key: date,
        label: dayLabel(date),
        total: row?.total ?? 0,
        noShows: row?.byStatus.no_show ?? 0,
        selected: false,
      };
    });
  }

  return report.rows
    .map((row) => ({
      key: row.key,
      label: row.label ?? 'Non attribué',
      total: row.total,
      noShows: row.byStatus.no_show,
      selected: row.key === scope.key,
    }))
    .sort((left, right) => right.total - left.total || left.label.localeCompare(right.label, 'fr'));
}

/** Le volume et les no-shows du périmètre retenu. */
export interface ScopedActivity {
  readonly appointments: number;
  readonly noShows: NoShowIndicator;
  /** La ventilation par statut, pour le tableau et l'export. */
  readonly byStatus: AppointmentStatusCounts | null;
}

/**
 * L'activité du périmètre — établissement, ou la ligne d'un axe.
 *
 * Sur l'établissement, les no-shows viennent de `GET /reports/no-shows`, qui
 * fait foi. Sous filtre, ils sont recalculés depuis `byStatus` de la ligne, avec
 * la même définition. On ne mélange jamais les deux sources dans un même
 * chiffre.
 */
export function scopedActivity(
  scope: ReportScope,
  axis: AppointmentVolumeReport,
  noShows: NoShowReport,
  wholeTenantVolume: AppointmentVolumeReport,
): ScopedActivity {
  if (scope.key === null) {
    return {
      appointments: wholeTenantVolume.total,
      noShows: noShowsOfReport(noShows),
      byStatus: null,
    };
  }

  const row = axis.rows.find((candidate) => candidate.key === scope.key);

  if (row === undefined) {
    return { appointments: 0, noShows: noShowsOfCounts(emptyCounts()), byStatus: emptyCounts() };
  }

  return {
    appointments: row.total,
    noShows: noShowsOfCounts(row.byStatus),
    byStatus: row.byStatus,
  };
}

/** Cinq statuts à zéro — la ligne d'un groupe que la période ne contient pas. */
function emptyCounts(): AppointmentStatusCounts {
  return { pending: 0, confirmed: 0, completed: 0, cancelled: 0, no_show: 0 };
}

/** Le taux tel que l'écran l'écrit — « 3,3 % », ou « — » faute de dénominateur. */
export function formatRate(rate: number | null): string {
  return rate === null
    ? '—'
    : new Intl.NumberFormat('fr-FR', {
        style: 'percent',
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(rate);
}

/** Un entier tel que l'écran l'écrit — séparateurs de milliers compris. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('fr-FR').format(value);
}
