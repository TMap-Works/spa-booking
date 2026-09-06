import { ApiProperty } from '@nestjs/swagger';

import type { NoShowReport } from '../reporting.types';
import { ReportWindowDto, toReportWindowDto } from './report-window.dto';

/**
 * Le suivi des no-shows — `GET /reports/no-shows`.
 *
 * Le troisième critère de #74 demande « taux **et** nombre » : les deux sont
 * rendus, et les comptes font foi. Un écran qui préfère un autre dénominateur le
 * recalcule sans nous redemander la fenêtre — ce qui est aussi la raison pour
 * laquelle `cancelled` et `pending` figurent ici alors que le taux les ignore.
 */
export class NoShowReportDto {
  @ApiProperty({ type: ReportWindowDto })
  public window!: ReportWindowDto;

  @ApiProperty({ example: 'Europe/Paris', description: 'Fuseau IANA du salon.' })
  public timeZone!: string;

  @ApiProperty({ example: 4, description: 'Rendez-vous marqués `NO_SHOW` sur la fenêtre.' })
  public noShows!: number;

  @ApiProperty({ example: 118, description: 'Rendez-vous honorés (`COMPLETED`).' })
  public honored!: number;

  @ApiProperty({
    example: 9,
    description: 'Rendez-vous annulés. **Hors** dénominateur du taux : le créneau a été rendu.',
  })
  public cancelled!: number;

  @ApiProperty({
    example: 33,
    description: 'Encore `PENDING` ou `CONFIRMED` — pas encore jugés, donc hors dénominateur.',
  })
  public pending!: number;

  @ApiProperty({ example: 164, description: 'Tous statuts confondus, sur la fenêtre.' })
  public total!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.0328,
    description:
      '`noShows / (honored + noShows)`, arrondi à quatre décimales. `null` — et non `0` — ' +
      'quand aucun rendez-vous n’était à honorer : « rien à honorer » n’est pas « aucun no-show ».',
  })
  public rate!: number | null;
}

/** Le rapport du domaine, dans le vocabulaire de l'API. */
export function toNoShowReportDto(report: NoShowReport): NoShowReportDto {
  return {
    window: toReportWindowDto(report.window),
    timeZone: report.timeZone,
    noShows: report.noShows,
    honored: report.honored,
    cancelled: report.cancelled,
    pending: report.pending,
    total: report.total,
    rate: report.rate,
  };
}
