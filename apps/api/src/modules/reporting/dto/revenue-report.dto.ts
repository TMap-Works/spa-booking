import { ApiProperty } from '@nestjs/swagger';

import { PAYMENT_METHODS } from '../reporting.types';
import type { DailyRevenueReport, DailyRevenueRow, RevenueTotalRow } from '../reporting.types';
import { ReportWindowDto, toReportWindowDto } from './report-window.dto';

/**
 * Le revenu quotidien ventilé par moyen de paiement — `GET /reports/revenue`.
 *
 * ## Ce que ce contrat ne porte pas
 *
 * **Aucune ligne d'encaissement.** Ni identifiant de paiement, ni référence
 * Stripe, ni rendez-vous, ni cliente. Un rapport est un tableau de chiffres ; le
 * détail transaction par transaction existe déjà, sous `GET /payments` (#62),
 * derrière ses propres gardes. Les mélanger aurait fait du tableau de bord la
 * porte la plus large du module `payments`.
 *
 * **Aucun montant en flottant.** Les trois montants sont des entiers dans la
 * plus petite unité de leur devise, et la devise voyage avec eux — un prix n'a
 * pas de sens sans elle (schéma, règle n°2).
 */

/**
 * Une journée de caisse, pour un moyen de paiement et une devise.
 *
 * `date` est une date **civile** `YYYY-MM-DD` découpée dans le fuseau du salon,
 * pas dans UTC : c'est la journée telle que le gérant la vit. Le fuseau employé
 * est rendu à côté, sur l'enveloppe, pour qu'un écran n'ait pas à le supposer.
 */
export class DailyRevenueRowDto {
  @ApiProperty({ example: '2026-09-03', description: 'Date civile dans le fuseau du salon.' })
  public date!: string;

  @ApiProperty({ enum: PAYMENT_METHODS })
  public method!: DailyRevenueRow['method'];

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3, description: 'Code ISO 4217.' })
  public currency!: string;

  @ApiProperty({ example: 7, description: 'Nombre d’encaissements aboutis ce jour-là.' })
  public transactions!: number;

  @ApiProperty({
    example: 26_500,
    description: 'Encaissé, avant remboursement. Entier, plus petite unité monétaire.',
  })
  public grossAmountMinor!: number;

  @ApiProperty({
    example: 2_500,
    description: 'Remboursements **confirmés par le prestataire** sur ces encaissements.',
  })
  public refundedAmountMinor!: number;

  @ApiProperty({ example: 24_000, description: 'Brut moins remboursé — le chiffre d’affaires.' })
  public netAmountMinor!: number;
}

/** Le cumul de la fenêtre pour un moyen de paiement et une devise. */
export class RevenueTotalDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  public method!: RevenueTotalRow['method'];

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3 })
  public currency!: string;

  @ApiProperty({ example: 184 })
  public transactions!: number;

  @ApiProperty({ example: 712_000 })
  public grossAmountMinor!: number;

  @ApiProperty({ example: 18_000 })
  public refundedAmountMinor!: number;

  @ApiProperty({ example: 694_000 })
  public netAmountMinor!: number;
}

/** L'enveloppe du rapport de revenu. */
export class DailyRevenueReportDto {
  @ApiProperty({ type: ReportWindowDto })
  public window!: ReportWindowDto;

  @ApiProperty({
    example: 'Europe/Paris',
    description: 'Fuseau IANA du salon — celui dans lequel les journées ont été découpées.',
  })
  public timeZone!: string;

  @ApiProperty({
    type: [DailyRevenueRowDto],
    description:
      'Une ligne par (jour, moyen de paiement, devise). Les jours sans recette sont absents : ' +
      'un rapport ne fabrique pas les jours où le salon était fermé.',
  })
  public days!: DailyRevenueRowDto[];

  @ApiProperty({
    type: [RevenueTotalDto],
    description: 'Cumul de la fenêtre, ventilé par moyen de paiement et par devise.',
  })
  public totals!: RevenueTotalDto[];
}

/** Le rapport du domaine, dans le vocabulaire de l'API. */
export function toDailyRevenueReportDto(report: DailyRevenueReport): DailyRevenueReportDto {
  return {
    window: toReportWindowDto(report.window),
    timeZone: report.timeZone,
    days: report.days.map((day) => ({ ...day })),
    totals: report.totals.map((total) => ({ ...total })),
  };
}
