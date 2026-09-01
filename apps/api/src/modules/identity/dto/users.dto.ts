import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { USER_ROLES, type UserRole } from '../roles';

/**
 * DTO d'administration des comptes.
 *
 * L'énumération annoncée est `USER_ROLES` — les quatre rôles, `MANAGER`
 * compris. Elle a un temps été restreinte aux seuls rôles que `enum UserRole`
 * savait écrire : la garde de #201 nommait `MANAGER` que la colonne ignorait
 * encore, et le refuser ici donnait un 400 qui nomme les valeurs acceptées
 * plutôt qu'une erreur Prisma remontée en 500 « erreur interne ». La migration
 * `20260826100000_add_manager_user_role` a rendu la valeur stockable (#202) : la
 * restriction n'a plus d'objet, et la maintenir refuserait un rôle que la base
 * accepte.
 *
 * Le `@IsIn` reste, lui, indispensable — c'est ce qui borne l'entrée à
 * l'énumération plutôt que de laisser une chaîne arbitraire descendre jusqu'au
 * pilote PostgreSQL.
 */
export class ChangeUserRoleDto {
  @ApiProperty({
    enum: USER_ROLES,
    description: 'Rôle à attribuer au compte visé.',
  })
  @IsIn(USER_ROLES as readonly string[], {
    message: `role : valeurs acceptées — ${USER_ROLES.join(', ')}`,
  })
  public role!: UserRole;
}

/** `users.phone` — `VARCHAR(32)`, format libre borné, celui de `phoneSchema`. */
const PHONE_MAX_LENGTH = 32;

/** `users.first_name` / `users.last_name` — `VARCHAR(80)`. */
const NAME_MAX_LENGTH = 80;

/**
 * Numéro de téléphone — volontairement permissif, comme `phoneSchema` de
 * `@spa/shared` : refuser un numéro pourtant valide empêche d'être rappelée, en
 * accepter un douteux ne coûte qu'un SMS non délivré.
 */
const PHONE_PATTERN = /^[+0-9][0-9\s().-]*$/;

/**
 * Élague une chaîne avant que les bornes ne la jugent — sans quoi `"   "`
 * passerait pour un prénom. Jumeau de `Trim` d'`appointments/dto/validation.ts`,
 * dupliqué pour la même raison (un module n'importe pas un fichier profond d'un
 * autre, api-module §3) et destiné à disparaître avec #26.
 */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Modification de ses **propres** coordonnées (#47).
 *
 * Reprend champ pour champ `updateProfileRequestSchema` de `@spa/shared` —
 * `.strict().partial()`, `phone` nullable. Ce que ce DTO **ne porte pas** est ce
 * qui le définit :
 *
 * - **ni `email`.** C'est l'identifiant de connexion et la clé de
 *   `@@unique([tenantId, email])` : le changer déplace le compte, invalide le
 *   lien avec les fiches créées en réservation d'invité, et demande une
 *   vérification de la nouvelle adresse — sans quoi une faute de frappe rend le
 *   compte inatteignable, et une adresse d'autrui saisie volontairement en fait
 *   une prise de contrôle. Le CDC ne prévoit pas cette procédure dans le
 *   périmètre figé ; une issue de suivi la porte ;
 * - **ni `role`, ni `isActive`, ni `tenantId`.** Les trois sont des décisions de
 *   l'établissement, jamais de la personne. Le `ValidationPipe` global —
 *   `whitelist` et `forbidNonWhitelisted` — refuse en 400 tout champ non déclaré
 *   ici, ce qui rend l'omission exécutoire plutôt que déclarative ;
 * - **ni `id`.** Le compte modifié est celui du jeton, et il n'y a pas
 *   d'identifiant en chemin : une route qui en accepterait un serait la première
 *   fuite à écrire.
 *
 * ## Les trois champs sont facultatifs, et `phone` accepte `null`
 *
 * `@ValidateIf(value !== undefined)` plutôt que `@IsOptional()` sur les deux
 * noms : `@IsOptional()` laisse aussi passer un `null` explicite, qui
 * descendrait jusqu'à une colonne `NOT NULL`. Sur `phone`, en revanche, `null`
 * **est** une valeur — c'est ainsi qu'on efface un numéro —, et c'est
 * exactement ce que `@IsOptional()` autorise. La différence est délibérée et
 * suit la nullabilité des colonnes.
 */
export class UpdateOwnProfileDto {
  @ApiPropertyOptional({ example: 'Alice', maxLength: NAME_MAX_LENGTH })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1, { message: 'firstName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public firstName?: string;

  @ApiPropertyOptional({ example: 'Durand', maxLength: NAME_MAX_LENGTH })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Trim()
  @MinLength(1, { message: 'lastName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public lastName?: string;

  @ApiPropertyOptional({
    example: '+261 34 12 345 67',
    nullable: true,
    type: String,
    description: '`null` efface le numéro ; le champ absent le laisse tel quel.',
  })
  // `null` traverse : c'est la valeur par laquelle on retire son numéro.
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Trim()
  @MinLength(1, { message: 'phone : renseigner un numéro ou envoyer null pour l’effacer' })
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(PHONE_PATTERN, { message: 'phone : numéro de téléphone invalide' })
  public phone?: string | null;
}

/**
 * Le DTO ramené à ce que le domaine connaît : les champs **présents**, et eux
 * seuls.
 *
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini », et
 * le service doit pouvoir faire la même distinction : un `firstName: undefined`
 * recopié dans un `data` Prisma effacerait le prénom, là où l'appelant demandait
 * seulement de ne pas y toucher. L'étalement conditionnel est écrit ici, une
 * fois, plutôt que dans le contrôleur.
 */
export function toProfileChanges(dto: UpdateOwnProfileDto): {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
} {
  return {
    ...(dto.firstName === undefined ? {} : { firstName: dto.firstName }),
    ...(dto.lastName === undefined ? {} : { lastName: dto.lastName }),
    ...(dto.phone === undefined ? {} : { phone: dto.phone }),
  };
}
