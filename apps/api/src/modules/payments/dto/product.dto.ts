import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import type { Product } from '../pos.types';

/**
 * DTO du rayon retail — #60.
 *
 * ## Ce qu'aucun DTO d'entrée ne porte
 *
 * Ni `tenantId`, ni `currency`. Le premier vient du jeton vérifié
 * (tenant-isolation §2) ; la seconde est celle de l'établissement, relue en
 * base — un article libellé dans une autre devise que le salon qui le vend
 * serait invendable au comptoir, et l'accepter n'aurait fait que déplacer le
 * refus.
 *
 * Le `ValidationPipe` global est en `whitelist` + `forbidNonWhitelisted` : un
 * champ non déclaré ici est **refusé en 400 en le nommant**, jamais ignoré en
 * silence. C'est ce qui rend ces omissions exécutoires plutôt que déclaratives.
 *
 * TODO(#26) : ces bornes rejoindront `@spa/shared` avec le reste du contrat.
 */

/** `products.sku` — `VARCHAR(64)`. */
const SKU_MAX_LENGTH = 64;

/** `products.name` — `VARCHAR(160)`, la largeur des noms du schéma. */
const NAME_MAX_LENGTH = 160;

/**
 * Borne haute d'un prix unitaire — la borne du type de la colonne.
 *
 * Elle n'est pas cosmétique : au-delà, l'écriture sortirait en erreur de type
 * PostgreSQL, donc en 500, là où le contrat annonce un 400 nommant le champ.
 */
const MAX_PRICE_AMOUNT_MINOR = 2_147_483_647;

/**
 * Code article — lettres, chiffres, tiret, point et souligné, sans espace.
 *
 * Volontairement strict, à l'inverse d'un numéro de téléphone : un code se
 * compare à l'identique, et `SH-01 ` avec son espace de fin serait un second
 * article pour la base là où c'est le même sur l'étagère.
 */
const SKU_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Élague une chaîne avant que les bornes ne la jugent — sans quoi `"   "`
 * passerait pour un nom. Jumeau de celui de `crm/dto/customer.dto.ts`,
 * dupliqué pour la même raison (un module n'importe pas un fichier profond d'un
 * autre, api-module §3) et destiné à disparaître avec #26.
 */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Un article, tel qu'il franchit la frontière HTTP. */
export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'SH-01', maxLength: SKU_MAX_LENGTH })
  public sku!: string;

  @ApiProperty({ example: 'Shampoing hydratant 250 ml', maxLength: NAME_MAX_LENGTH })
  public name!: string;

  @ApiProperty({
    example: 1850,
    minimum: 0,
    maximum: MAX_PRICE_AMOUNT_MINOR,
    description:
      'Prix de vente en **entier**, dans la plus petite unité de la devise — ' +
      '`1850` vaut 18,50 € en EUR. Jamais un flottant.',
  })
  public priceAmountMinor!: number;

  @ApiProperty({
    example: 'EUR',
    minLength: 3,
    maxLength: 3,
    description:
      'Devise ISO 4217 de l’établissement. Rendue avec chaque montant : un ' +
      'montant sans devise n’est pas un montant.',
  })
  public currency!: string;

  @ApiProperty({
    description:
      'Un article désactivé reste référencé par les tickets passés — il n’y a ' +
      'pas de suppression sur cette ressource.',
  })
  public isActive!: boolean;
}

/**
 * Création d'un article — `POST /products`.
 *
 * Pas de `isActive` : un article se crée vendable. Le créer déjà retiré du rayon
 * n'a pas d'usage, et la route de modification existe pour cela.
 */
export class CreateProductDto {
  @ApiProperty({ example: 'SH-01', maxLength: SKU_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1, { message: 'sku : au moins un caractère' })
  @MaxLength(SKU_MAX_LENGTH)
  @Matches(SKU_PATTERN, { message: 'sku : lettres, chiffres, point, tiret et souligné seulement' })
  public sku!: string;

  @ApiProperty({ example: 'Shampoing hydratant 250 ml', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1, { message: 'name : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public name!: string;

  @ApiProperty({ example: 1850, minimum: 0, maximum: MAX_PRICE_AMOUNT_MINOR })
  // `@IsInt()` est ce qui refuse `18.50` : un prix fractionnaire n'est pas une
  // approximation acceptable, c'est un montant qu'on ne saurait pas encaisser.
  @IsInt({ message: 'priceAmountMinor : entier attendu, dans la plus petite unité monétaire' })
  @Min(0)
  // Plafond **serveur** : au-delà, l'écriture sortirait en erreur de type
  // PostgreSQL, donc en 500 au lieu du 400 annoncé.
  @Max(MAX_PRICE_AMOUNT_MINOR)
  public priceAmountMinor!: number;
}

/**
 * Modification d'un article — `PATCH /products/:id`.
 *
 * Pas de `sku` : c'est la clé de `@@unique([tenantId, sku])` et la référence que
 * porte l'étiquette. Le changer reviendrait à renommer l'article dans les
 * inventaires du salon sans que rien ne le trace.
 *
 * `@ValidateIf(value !== undefined)` plutôt que `@IsOptional()` : ce dernier
 * laisse aussi passer un `null` explicite, qui descendrait jusqu'à une colonne
 * `NOT NULL`. Aucun champ de cette ressource ne s'efface.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Shampoing hydratant 250 ml', maxLength: NAME_MAX_LENGTH })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1, { message: 'name : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public name?: string;

  @ApiPropertyOptional({ example: 1950, minimum: 0, maximum: MAX_PRICE_AMOUNT_MINOR })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt({ message: 'priceAmountMinor : entier attendu, dans la plus petite unité monétaire' })
  @Min(0)
  @Max(MAX_PRICE_AMOUNT_MINOR)
  public priceAmountMinor?: number;

  @ApiPropertyOptional({
    description:
      '`false` retire l’article du rayon. Les tickets passés qui le référencent ' +
      'restent intacts.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean({ message: 'isActive : booléen attendu' })
  public isActive?: boolean;
}

/** Filtre de `GET /products`. */
export class ListProductsQueryDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'Inclut les articles retirés du rayon. `false` par défaut : ils n’ont ' +
      'rien à faire dans l’écran de caisse, qui est l’usage dominant.',
  })
  // `@IsOptional()` **avant** la conversion : sans lui, une requête qui ne porte
  // pas le paramètre laisse la propriété absente, `@IsBoolean()` la refuse, et
  // `GET /products` répond 400 au cas le plus courant — celui où l'écran de
  // caisse veut simplement le rayon vendable.
  @IsOptional()
  // `'true'` / `'false'` en query string : la conversion est explicite parce que
  // le pipe global est en `enableImplicitConversion: false`. Toute autre valeur
  // vaut `false` — un `?includeInactive=oui` ne doit pas ouvrir la liste par
  // accident.
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  public includeInactive?: boolean;
}

/** L'article tel qu'il franchit la frontière HTTP — la devise avec le montant. */
export function toProductDto(product: Product): ProductDto {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    priceAmountMinor: product.price.amountMinor,
    currency: product.price.currency,
    isActive: product.isActive,
  };
}
