import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import type { Money, ServiceView } from '../catalog.types';
import { ServiceCategorySummaryDto } from './service-category.dto';
import {
  BooleanQuery,
  CURRENCY_PATTERN,
  DESCRIPTION_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  MAX_AMOUNT_MINOR,
  MAX_DURATION_MINUTES,
  MIN_AMOUNT_MINOR,
  MIN_BUFFER_MINUTES,
  MIN_DURATION_MINUTES,
  NormalizeCurrency,
  NormalizeSlug,
  OptionalPresent,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  Trim,
} from './validation';

/**
 * DTO des prestations du catalogue.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé
 * dans le corps (tenant-isolation §2).
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/catalog.ts` ; elles devront en être importées.
 */

/**
 * Un montant : entier dans la plus petite unité, plus son code devise.
 *
 * **Jamais de flottant** (CLAUDE.md) : `0.1 + 0.2 !== 0.3` en IEEE 754, et
 * l'écart invisible sur un panier ne l'est plus au rapprochement bancaire de fin
 * de mois. `@IsInt()` refuse `35.5` en 400 ; le pilote PostgreSQL l'aurait
 * refusé en 500.
 *
 * Les deux champs voyagent dans le même objet, jamais côte à côte au premier
 * niveau du corps : deux champs indépendants peuvent être mis à jour séparément,
 * et il existerait alors un instant où le montant est libellé dans l'ancienne
 * devise.
 */
export class MoneyDto implements Money {
  @ApiProperty({
    description: 'Montant entier dans la plus petite unité monétaire — 3500 pour 35,00 €.',
    example: 3500,
    minimum: MIN_AMOUNT_MINOR,
    maximum: MAX_AMOUNT_MINOR,
  })
  @IsInt({ message: 'amountMinor : entier dans la plus petite unité monétaire' })
  @Min(MIN_AMOUNT_MINOR, { message: 'amountMinor : un prix n’est jamais négatif' })
  @Max(MAX_AMOUNT_MINOR)
  public amountMinor!: number;

  @ApiProperty({ description: 'Code devise ISO 4217.', example: 'EUR' })
  @IsString()
  @NormalizeCurrency()
  @Matches(CURRENCY_PATTERN, { message: 'currency : code ISO 4217 sur trois lettres' })
  public currency!: string;
}

export class CreateServiceDto {
  @ApiProperty({ example: 'Massage californien 60 min', maxLength: DISPLAY_NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  public name!: string;

  @ApiPropertyOptional({
    description:
      'Slug d’URL. Dérivé du nom quand il est absent ; le fournir sert à figer ' +
      'l’URL publique d’une prestation qu’on renomme.',
    example: 'massage-californien-60-min',
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

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Rubrique du catalogue. Une prestation non classée reste vendable — ' +
      'imposer une catégorie obligerait à en inventer une avant la première prestation.',
  })
  @OptionalPresent()
  @IsUUID('4')
  public categoryId?: string;

  @ApiProperty({
    description: 'Durée facturée du soin, en minutes — ce que le client voit et paie.',
    example: 60,
    minimum: MIN_DURATION_MINUTES,
    maximum: MAX_DURATION_MINUTES,
  })
  @IsInt()
  @Min(MIN_DURATION_MINUTES, { message: 'durationMinutes : une durée est strictement positive' })
  @Max(MAX_DURATION_MINUTES)
  public durationMinutes!: number;

  @ApiPropertyOptional({
    description:
      'Temps de préparation avant le soin, en minutes. Non facturé, invisible du ' +
      'client, mais occupé sur l’agenda du praticien.',
    example: 10,
    default: 0,
    minimum: MIN_BUFFER_MINUTES,
    maximum: MAX_DURATION_MINUTES,
  })
  @OptionalPresent()
  @IsInt()
  @Min(MIN_BUFFER_MINUTES, { message: 'bufferBeforeMinutes : un tampon n’est jamais négatif' })
  @Max(MAX_DURATION_MINUTES)
  public bufferBeforeMinutes?: number;

  @ApiPropertyOptional({
    description: 'Temps de remise en état après le soin, en minutes. Mêmes règles.',
    example: 15,
    default: 0,
    minimum: MIN_BUFFER_MINUTES,
    maximum: MAX_DURATION_MINUTES,
  })
  @OptionalPresent()
  @IsInt()
  @Min(MIN_BUFFER_MINUTES, { message: 'bufferAfterMinutes : un tampon n’est jamais négatif' })
  @Max(MAX_DURATION_MINUTES)
  public bufferAfterMinutes?: number;

  @ApiProperty({ type: MoneyDto })
  // `@IsDefined` est indispensable, et pas seulement pour la forme : class-validator
  // **saute** la validation imbriquée quand la valeur est `undefined`
  // (`nestedValidations` retourne aussitôt). Sans lui, un corps sans `price`
  // traverse la validation intact et le service déréférence `input.price.amountMinor`
  // — un 500 là où le contrat annonce un 400 nommant le champ.
  @IsDefined({ message: 'price : le prix est obligatoire' })
  // `@Type` est indispensable : sans lui, `class-transformer` laisse un objet nu
  // et `@ValidateNested` n'a aucune classe sur laquelle rejouer les validateurs
  // — le montant traverserait la validation sans être regardé.
  @ValidateNested()
  @Type(() => MoneyDto)
  public price!: MoneyDto;
}

/**
 * Modification d'une prestation — tous les champs facultatifs.
 *
 * `isActive` s'y ajoute, et c'est **ainsi** qu'une prestation sort du catalogue.
 * Il n'y a pas de suppression : les rendez-vous passés la référencent, et le
 * reporting doit continuer à savoir ce qui a été vendu. Aucune route `DELETE`
 * n'existe dans ce module.
 *
 * `description` et `categoryId` acceptent `null` — respectivement « efface ce
 * texte » et « déclasse cette prestation ». Les autres champs le refusent : un
 * prix ou une durée ne s'efface pas, il se remplace.
 */
export class UpdateServiceDto {
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
    nullable: true,
    type: String,
    format: 'uuid',
    description: '`null` déclasse la prestation.',
  })
  @IsOptional()
  @IsUUID('4')
  public categoryId?: string | null;

