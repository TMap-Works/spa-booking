import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { UserProfile, UserRole } from '../identity.types';

/**
 * DTO d'entrée et de sortie du module `identity`.
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` : un
 * champ non déclaré ici ne passe pas — en particulier un `tenantId` glissé dans
 * le corps, qui est le scénario de fuite le plus direct (tenant-isolation).
 *
 * Les bornes de longueur ne sont pas décoratives : elles bornent aussi le coût.
 * bcrypt tronque au-delà de 72 octets, et un mot de passe de 10 Mo ferait payer à
 * l'API un hachage inutile — le `MaxLength` est ce qui l'évite.
 *
 * TODO(#26) : ces formes appartiennent au contrat d'API et devront être exposées
 * par `@spa/shared`, que #26 remplit en parallèle.
 */

/** Le slug identifie l'établissement, comme sur les pages publiques (#23). */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class TenantScopedRequest {
  @ApiProperty({
    description:
      "Slug public de l'établissement. Résolu contre la table `tenants` avant " +
      'toute lecture — il désigne un établissement, il n’en accorde aucun accès.',
    example: 'salon-des-lilas',
  })
  @IsString()
  @MaxLength(63)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @Matches(SLUG_PATTERN, { message: 'tenantSlug : minuscules, chiffres et tirets uniquement' })
  public tenantSlug!: string;
}

export class LoginDto extends TenantScopedRequest {
  @ApiProperty({ example: 'alice@example.test' })
  @IsEmail({}, { message: 'email : adresse invalide' })
  @MaxLength(320)
  public email!: string;

  @ApiProperty({ description: 'Mot de passe en clair — jamais journalisé, jamais stocké.' })
  @IsString()
  // Pas de `MinLength` à la connexion : la longueur minimale est une règle
  // d'inscription. L'exiger ici distinguerait « trop court » de « faux », donc
  // dirait qu'un mot de passe court est *le* mot de passe de ce compte.
  @MaxLength(200)
  public password!: string;
}

export class RegisterDto extends TenantScopedRequest {
  @ApiProperty({ example: 'alice@example.test' })
  @IsEmail({}, { message: 'email : adresse invalide' })
  @MaxLength(320)
  public email!: string;

  @ApiProperty({ minLength: 12, description: 'Douze caractères au minimum.' })
  @IsString()
  // Douze plutôt que huit : c'est le seuil au-delà duquel une attaque par
  // dictionnaire hors ligne cesse d'être triviale, même à coût bcrypt élevé.
  @MinLength(12, { message: 'password : 12 caractères au minimum' })
  // bcrypt ne considère que les 72 premiers octets : au-delà, deux mots de passe
  // distincts partageant leur préfixe deviennent équivalents.
  @MaxLength(72, { message: 'password : 72 caractères au maximum' })
  public password!: string;

  @ApiProperty({ example: 'Alice' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public firstName!: string;

  @ApiProperty({ example: 'Durand' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  public lastName!: string;

  @ApiPropertyOptional({ example: '+33600000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  public phone?: string;
}

/**
 * Le compte tel qu'il sort de l'API.
 *
 * **Ni `tenantId`, ni `passwordHash`.** Une entité Prisma renvoyée telle quelle
 * les exposerait tous les deux ; c'est pour cela qu'une entité ne sort jamais
 * d'un contrôleur (api-module §4).
 */
export class UserProfileDto implements UserProfile {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public email!: string;

  @ApiProperty({ enum: ['CLIENT', 'STAFF', 'ADMIN'] })
  public role!: UserRole;

  @ApiProperty()
  public firstName!: string;

  @ApiProperty()
  public lastName!: string;

  @ApiProperty({ nullable: true, type: String })
  public phone!: string | null;
}

/**
 * Réponse d'une connexion réussie.
 *
 * Le jeton de **rafraîchissement n'y figure pas** : il part en cookie `httpOnly`,
 * donc hors de portée de JavaScript. L'exposer ici annulerait exactement ce que
 * le cookie protège.
 */
export class AuthTokensDto {
  @ApiProperty({ description: 'Jeton d’accès, à poser en en-tête `Authorization: Bearer`.' })
  public accessToken!: string;

  @ApiProperty({ description: 'Durée de vie du jeton d’accès, en secondes.', example: 900 })
  public expiresIn!: number;

  @ApiProperty({ type: UserProfileDto })
  public user!: UserProfileDto;
}
