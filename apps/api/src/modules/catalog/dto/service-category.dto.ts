import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

import type { ServiceCategorySummary, ServiceCategoryView } from '../catalog.types';
import {
  BooleanQuery,
  DESCRIPTION_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  NormalizeSlug,
  OptionalPresent,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  Trim,
} from './validation';

/**
 * DTO des catégories du catalogue.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans le corps, qui est le scénario de fuite le plus direct
 * (tenant-isolation §2). Aucun DTO d'entrée du module ne déclare de `tenantId`,
 * et aucun DTO de sortie n'en porte : l'établissement vient du jeton vérifié.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/catalog.ts` ; elles devront en être importées.
 */

export class CreateServiceCategoryDto {
  @ApiProperty({ example: 'Soins du visage', maxLength: DISPLAY_NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  public name!: string;

  @ApiPropertyOptional({
    description:
      'Slug d’URL. Dérivé du nom quand il est absent ; le fournir sert à figer ' +
      'l’URL publique d’une rubrique qu’on renomme.',
    example: 'soins-du-visage',
    maxLength: SLUG_MAX_LENGTH,
  })
  @OptionalPresent()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @NormalizeSlug()
  @Matches(SLUG_PATTERN, { message: 'slug : minuscules, chiffres et tirets uniquement' })
  public slug?: string;

  @ApiPropertyOptional({ maxLength: DESCRIPTION_MAX_LENGTH })
  @OptionalPresent()
  @IsString()
  @Trim()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  public description?: string;
}

/**
 * Modification d'une catégorie — tous les champs facultatifs.
 *
 * `isActive` s'y ajoute, et c'est **ainsi** qu'une rubrique sort du catalogue :
 * il n'y a pas de suppression, parce que des prestations la référencent et que
 * le reporting doit continuer à savoir sous quelle rubrique une vente a été
 * faite.
 *
 * `description` accepte `null` — il vaut « efface ce texte ». Les autres champs
 * refusent `null` : un nom ou un slug ne s'efface pas, il se remplace.
 */
export class UpdateServiceCategoryDto {
  @ApiPropertyOptional({ maxLength: DISPLAY_NAME_MAX_LENGTH })
  @OptionalPresent()
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  public name?: string;

  @ApiPropertyOptional({ maxLength: SLUG_MAX_LENGTH })
  @OptionalPresent()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  @NormalizeSlug()
  @Matches(SLUG_PATTERN, { message: 'slug : minuscules, chiffres et tirets uniquement' })
  public slug?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '`null` efface la description.',
    maxLength: DESCRIPTION_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  public description?: string | null;

  @ApiPropertyOptional({
    description: 'Retire la rubrique du catalogue, ou l’y remet. Jamais une suppression.',
  })
  @OptionalPresent()
  @IsBoolean()
  public isActive?: boolean;
}

/** Filtres de la liste des catégories. */
export class ListServiceCategoriesQueryDto {
  @ApiPropertyOptional({
    description: 'Ne rendre que les rubriques actives. Par défaut, tout le catalogue.',
  })
  @OptionalPresent()
  @BooleanQuery()
  @IsBoolean()
  public activeOnly?: boolean;
}

/** Forme réduite, telle qu'imbriquée dans une prestation. */
export class ServiceCategorySummaryDto implements ServiceCategorySummary {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public slug!: string;

  @ApiProperty()
  public name!: string;
}

/**
 * La catégorie telle qu'elle sort de l'API.
 *
 * **Sans `tenantId`** : c'est une information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4). C'est pour cela
 * qu'aucune entité Prisma ne sort d'un contrôleur (api-module §4).
 */
export class ServiceCategoryDto extends ServiceCategorySummaryDto implements ServiceCategoryView {
  @ApiProperty({ nullable: true, type: String })
  public description!: string | null;

  @ApiProperty()
  public isActive!: boolean;
}
