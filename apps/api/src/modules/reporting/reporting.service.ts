import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { assertReportWindow } from './report-window';
import { ReportingRepository } from './reporting.repository';
import type {
  AppointmentGrouping,
  AppointmentVolumeReport,
  DailyRevenueReport,
  DailyRevenueRow,
  NoShowReport,
  ReportWindow,
  RevenueTotalRow,
} from './reporting.types';

/**
 * Les trois rapports du MVP — CDC §1.4, « synthèse du revenu quotidien, volume
 * de rendez-vous, suivi des no-shows ».
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Il ne
 * journalise rien non plus : un rapport est fait de chiffres d'exploitation, et
 * le seul canal par lequel ils doivent sortir est la réponse HTTP demandée par
 * un rôle interne.
 *
 * ## Ce que ce service décide, et que le dépôt ne décide pas
 *
 * Trois choses, et ce sont les trois seules qui soient discutables dans tout le
 * module — d'où leur présence ici plutôt que noyées dans du SQL :
 *
 * 1. **la validité d'une fenêtre** — ordonnée, non vide, au plus un an
 *    (`report-window.ts`) ;
 * 2. **le dénominateur du taux de no-show** — les rendez-vous arrivés à
 *    échéance, annulations exclues (voir {@link noShows}) ;
 * 3. **le cumul du revenu** — replié depuis les jours déjà agrégés, pour que le
 *    total soit celui des lignes affichées.
 *
 * ## Le fuseau d'abord, toujours
 *
 * Les trois rapports commencent par lire `tenants.timezone`. Ce n'est pas une
 * politesse : c'est lui qui découpe les journées, et un rapport mal
 * fuseau-horairé range la recette du soir dans la journée du lendemain sans que
 * rien ne le signale. La colonne est `NOT NULL` — son absence ne peut donc venir
 * que d'un établissement qui n'existe plus, et la seule réponse qui n'apprenne
 * rien est un 404 (même conduite qu'`AppointmentsService.listAgenda`).
 */
@Injectable()
export class ReportingService {
  public constructor(private readonly repository: ReportingRepository) {}

  /**
   * Le revenu quotidien de la fenêtre, ventilé par moyen de paiement — premier
   * critère de #74.
   *
   * @throws {ReportWindowInvalidError} fenêtre inversée ou vide.
   * @throws {ReportWindowTooWideError} fenêtre de plus d'un an.
   * @throws {NotFoundError} l'établissement a disparu sous la requête.
   */
  public async dailyRevenue(window: ReportWindow): Promise<DailyRevenueReport> {
    assertReportWindow(window);
    const timeZone = await this.requireTimeZone();

    const days = await this.repository.dailyRevenue(window, timeZone);

    return { window, timeZone, days, totals: foldRevenueTotals(days) };
  }

  /**
   * Le volume de rendez-vous de la fenêtre, sur l'axe demandé — deuxième critère
   * de #74.
   *
   * `total` est la somme des groupes plutôt qu'un `count` de plus : la même
   * requête a déjà parcouru les mêmes lignes, et deux lectures qui comptent la
   * même chose finissent par se contredire sous concurrence (même argument que
   * `CustomerHistoryService`).
   *
   * @throws {ReportWindowInvalidError} fenêtre inversée ou vide.
   * @throws {ReportWindowTooWideError} fenêtre de plus d'un an.
   * @throws {NotFoundError} l'établissement a disparu sous la requête.
   */
  public async appointmentVolume(
    window: ReportWindow,
    groupBy: AppointmentGrouping,
  ): Promise<AppointmentVolumeReport> {
    assertReportWindow(window);
    const timeZone = await this.requireTimeZone();

    const rows = await this.repository.appointmentVolume(window, timeZone, groupBy);

    return {
      window,
      groupBy,
      timeZone,
      rows,
      total: rows.reduce((sum, row) => sum + row.total, 0),
    };
  }

