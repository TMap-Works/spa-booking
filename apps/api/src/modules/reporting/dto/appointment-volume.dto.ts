import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import {
  APPOINTMENT_GROUPINGS,
  type AppointmentGrouping,
  type AppointmentVolumeReport,
} from '../reporting.types';
import { ReportWindowDto, ReportWindowQueryDto, toReportWindowDto } from './report-window.dto';

/**
 * Le volume de rendez-vous — `GET /reports/appointments`.
 *
 * Les trois axes du deuxième critère de #74 — « par période, par praticien et
 * par service » — sont **un seul endpoint paramétré**, et non trois routes.
 * C'est la même question posée sur trois axes : même fenêtre, même ventilation
 * par statut, même forme de réponse. Trois routes auraient triplé la surface à
 * garder, à documenter et à recetter pour un `GROUP BY` de différence.
 */

/** Ce qu'un tableau de bord peut demander du volume — et rien de plus. */
export class AppointmentVolumeQueryDto extends ReportWindowQueryDto {
  @ApiPropertyOptional({
    enum: APPOINTMENT_GROUPINGS,
    default: 'day',
    description:
      '`day` découpe la fenêtre en journées civiles du salon ; `staff` regroupe par ' +
      'praticien ; `service` par prestation.',
  })
  @IsOptional()
  @IsIn(APPOINTMENT_GROUPINGS, {
    message: `groupBy : une valeur parmi ${APPOINTMENT_GROUPINGS.join(', ')}`,
  })
  public groupBy?: AppointmentGrouping;
}

/**
 * Les cinq compteurs d'un groupe, un par statut.
 *
 * Les cinq clés sont **toujours présentes**, à zéro le cas échéant : un écran
 * qui affiche une colonne « no-shows » doit y lire `0`, pas un trou.
 */
export class AppointmentStatusCountsDto {
  @ApiProperty({ example: 2 })
  public PENDING!: number;

  @ApiProperty({ example: 31 })
  public CONFIRMED!: number;

  @ApiProperty({ example: 118 })
  public COMPLETED!: number;

  @ApiProperty({ example: 9 })
  public CANCELLED!: number;

  @ApiProperty({ example: 4 })
  public NO_SHOW!: number;
}

/**
 * Une ligne de volume : un groupe de l'axe demandé.
 *
 * `key` est la valeur de l'axe — une date civile `YYYY-MM-DD` sur `day`, un
 * identifiant de praticien sur `staff`, de prestation sur `service`. `label` est
 * le nom lisible qui va avec, et vaut `null` sur `day`, où la clé se lit
 * d'elle-même.
 *
 * `label` n'est jamais une donnée de cliente : c'est le nom **public** du
 * praticien — celui que l'agenda affiche déjà — ou celui de la prestation au
 * mur. Aucun nom de client n'entre dans un rapport.
 */
export class AppointmentVolumeRowDto {
  @ApiProperty({ example: '2026-09-03', description: 'Valeur de l’axe demandé.' })
  public key!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Camille',
    description: 'Nom public du groupe, ou `null` sur l’axe `day`.',
  })
  public label!: string | null;

  @ApiProperty({ example: 164, description: 'Tous statuts confondus.' })
  public total!: number;

  @ApiProperty({ type: AppointmentStatusCountsDto })
  public byStatus!: AppointmentStatusCountsDto;
}

/** L'enveloppe du rapport de volume. */
export class AppointmentVolumeReportDto {
  @ApiProperty({ type: ReportWindowDto })
  public window!: ReportWindowDto;

  @ApiProperty({ enum: APPOINTMENT_GROUPINGS })
  public groupBy!: AppointmentGrouping;

  @ApiProperty({ example: 'Europe/Paris', description: 'Fuseau IANA du salon.' })
  public timeZone!: string;

  @ApiProperty({
    type: [AppointmentVolumeRowDto],
    description:
      'Un groupe par valeur d’axe rencontrée. Les groupes sans rendez-vous sont absents — ' +
      'un rapport ne fabrique pas les journées de fermeture ni les prestations jamais vendues.',
  })
  public rows!: AppointmentVolumeRowDto[];

  @ApiProperty({ example: 1_284, description: 'Somme des groupes, tous statuts confondus.' })
  public total!: number;
}

/**
 * Le rapport du domaine, dans le vocabulaire de l'API.
 *
 * `byStatus` est **recopié clé par clé** plutôt qu'étalé : le DTO est le contrat,
 * et un `...row.byStatus` laisserait passer dans la réponse tout statut que le
 * domaine ajouterait sans que le contrat le déclare.
 */
export function toAppointmentVolumeReportDto(
  report: AppointmentVolumeReport,
): AppointmentVolumeReportDto {
  return {
    window: toReportWindowDto(report.window),
    groupBy: report.groupBy,
    timeZone: report.timeZone,
    rows: report.rows.map((row) => ({
      key: row.key,
      label: row.label,
      total: row.total,
      byStatus: {
        PENDING: row.byStatus.PENDING,
        CONFIRMED: row.byStatus.CONFIRMED,
        COMPLETED: row.byStatus.COMPLETED,
        CANCELLED: row.byStatus.CANCELLED,
        NO_SHOW: row.byStatus.NO_SHOW,
      },
    })),
    total: report.total,
  };
}
