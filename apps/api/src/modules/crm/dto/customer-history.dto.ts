import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { APPOINTMENT_STATUSES } from '../../appointments/appointment-status';
import type { CustomerVisitHistory } from '../crm.types';
import { HISTORY_MAX_VISITS } from './customer.dto';

/**
 * DTO de l'historique de visites — #56, troisième critère.
 *
 * ## Ce que l'historique ne rend pas
 *
 * Ni `clientNote`, ni `staffNote` du rendez-vous : la première appartient au
 * rendez-vous et se lit sur son écran, la seconde est une note de séance que la
 * fiche ne résume pas. Un historique qui les recopierait diffuserait à chaque
 * ligne du texte libre saisi par un humain sur une cliente — exactement ce que
 * le CDC §5.1 demande de garder au plus près de son usage.
 */

/** Le prix figé d'une visite — un entier et sa devise, jamais un flottant. */
export class MoneyDto {
  @ApiProperty({
    example: 3500,
    description: 'Montant dans la plus petite unité monétaire — `3500` vaut 35,00 €.',
  })
  public amountMinor!: number;

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3 })
  public currency!: string;
}

/** Une visite, telle que l'historique la montre. */
export class CustomerVisitDto {
  @ApiProperty({ format: 'uuid' })
  public appointmentId!: string;

  @ApiProperty({ enum: APPOINTMENT_STATUSES })
  public status!: string;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de début.' })
  public startsAt!: string;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de fin.' })
  public endsAt!: string;

  @ApiProperty({ example: 'Massage 60 min' })
  public serviceName!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: '`null` si le praticien a été retiré — la visite reste une visite.',
  })
  public staffName!: string | null;

  @ApiProperty({ type: MoneyDto, description: 'Prix figé au moment de la réservation.' })
  public price!: MoneyDto;
}

/**
 * L'agrégat — le « historique de visites **agrégé** » du critère.
 *
 * Il porte sur la **totalité** des rendez-vous de la fiche, jamais sur la seule
 * page de visites rendue à côté.
 */
export class CustomerVisitSummaryDto {
  @ApiProperty({ minimum: 0, description: 'Tous statuts confondus.' })
  public totalVisits!: number;

  @ApiProperty({ minimum: 0, description: 'Rendez-vous `COMPLETED`.' })
  public honoredVisits!: number;

  @ApiProperty({ minimum: 0 })
  public cancelledVisits!: number;

  @ApiProperty({ minimum: 0 })
  public noShowVisits!: number;

  @ApiProperty({ minimum: 0, description: 'Rendez-vous qui occupent encore l’agenda.' })
  public upcomingVisits!: number;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Première visite **honorée**, ou `null` si la cliente n’est jamais venue.',
  })
  public firstVisitAt!: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  public lastVisitAt!: string | null;

  @ApiProperty({
    nullable: true,
    type: MoneyDto,
    description:
      'Somme des prix figés des visites honorées. `null` quand il n’y en a ' +
      'aucune — `0` laisserait croire à une cliente venue sans rien payer — et ' +
      '`null` aussi quand elles portent plusieurs devises : additionner des ' +
      'entiers dont les codes diffèrent produirait un nombre faux et plausible.',
  })
  public totalSpent!: MoneyDto | null;
}

/** Ce que rend `GET /customers/:id/history`. */
export class CustomerVisitHistoryDto {
  @ApiProperty({ type: CustomerVisitSummaryDto })
  public summary!: CustomerVisitSummaryDto;

  @ApiProperty({
    type: [CustomerVisitDto],
    description: 'Les visites les plus récentes, de la plus récente à la plus ancienne.',
  })
  public visits!: CustomerVisitDto[];
}

/**
 * Fenêtre de l'historique — `GET /customers/:id/history?limit=…`.
 *
 * Seule la **liste** est bornée ; l'agrégat ne l'est jamais. Le plafond est
 * appliqué côté serveur et n'est pas négociable, comme celui de la pagination.
 */
export class CustomerHistoryQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: HISTORY_MAX_VISITS, default: HISTORY_MAX_VISITS })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit : entier attendu' })
  @Min(1)
  @Max(HISTORY_MAX_VISITS)
  public limit?: number;
}

/** L'historique tel qu'il franchit la frontière HTTP — les instants en UTC. */
export function toHistoryDto(history: CustomerVisitHistory): CustomerVisitHistoryDto {
  const { summary } = history;

  return {
    summary: {
      totalVisits: summary.totalVisits,
      honoredVisits: summary.honoredVisits,
      cancelledVisits: summary.cancelledVisits,
      noShowVisits: summary.noShowVisits,
      upcomingVisits: summary.upcomingVisits,
      firstVisitAt: summary.firstVisitAt?.toISOString() ?? null,
      lastVisitAt: summary.lastVisitAt?.toISOString() ?? null,
      // Le montant se recompose ici, à partir des deux champs plats. Les deux
      // sont nuls **ensemble** — un montant sans devise n'est pas un montant —
      // et le test unitaire du service verrouille cet invariant.
      totalSpent:
        summary.totalSpentAmountMinor === null || summary.totalSpentCurrency === null
          ? null
          : {
              amountMinor: summary.totalSpentAmountMinor,
              currency: summary.totalSpentCurrency,
            },
    },
    visits: history.visits.map((visit) => ({
      appointmentId: visit.appointmentId,
      status: visit.status,
      startsAt: visit.startsAt.toISOString(),
      endsAt: visit.endsAt.toISOString(),
      serviceName: visit.serviceName,
      staffName: visit.staffName,
      price: { amountMinor: visit.priceAmountMinor, currency: visit.priceCurrency },
    })),
  };
}
