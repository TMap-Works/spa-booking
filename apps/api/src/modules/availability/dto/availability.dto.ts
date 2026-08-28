import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { MAX_AVAILABILITY_RANGE_DAYS } from '../availability.errors';
import type {
  AvailabilitySlotView,
  AvailabilityView,
  DayAvailabilityView,
} from '../availability.types';
import { IsCalendarDate, OptionalPresent } from './validation';

/**
 * DTO de l'interrogation des créneaux libres — #35.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans la chaîne de requête, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). L'établissement vient du jeton vérifié, ou du slug
 * résolu par le middleware pour la route publique ; jamais de la requête.
 *
 * ## Des dates civiles en entrée, des instants UTC en sortie
 *
 * Ce n'est pas une incohérence, c'est le contrat que décrit déjà
 * `availabilityQuerySchema` : on demande « les créneaux de la semaine du
 * 3 mars », ce qui n'a de sens que dans le calendrier du salon, et on reçoit des
 * points sur la ligne du temps, qui sont les seuls comparables. La conversion se
 * fait côté serveur, avec le fuseau du tenant — le front n'a pas à le deviner.
 *
 * ## Ce que ce DTO ne valide pas
 *
 * Le **couple** `from` / `to`. Un décorateur de champ ne voit qu'un champ, et la
 * règle porte sur leur écart. Elle vit dans `requireServableRange`, à côté du
 * moteur, et sort en 422 `AVAILABILITY_RANGE_TOO_WIDE` plutôt qu'en 400 : chaque
 * date est bien écrite, c'est leur écart qui n'est pas servable. Tout appelant
 * du moteur s'y heurte, y compris celui qui n'est pas venu par HTTP.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/availability.ts` (`availabilityQuerySchema`,
 * `availabilitySlotSchema`, `dayAvailabilitySchema`,
 * `availabilityResponseSchema`) ; elles devront en être importées.
 */
export class AvailabilityQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Prestation dont on veut les créneaux.' })
  @IsUUID('4')
  public serviceId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restreindre à un praticien. Absent, les créneaux agrègent tous ceux qui ' +
      'pratiquent la prestation. Un identifiant inconnu, désactivé, d’un autre ' +
      'établissement ou qui ne pratique pas la prestation rend une réponse vide — ' +
      'jamais une erreur, faute de quoi cette route deviendrait une sonde d’existence.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public staffId?: string;

  @ApiProperty({
    description: 'Premier jour de la plage, date civile de l’établissement, borne comprise.',
    example: '2026-09-01',
  })
  @IsCalendarDate()
  public from!: string;

  @ApiProperty({
    description:
      'Dernier jour de la plage, borne comprise. La plage ne peut excéder ' +
      `${String(MAX_AVAILABILITY_RANGE_DAYS)} jours.`,
    example: '2026-09-07',
  })
  @IsCalendarDate()
  public to!: string;
}

/**
 * Un créneau proposable, tel que l'API le rend.
 *
 * Les bornes sont celles du **soin**, jamais de l'agenda : `endsAt - startsAt`
 * vaut exactement la durée de la prestation. Les tampons de préparation et de
 * remise en état encadrent ce créneau et occupent le praticien plus longtemps,
 * mais ils ne sont ni facturés ni montrés (CDC §2.3).
 */
export class AvailabilitySlotDto implements AvailabilitySlotView {
  @ApiProperty({ description: 'Instant UTC, suffixé « Z ».', example: '2026-09-01T08:00:00.000Z' })
  public startsAt!: string;

  @ApiProperty({ description: 'Instant UTC, suffixé « Z ».', example: '2026-09-01T09:00:00.000Z' })
  public endsAt!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Le praticien de ce créneau. Présent même quand la requête n’en désignait ' +
      'aucun : la réservation qui suit doit en désigner un.',
  })
  public staffId!: string;
}

/** Les créneaux d'une **journée civile de l'établissement**. */
export class DayAvailabilityDto implements DayAvailabilityView {
  @ApiProperty({ description: 'Date civile de l’établissement.', example: '2026-09-01' })
  public date!: string;

  @ApiProperty({
    type: [AvailabilitySlotDto],
    description:
      'Vide plutôt qu’omise quand la journée est complète ou fermée : un ' +
      'calendrier doit pouvoir afficher « complet » sans deviner ses trous.',
  })
  public slots!: readonly AvailabilitySlotView[];
}

/** La réponse du moteur de disponibilité. */
export class AvailabilityDto implements AvailabilityView {
  @ApiProperty({ format: 'uuid' })
  public serviceId!: string;

  @ApiProperty({
    description:
      'Fuseau IANA ayant servi au découpage en journées — celui de ' +
      'l’établissement. Sans lui, un front ne peut pas savoir à quelle journée du ' +
      'salon appartient un instant.',
    example: 'Europe/Paris',
  })
  public timezone!: string;

  @ApiProperty({ type: [DayAvailabilityDto] })
  public days!: readonly DayAvailabilityView[];
}
