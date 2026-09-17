import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { APPOINTMENT_STATUSES, CANCELLATION_AUTHORS } from '../../appointments/appointment-status';
import type { CustomerVisitHistory } from '../crm.types';
import { HISTORY_MAX_VISITS } from './customer.dto';

/**
 * DTO de l'historique de visites — #56, troisième critère.
 *
 * ## Ce que l'historique rend des deux notes, et pourquoi pas les deux — #870
 *
 * `clientNote` **oui** : c'est ce que le client a écrit lui-même en réservant,
 * au champ « Remarque (facultatif) » de l'étape 4 du tunnel
 * (`docs/design/appointments/wireframes.md`). La tenir hors de l'historique
 * revenait à ne jamais la faire atteindre la praticienne : celle qui prépare la
 * cabine ouvre la fiche du client, pas les quatre agendas de ses quatre venues
 * précédentes. Une consigne d'allergie qui n'arrive pas est le constat d'origine
 * de l'audit `d20260916-1`.
 *
 * `staffNote` **non** : c'est une note de séance écrite **sur** quelqu'un par le
 * salon, et `appointmentSchema` la borne à une sortie gardée par un rôle (#317).
 * `CustomerVisit` n'en porte même pas le champ, si bien que ce fichier n'a rien
 * à filtrer : la frontière tient dans la projection SQL (`VISIT_SELECT`), pas
 * dans un `delete` posé une couche plus haut. C'est aussi pour cela qu'un
 * export RGPD, lui, la restitue — il ne passe pas par ici (`toExportDto`).
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

  @ApiProperty({
    nullable: true,
    type: String,
    example: 'Allergie aux huiles essentielles d’agrumes, merci d’en tenir compte pour le gommage.',
    description:
      'La remarque écrite **par le client** à la réservation, ou `null`. Jamais ' +
      'la note interne du salon (`staffNote`), que cette route ne lit pas.',
  })
  public clientNote!: string | null;

  @ApiProperty({
    nullable: true,
    enum: CANCELLATION_AUTHORS,
    example: 'CLIENT',
    description:
      'De quel côté du comptoir l’annulation vient, ou `null`. `null` sur une ' +
      'visite **annulée** se lit « déplacée » : un report annule la ligne ' +
      'd’origine sans lui inscrire d’auteur (#917).',
  })
  public cancelledBy!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'Le rendez-vous que cette visite remplace, ou `null`. Porté par le ' +
      '**successeur** d’un report ; l’origine, elle, se reconnaît à son ' +
      '`cancelledBy` nul.',
  })
  public rescheduledFromId!: string | null;
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

  @ApiProperty({
    minimum: 0,
    description:
      'Les annulations **véritables** — celles qui portent un auteur. Disjoint ' +
      'de `rescheduledVisits` : leur somme est le nombre de rendez-vous ' +
      '`CANCELLED` (#917).',
  })
  public cancelledVisits!: number;

  @ApiProperty({
    minimum: 0,
    description:
      'Les **reports** — rendez-vous annulés sans auteur, comptés sur la ligne ' +
      'd’origine. Un créneau déplacé n’est pas un créneau perdu (#917).',
  })
  public rescheduledVisits!: number;

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
      rescheduledVisits: summary.rescheduledVisits,
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
      clientNote: visit.clientNote,
      cancelledBy: visit.cancelledBy,
      rescheduledFromId: visit.rescheduledFromId,
    })),
  };
}
