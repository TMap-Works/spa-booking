import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import type { StaffAccountState, StaffInvitation } from '../identity.types';
import { STAFF_ROLES, USER_ROLES, type StaffRole, type UserRole } from '../roles';
import { UserProfileDto } from './auth.dto';

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
 * Invitation d'un membre du personnel — #55, `POST /api/v1/users`.
 *
 * ## Aucun mot de passe
 *
 * Le champ n'existe pas, et son absence est la décision principale de ce DTO :
 * un administrateur qui choisirait le mot de passe d'un tiers créerait un secret
 * partagé dès sa naissance, qu'il faudrait ensuite transmettre par un canal que
 * personne ne maîtrise. Le compte naît avec `password_hash` nul et c'est la
 * personne invitée qui le pose, par `POST /api/v1/auth/invitations/accept`.
 *
 * ## Le rôle est borné aux rôles **internes**
 *
 * `STAFF_ROLES` et non `USER_ROLES` : `CLIENT` n'est pas invitable. Une cliente
 * s'inscrit d'elle-même ou est saisie au comptoir par le module `crm`, et un
 * compte `CLIENT` créé ici serait aussitôt invisible — `GET /users` ne liste que
 * le personnel. Le refus est un 400 qui nomme les valeurs acceptées, pas une
 * ligne créée pour rien.
 *
 * ## Ni `isActive`, ni `tenantId`
 *
 * Le premier est l'objet de `PATCH /users/:id/status` ; le second vient du jeton
 * vérifié (tenant-isolation §2). `forbidNonWhitelisted` rend les deux omissions
 * exécutoires plutôt que déclaratives — un `tenantId` glissé dans le corps est
 * refusé en 400, il ne « passe » pas silencieusement.
 */
export class InviteStaffMemberDto {
  @ApiProperty({ example: 'praticienne@salon-des-lilas.test', maxLength: 320 })
  @IsEmail({}, { message: 'email : adresse invalide' })
  @MaxLength(320)
  public email!: string;

  @ApiProperty({
    enum: STAFF_ROLES,
    description: 'Rôle interne du membre invité — `CLIENT` n’est pas invitable.',
  })
  @IsIn(STAFF_ROLES as readonly string[], {
    message: `role : valeurs acceptées — ${STAFF_ROLES.join(', ')}`,
  })
  public role!: StaffRole;

  @ApiProperty({ example: 'Alice', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1, { message: 'firstName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public firstName!: string;

  @ApiProperty({ example: 'Durand', maxLength: NAME_MAX_LENGTH })
  @IsString()
  @Trim()
  @MinLength(1, { message: 'lastName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public lastName!: string;

  @ApiPropertyOptional({ example: '+261 34 12 345 67', maxLength: PHONE_MAX_LENGTH })
  // `@IsOptional()` et non le `@ValidateIf` des coordonnées : à la création il
  // n'y a pas de valeur antérieure à effacer, « absent » et « null » disent donc
  // la même chose — pas de numéro.
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(PHONE_PATTERN, { message: 'phone : numéro de téléphone invalide' })
  public phone?: string;
}

/**
 * Activation ou désactivation d'un compte du personnel — #55,
 * `PATCH /api/v1/users/:id/status`.
 *
 * Un booléen et non deux routes `/deactivate` et `/reactivate` : la réactivation
 * est le même geste, et deux points d'entrée auraient deux jeux de gardes à tenir
 * en accord. Le champ est **obligatoire** — un corps vide qui « bascule » l'état
 * rendrait l'opération non idempotente, donc dangereuse à rejouer.
 */
export class SetAccountStatusDto {
  @ApiProperty({
    description:
      '`false` ferme la connexion du compte et révoque ses sessions. Le compte, ' +
      'ses affectations et ses rendez-vous passés restent intacts.',
  })
  @IsBoolean({ message: 'isActive : booléen attendu' })
  public isActive!: boolean;
}

/**
 * Le compte du personnel **avec** son état d'activation — réponse de
 * `PATCH /api/v1/users/:id/status`.
 *
 * Forme propre à cette route : `UserProfileDto` est la charge utile de
 * `GET /users`, `GET /users/:id` et `/auth/me`, et y ajouter `isActive`
 * élargirait trois contrats pour le besoin d'un seul — en disant au passage à la
 * clientèle qu'un compte a été fermé, ce qui ne la regarde pas.
 */
export class StaffAccountStateDto extends UserProfileDto implements StaffAccountState {
  @ApiProperty({ description: 'État du compte **après** l’appel.' })
  public isActive!: boolean;
}

/**
 * Ce que rend l'émission d'une invitation — `POST /api/v1/users` et
 * `POST /api/v1/users/:id/invitation`.
 *
 * ## Pourquoi le jeton est dans le corps
 *
 * Parce que le module `notifications` (CDC §2.3) n'existe pas encore dans
 * `apps/api/src/modules/` : aucune chaîne d'envoi ne peut porter le lien, et la
 * créer sortirait de l'empreinte de #55. Le jeton part donc à l'administrateur
 * qui invite — lequel vient de créer ce compte et peut de toute façon réémettre
 * l'invitation à volonté. Il ne franchit aucune frontière que le rôle `ADMIN` ne
 * franchisse déjà, et il ne vaut que pour poser le **premier** mot de passe d'un
 * compte qui n'en a pas.
 *
 * Ce champ est écrit pour disparaître : quand `notifications` expédiera le lien,
 * il quitte la réponse et l'invitation ne transite plus que par la boîte mail de
 * la personne invitée. Une issue de suivi le porte.
 */
export class StaffInvitationDto implements StaffInvitation {
  @ApiProperty({ type: UserProfileDto })
  public user!: UserProfileDto;

  @ApiProperty({
    description:
      'Jeton d’invitation, à usage unique. À transmettre à la personne invitée, ' +
      'qui l’échange contre son mot de passe sur `POST /api/v1/auth/invitations/accept`.',
  })
  public invitationToken!: string;

  @ApiProperty({ description: 'Validité du jeton, en secondes.', example: 604_800 })
  public expiresIn!: number;
}

/**
 * Modification des coordonnées d'un compte — `PATCH /users/me` (#47) et
 * `PATCH /users/:id` (#55).
 *
 * Le même DTO pour les deux routes, et ce n'est pas une économie : les champs
 * modifiables sont exactement les mêmes — c'est *qui* peut les modifier et *sur
 * quel compte* qui diffère, et cela se décide par la garde et par l'identifiant
 * passé au service, pas par la validation du corps. Deux DTO jumeaux auraient
 * surtout offert deux endroits où les bornes divergent.
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
export class UpdateContactDetailsDto {
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
export function toProfileChanges(dto: UpdateContactDetailsDto): {
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
