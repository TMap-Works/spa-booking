import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

import type { IsoWeekday } from '../availability.schedule';
import type { ClosingDaysView } from '../availability.types';

/**
 * DTO des jours de fermeture récurrents de l'établissement (#32).
 *
 * Aucun `tenantId` en entrée ni en sortie : l'établissement est celui du jeton
 * vérifié, et le déclarer dans le corps serait exactement le paramètre que le
 * client contrôle (tenant-isolation §2).
 *
 * TODO(#26) : ces formes sont décrites par `closingDaysSchema` et
 * `setClosingDaysRequestSchema` dans `packages/shared/src/schemas/availability.ts`.
 */

/** Sept jours dans une semaine — au-delà, un jour serait déclaré deux fois. */
const DAYS_IN_WEEK = 7;

/**
 * Remplacement intégral de la liste des jours fermés.
 *
 * Un tableau vide signifie « ouvert sept jours sur sept » : c'est ainsi qu'on
 * rouvre un jour, et il n'y a donc pas de suppression unitaire à écrire.
 *
 * `@ArrayUnique` double l'unique `(tenant_id, weekday)` de la base, qui reste la
 * garantie : sans lui, un doublon soumis produirait une violation de contrainte
 * brute, donc un 500 là où le contrat annonce un 400.
 */
export class SetClosingDaysDto {
  @ApiProperty({
    type: [Number],
    maxItems: DAYS_IN_WEEK,
    example: [7],
    description:
      'Jours fermés en numérotation ISO 8601 : 1 lundi … 7 dimanche. ' +
      'Liste vide = ouvert toute la semaine.',
  })
  @IsArray()
  @ArrayMaxSize(DAYS_IN_WEEK)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(DAYS_IN_WEEK, { each: true })
  public weekdays!: number[];
}

/** Les jours de fermeture tels qu'ils sortent de l'API, croissants. */
export class ClosingDaysDto implements ClosingDaysView {
  // `readonly` comme la vue qu'il reflète — voir `StaffScheduleDto.entries`.
  @ApiProperty({ type: [Number], example: [7] })
  public weekdays!: readonly IsoWeekday[];
}
