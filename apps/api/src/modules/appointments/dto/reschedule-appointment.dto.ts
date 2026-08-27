import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { IsOffsetDateTime, OptionalPresent } from './validation';

/**
 * DTO du report public (#39).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas. C'est ce qui rend structurellement
 * impossible ce qu'un report ne doit pas pouvoir faire — changer la prestation,
 * la cliente, le prix ou le statut. Le corps ne porte qu'un instant et,
 * facultatif, un praticien ; tout le reste est recopié du rendez-vous d'origine
 * côté serveur.
 *
 * TODO(#26) : `rescheduleAppointmentRequestSchema` de
 * `packages/shared/src/schemas/appointment.ts` décrit la même forme et devra
 * être importé le jour où `apps/api` dépendra du paquet — même TODO que dans
 * `book-appointment.dto.ts`.
 */
export class RescheduleAppointmentDto {
  @ApiProperty({
    description:
      'Nouveau début du **soin** — l’instant proposé par le calendrier, tel qu’il ' +
      's’est affiché. ISO 8601 avec offset explicite (`Z` ou `±HH:MM`) : une ' +
      'date-heure nue obligerait le serveur à deviner un fuseau.',
    example: '2026-09-02T14:00:00Z',
  })
  @IsOffsetDateTime()
  public startsAt!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Nouveau praticien. Absent, le rendez-vous reste chez le même — le salon ' +
      'change couramment de praticien à l’occasion d’un report, mais ce n’est ' +
      'pas le cas courant.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public staffId?: string;
}