  /**
   * Le nombre **et** le taux de no-shows de la fenêtre — troisième critère de
   * #74.
   *
   * ## Le dénominateur, et pourquoi celui-là
   *
   * `noShows / (honored + noShows)` : les rendez-vous **arrivés à échéance**.
   *
   * Les annulations en sont exclues à dessein. Un créneau annulé a été rendu, et
   * souvent revendu ; le compter au dénominateur diluerait le taux de tout ce
   * que le salon a su replacer — un établissement qui gère bien ses annulations
   * verrait son taux de no-show *baisser* sans qu'une seule personne se soit
   * présentée en plus. Les rendez-vous encore `PENDING` ou `CONFIRMED` sur la
   * fenêtre n'ont, eux, pas encore été jugés : les compter reviendrait à traiter
   * en no-show tout ce qui n'a pas encore eu lieu.
   *
   * Les quatre comptes voyagent à côté du taux, et ce sont eux qui font foi : un
   * écran qui préfère un autre dénominateur le recalcule sans nous redemander la
   * fenêtre.
   *
   * @throws {ReportWindowInvalidError} fenêtre inversée ou vide.
   * @throws {ReportWindowTooWideError} fenêtre de plus d'un an.
   * @throws {NotFoundError} l'établissement a disparu sous la requête.
   */
  public async noShows(window: ReportWindow): Promise<NoShowReport> {
    assertReportWindow(window);
    const timeZone = await this.requireTimeZone();

    const counts = await this.repository.noShowCounts(window);

    return { ...counts, window, timeZone, rate: noShowRate(counts.noShows, counts.honored) };
  }

  /**
   * Le fuseau de l'établissement courant — ou 404.
   *
   * `tenants.timezone` est `NOT NULL` : l'absence ne peut venir que d'un
   * établissement qui n'existe pas. Le 404 est la seule réponse qui n'apprenne
   * rien (tenant-isolation §4).
   */
  private async requireTimeZone(): Promise<string> {
    const timeZone = await this.repository.currentTimeZone();

    if (timeZone === null) {
      throw new NotFoundError('Établissement introuvable.');
    }

    return timeZone;
  }
}

/**
 * Le taux de no-show, arrondi à quatre décimales — ou `null`.
 *
 * `null` et non `0` quand personne n'était attendu : « aucun rendez-vous à
 * honorer sur la période » n'est pas « aucun no-show », et un `0 %` affiché sur
 * un salon fermé se lirait comme une performance.
 *
 * Quatre décimales, soit le point de base : c'est la précision qu'un écran
 * affiche (`3,45 %`), et arrondir ici plutôt que là évite qu'un
 * `0.30000000000000004` traverse le contrat. La division reste un flottant, et
 * c'est légitime — la règle « jamais de `float` » du projet porte sur les
 * **montants**, pas sur les ratios ; les montants, eux, ne sont jamais divisés
 * nulle part dans ce module.
 */
export function noShowRate(noShows: number, honored: number): number | null {
  const due = honored + noShows;

  return due === 0 ? null : Math.round((noShows / due) * 10_000) / 10_000;
}

/**
 * Replie les jours en un cumul par moyen de paiement et par devise.
 *
 * Le couple `(method, currency)` est la clé, et la devise n'y est pas
 * décorative : sommer des minor units de devises différentes produit un nombre
 * qui ne veut rien dire. Un établissement n'en pratique qu'une en temps normal ;
 * la clé composite fait que le jour où ce ne serait plus vrai, le total se
 * scinde au lieu de mentir.
 *
 * L'ordre est celui de première apparition dans les jours, eux-mêmes triés par
 * le `ORDER BY` du dépôt.
 */
export function foldRevenueTotals(days: readonly DailyRevenueRow[]): readonly RevenueTotalRow[] {
  const totals = new Map<string, RevenueTotalRow>();

  for (const day of days) {
    const key = `${day.method}|${day.currency}`;
    const current = totals.get(key);

    totals.set(key, {
      method: day.method,
      currency: day.currency,
      transactions: (current?.transactions ?? 0) + day.transactions,
      grossAmountMinor: (current?.grossAmountMinor ?? 0) + day.grossAmountMinor,
      refundedAmountMinor: (current?.refundedAmountMinor ?? 0) + day.refundedAmountMinor,
      netAmountMinor: (current?.netAmountMinor ?? 0) + day.netAmountMinor,
    });
  }

  return [...totals.values()];
}