  @ApiPropertyOptional({ minimum: MIN_DURATION_MINUTES, maximum: MAX_DURATION_MINUTES })
  @OptionalPresent()
  @IsInt()
  @Min(MIN_DURATION_MINUTES, { message: 'durationMinutes : une durée est strictement positive' })
  @Max(MAX_DURATION_MINUTES)
  public durationMinutes?: number;

  @ApiPropertyOptional({ minimum: MIN_BUFFER_MINUTES, maximum: MAX_DURATION_MINUTES })
  @OptionalPresent()
  @IsInt()
  @Min(MIN_BUFFER_MINUTES, { message: 'bufferBeforeMinutes : un tampon n’est jamais négatif' })
  @Max(MAX_DURATION_MINUTES)
  public bufferBeforeMinutes?: number;

  @ApiPropertyOptional({ minimum: MIN_BUFFER_MINUTES, maximum: MAX_DURATION_MINUTES })
  @OptionalPresent()
  @IsInt()
  @Min(MIN_BUFFER_MINUTES, { message: 'bufferAfterMinutes : un tampon n’est jamais négatif' })
  @Max(MAX_DURATION_MINUTES)
  public bufferAfterMinutes?: number;

  @ApiPropertyOptional({ type: MoneyDto })
  @OptionalPresent()
  @ValidateNested()
  @Type(() => MoneyDto)
  public price?: MoneyDto;

  @ApiPropertyOptional({
    description: 'Retire la prestation du catalogue, ou l’y remet. Jamais une suppression.',
  })
  @OptionalPresent()
  @IsBoolean()
  public isActive?: boolean;
}

/** Filtres de la liste des prestations. */
export class ListServicesQueryDto {
  @ApiPropertyOptional({
    description: 'Ne rendre que les prestations actives. Par défaut, tout le catalogue.',
  })
  @OptionalPresent()
  @BooleanQuery()
  @IsBoolean()
  public activeOnly?: boolean;

  @ApiPropertyOptional({ format: 'uuid', description: 'Ne rendre que cette rubrique.' })
  @OptionalPresent()
  @IsUUID('4')
  public categoryId?: string;
}

/**
 * La prestation telle qu'elle sort de l'API.
 *
 * **Sans `tenantId`**, et sans l'ancienne colonne `category` en chaîne libre que
 * #24 remplace : le `select` du repository ne les lit même pas.
 */
export class ServiceDto implements ServiceView {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public slug!: string;

  @ApiProperty()
  public name!: string;

  @ApiProperty({ nullable: true, type: String })
  public description!: string | null;

  @ApiProperty({ nullable: true, type: ServiceCategorySummaryDto })
  public category!: ServiceCategorySummaryDto | null;

  @ApiProperty({ description: 'Durée facturée, en minutes.' })
  public durationMinutes!: number;

  @ApiProperty({ description: 'Préparation avant le soin, en minutes.' })
  public bufferBeforeMinutes!: number;

  @ApiProperty({ description: 'Remise en état après le soin, en minutes.' })
  public bufferAfterMinutes!: number;

  @ApiProperty({
    description:
      'Durée réellement bloquée sur l’agenda, tampons compris. Dérivée des trois ' +
      'champs précédents, jamais stockée.',
  })
  public occupiedMinutes!: number;

  @ApiProperty({ type: MoneyDto })
  public price!: MoneyDto;

  @ApiProperty()
  public isActive!: boolean;
}
