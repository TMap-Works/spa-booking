import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import {
  DNS_LABEL_PATTERN,
  SLUG_MAX_LENGTH,
  TENANT_BILLING_STATUSES,
  type TenantBillingStatus,
  isValidTimeZone,
} from '@spa/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  type ValidationArguments,
  type ValidationOptions,
  registerDecorator,
} from 'class-validator';

import {
  PLATFORM_PASSWORD_MAX_LENGTH,
  PLATFORM_PASSWORD_MIN_LENGTH,
  type PlatformSession,
  type ProvisionedTenant,
  type ReissuedTenantInvitation,
  type TenantAccessLinks,
  type TenantPage,
  type TenantSummary,
} from '../platform.types';

/**
 * DTO de la console plateforme — #806.
 *
 * ## Pourquoi `class-validator` ici, et non un schéma de `@spa/shared`
 *
 * L'ADR 0008 tranche : « toute entrée est validée par le schéma du contrat
 * **quand il en existe un** ; la classe reste pour OpenAPI ». Il n'en existe pas
 * pour la console, et il n'y a personne pour en consommer un — `packages/shared`
 * est la source de vérité des contrats **partagés entre le front et l'API**
 * (api-module §4), et aucune surface d'`apps/web` n'appelle ces routes. Le
 * module `identity` est par ailleurs explicitement nommé par l'ADR parmi ceux
 * qui n'ont pas été substitués. Ces classes valident donc, comme celles de leurs
 * voisines.
 *
 * Le jour où une console web existera, le contrat suivra — et ces classes
 * perdront leurs décorateurs de validation, comme les autres.
 *
 * ## Ce que le `ValidationPipe` global apporte, et qui compte ici
 *
 * `whitelist` et `forbidNonWhitelisted` : un champ non déclaré est refusé en 400
 * en le nommant. C'est ce qui rend exécutoire l'absence d'`isActive` et d'`id`
 * dans la charge utile de création — un salon ne naît ni désactivé, ni sous un
 * identifiant que l'appelant aurait choisi.
 */

/** `platform_operators.email`, `users.email` — `VARCHAR(320)`. */
const EMAIL_MAX_LENGTH = 320;
/** `tenants.name` — `VARCHAR(160)`. */
const TENANT_NAME_MAX_LENGTH = 160;
/** `users.first_name` / `users.last_name` — `VARCHAR(80)`. */
const NAME_MAX_LENGTH = 80;
/** `tenants.timezone` — `VARCHAR(64)`. */
const TIMEZONE_MAX_LENGTH = 64;
/** `tenants.address_line1` / `address_line2` — `VARCHAR(160)`. */
const ADDRESS_LINE_MAX_LENGTH = 160;
/** `tenants.postal_code` — `VARCHAR(16)`. */
const POSTAL_CODE_MAX_LENGTH = 16;
/** `tenants.city` — `VARCHAR(120)`. */
const CITY_MAX_LENGTH = 120;
/** `platform_tenant_provisionings.idempotency_key` — `VARCHAR(128)`. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** Le minimum qui rend une clé d'idempotence non devinable par accident. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

// Les bornes du mot de passe d'un opérateur — `PLATFORM_PASSWORD_MIN_LENGTH` et
// `PLATFORM_PASSWORD_MAX_LENGTH` — viennent de `platform.types.ts` : la commande
// d'exploitation les applique aussi, et elle ne peut pas importer ce fichier-ci.

/** Nombre de pages par défaut et bornes — les valeurs du fichier client. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
/**
 * Borne haute du numéro de page — celle au-delà de laquelle `(page - 1) *
 * pageSize` cesse d'être un entier exact, et où PostgreSQL refuserait le `skip`
 * par un 500 au lieu du 400 annoncé.
 */
export const MAX_PAGE = 1_000_000;

/** Élague une chaîne avant que les bornes ne la jugent. */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Met une chaîne en forme canonique : élaguée et en minuscules. */
const Canonical = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  );

/**
 * Le champ porte un identifiant de fuseau que la base IANA connaît.
 *
 * Le prédicat est celui de `@spa/shared` — `isValidTimeZone` —, le même que
 * `tenant-settings.dto.ts` applique au réglage du fuseau. Deux frontières qui
 * décideraient séparément de ce qu'est un fuseau valide finiraient par en
 * accepter un que l'autre refuse, et un salon créé sur un fuseau que l'écran de
 * réglages refuse ensuite serait un salon qu'on ne peut plus corriger.
 */
function IsIanaTimeZone(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: target.constructor,
      propertyName: propertyName.toString(),
      options: options ?? {},
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && isValidTimeZone(value),
        defaultMessage: (args?: ValidationArguments): string =>
          `${args?.property ?? 'timezone'} : identifiant de fuseau horaire IANA attendu ` +
          '(« Europe/Paris », « Indian/Antananarivo »)',
      },
    });
  };
}

/**
 * Connexion d'un opérateur — `POST /api/v1/platform/auth/login`.
 *
 * Trois champs, et le troisième n'est pas facultatif : l'ADR 0012 exige la MFA
 * **à chaque connexion**. Un `totpCode` optionnel aurait rendu le second facteur
 * dépendant du soin de l'appelant, c'est-à-dire pas un facteur.
 */
export class PlatformLoginDto {
  @ApiProperty({ example: 'operateur@tmap-works.test', maxLength: EMAIL_MAX_LENGTH })
  @Canonical()
  @IsEmail({}, { message: 'email : adresse invalide' })
  @MaxLength(EMAIL_MAX_LENGTH)
  public email!: string;

  @ApiProperty({ minLength: PLATFORM_PASSWORD_MIN_LENGTH, maxLength: PLATFORM_PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PLATFORM_PASSWORD_MIN_LENGTH, {
    message: `password : au moins ${String(PLATFORM_PASSWORD_MIN_LENGTH)} caractères`,
  })
  @MaxLength(PLATFORM_PASSWORD_MAX_LENGTH)
  public password!: string;

  @ApiProperty({
    example: '123456',
    description: 'Code TOTP à six chiffres de l’authentificateur de l’opérateur.',
  })
  @Trim()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'totpCode : six chiffres attendus' })
  public totpCode!: string;
}

/** L'opérateur connecté, tel que la console l'affiche. */
export class PlatformOperatorDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public email!: string;

  @ApiProperty()
  public firstName!: string;

  @ApiProperty()
  public lastName!: string;
}

/**
 * Ce que rend une connexion d'opérateur.
 *
 * **Aucun jeton de rafraîchissement, et aucun cookie** — la différence avec
 * `AuthTokensDto` est délibérée (ADR 0012, point 3) : une chaîne de
 * rafraîchissement rendrait la MFA franchissable une fois pour toutes.
 */
export class PlatformSessionDto implements PlatformSession {
  @ApiProperty({ description: 'Jeton de console — trente minutes, non renouvelable.' })
  public accessToken!: string;

  @ApiProperty({ example: 1800, description: 'Validité du jeton, en secondes.' })
  public expiresIn!: number;

  @ApiProperty({ type: PlatformOperatorDto })
  public operator!: PlatformOperatorDto;
}

/**
 * Ouverture d'un établissement — `POST /api/v1/platform/tenants`.
 *
 * ## Le slug est un label DNS, et la liste des noms réservés s'applique
 *
 * Le motif est celui de `@spa/shared` (`DNS_LABEL_PATTERN`) : minuscules,
 * chiffres, tirets simples, ni en tête ni en fin. Depuis l'arbitrage du 16/09
 * (#832), le slug n'est plus seulement un segment d'URL — c'est un **nom
 * d'hôte** —, et un slug que le DNS refuse est un salon qu'aucun navigateur ne
 * peut joindre. Le préfixe `xn--` tombe du même mouvement : il demande deux
 * tirets consécutifs, que le motif n'accepte pas.
 *
 * Les **noms réservés** (`www`, `api`, `admin`, `origin`…) sont refusés par le
 * service et non ici, parce que le refus doit rendre un 409 `TENANT_SLUG_TAKEN`
 * — la même réponse qu'un slug déjà pris. Du point de vue de l'appelant, les
 * deux disent la même chose : ce nom-là n'est pas disponible.
 *
 * ## Pourquoi l'adresse est demandée, alors que le critère ne parle que du pays
 *
 * Parce que la base lie les trois : `tenants_address_completeness_check` exige
 * qu'`address_line1`, `city` et `country_code` soient les trois nuls ou les
 * trois renseignés — une adresse sans ville n'oriente personne, et le
 * `PostalAddress` du JSON-LD qu'elle produirait serait incomplet (#343).
 * Demander le pays seul aurait fait échouer l'insertion en base. Les deux
 * compléments — `addressLine2`, `postalCode` — restent facultatifs, le second
 * n'existant pas dans tous les pays.
 *
 * ## Ce que la charge utile ne porte pas
 *
 * Ni `id`, ni `isActive`, ni le mot de passe de l'administrateur. Les deux
 * premiers sont des décisions du serveur ; le troisième n'appartient qu'à la
 * personne, et le choisir pour elle créerait un secret partagé dès sa naissance
 * (#55). `forbidNonWhitelisted` rend ces omissions exécutoires plutôt que
 * déclaratives.
 */
export class CreateTenantDto {
  @ApiProperty({
    example: 'maison-lotus',
    maxLength: SLUG_MAX_LENGTH,
    description:
      'Étiquette DNS du salon — elle devient son sous-domaine, ' +
      '`https://{slug}.{domaine}`. Minuscules, chiffres et tirets simples.',
  })
  @Canonical()
  @IsString()
  @MinLength(1, { message: 'slug : au moins un caractère' })
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(DNS_LABEL_PATTERN, {
    message: 'slug : minuscules, chiffres et tirets simples, ni en tête ni en fin',
  })
  public slug!: string;

  @ApiProperty({ example: 'Maison Lotus', maxLength: TENANT_NAME_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'name : au moins un caractère' })
  @MaxLength(TENANT_NAME_MAX_LENGTH)
  public name!: string;

  @ApiProperty({ example: 'Europe/Paris', maxLength: TIMEZONE_MAX_LENGTH })
  @Trim()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  public timezone!: string;

  @ApiProperty({ example: 'EUR', description: 'Code devise ISO 4217, en majuscules.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'defaultCurrency : code devise ISO 4217 attendu (« EUR »)' })
  public defaultCurrency!: string;

  @ApiProperty({ example: 'FR', description: 'Pays en ISO 3166-1 alpha-2, en majuscules.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode : code pays ISO 3166-1 alpha-2 attendu (« FR »)' })
  public countryCode!: string;

  @ApiProperty({ example: '12 rue des Lilas', maxLength: ADDRESS_LINE_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'addressLine1 : au moins un caractère' })
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  public addressLine1!: string;

  @ApiPropertyOptional({ maxLength: ADDRESS_LINE_MAX_LENGTH })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  public addressLine2?: string;

  @ApiPropertyOptional({ example: '75011', maxLength: POSTAL_CODE_MAX_LENGTH })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(POSTAL_CODE_MAX_LENGTH)
  public postalCode?: string;

  @ApiProperty({ example: 'Paris', maxLength: CITY_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'city : au moins un caractère' })
  @MaxLength(CITY_MAX_LENGTH)
  public city!: string;

  @ApiProperty({ example: 'gerante@maison-lotus.test', maxLength: EMAIL_MAX_LENGTH })
  @Canonical()
  @IsEmail({}, { message: 'adminEmail : adresse invalide' })
  @MaxLength(EMAIL_MAX_LENGTH)
  public adminEmail!: string;

  @ApiProperty({ example: 'Alice', maxLength: NAME_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'adminFirstName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public adminFirstName!: string;

  @ApiProperty({ example: 'Durand', maxLength: NAME_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'adminLastName : au moins un caractère' })
  @MaxLength(NAME_MAX_LENGTH)
  public adminLastName!: string;
}

/** Les trois liens que l'éditeur remet au gérant — critère 2. */
export class TenantAccessLinksDto implements TenantAccessLinks {
  @ApiProperty({
    example: 'https://maison-lotus.exemple.test/reservation',
    description: 'Le lien de réservation que les clientes utiliseront.',
  })
  public bookingUrl!: string;

  @ApiProperty({
    description:
      'Le lien qui pose le premier mot de passe de l’administrateur. Il porte le ' +
      'jeton d’invitation : à transmettre au gérant, jamais à journaliser.',
  })
  public adminInvitationUrl!: string;

  @ApiProperty({
    example: 'https://maison-lotus.exemple.test/admin/connexion',
    description: 'L’adresse de connexion du back-office du salon.',
  })
  public adminLoginUrl!: string;

  @ApiProperty({ example: 604_800, description: 'Validité du jeton d’invitation, en secondes.' })
  public invitationExpiresIn!: number;
}

/** Un établissement, tel que la console le rend. */
export class TenantSummaryDto implements Omit<TenantSummary, 'createdAt' | 'trialEndsAt'> {
  @ApiProperty()
  public id!: string;

  @ApiProperty({ example: 'maison-lotus' })
  public slug!: string;

  @ApiProperty({ example: 'Maison Lotus' })
  public name!: string;

  @ApiProperty({ example: 'Europe/Paris' })
  public timezone!: string;

  @ApiProperty({ example: 'EUR' })
  public defaultCurrency!: string;

  @ApiProperty()
  public isActive!: boolean;

  @ApiProperty({
    enum: TENANT_BILLING_STATUSES,
    description: 'Facturation du salon — `managed` pour un salon ouvert par la console (ADR 0016).',
  })
  public billingStatus!: TenantBillingStatus;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  public trialEndsAt!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant d’ouverture, en UTC.' })
  public createdAt!: string;
}

/** Le compte administrateur ouvert avec l'établissement. */
export class TenantAdminDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public email!: string;

  @ApiProperty()
  public firstName!: string;

  @ApiProperty()
  public lastName!: string;
}

/** Ce que rend l'ouverture d'un salon — critère 2. */
export class ProvisionedTenantDto {
  @ApiProperty({ type: TenantSummaryDto })
  public tenant!: TenantSummaryDto;

  @ApiProperty({ type: TenantAdminDto })
  public admin!: TenantAdminDto;

  @ApiProperty({ type: TenantAccessLinksDto })
  public links!: TenantAccessLinksDto;

  @ApiProperty({
    description:
      '`true` quand la clé d’idempotence désignait un salon déjà ouvert : rien ' +
      'n’a été créé, et la réponse est celle de la première requête.',
  })
  public replayed!: boolean;
}

/** Une page d'établissements, avec de quoi afficher un sélecteur de page. */
export class TenantPageDto {
  @ApiProperty({ type: [TenantSummaryDto] })
  public items!: TenantSummaryDto[];

  @ApiProperty({ minimum: 1, example: 1 })
  public page!: number;

  @ApiProperty({ minimum: 1, example: DEFAULT_PAGE_SIZE })
  public pageSize!: number;

  @ApiProperty({ minimum: 0 })
  public totalItems!: number;

  @ApiProperty({
    minimum: 0,
    description: '`0` sur un ensemble vide — « page 1 sur 0 » et non « page 1 sur 1 ».',
  })
  public totalPages!: number;
}

/**
 * L'administrateur réinvité — son identifiant et son adresse, **rien de plus**.
 *
 * Une classe à part plutôt que `TenantAdminDto` : la réémission ne rend ni le
 * prénom ni le nom, et annoncer dans OpenAPI un champ que la réponse ne porte
 * pas ferait échouer un client généré sur un `undefined` que le schéma disait
 * obligatoire.
 */
export class ReissuedAdminDto extends PickType(TenantAdminDto, ['id', 'email'] as const) {}

/** Ce que rend la réémission de l'invitation de l'administrateur — critère 4. */
export class ReissuedTenantInvitationDto implements Omit<ReissuedTenantInvitation, 'admin'> {
  @ApiProperty()
  public tenantId!: string;

  @ApiProperty({ type: ReissuedAdminDto })
  public admin!: ReissuedAdminDto;

  @ApiProperty({ type: TenantAccessLinksDto })
  public links!: TenantAccessLinksDto;
}

/**
 * Pagination de la liste des établissements — `GET /platform/tenants`.
 *
 * `@Type(() => Number)` est **nécessaire** : une query string ne transporte que
 * des chaînes, et le `ValidationPipe` global est en
 * `enableImplicitConversion: false` — `?page=2` arriverait sinon en `'2'`, que
 * `@IsInt()` refuserait.
 */
export class ListTenantsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page : entier attendu' })
  @Min(1)
  // Plafond **serveur** : `@IsInt()` laisse passer `1e30`, dont le décalage
  // dépasse le `bigint` de PostgreSQL et sortirait en 500 au lieu du 400 annoncé.
  @Max(MAX_PAGE)
  public page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize : entier attendu' })
  @Min(1)
  // Plafond **serveur**, non négociable par le client : sans lui,
  // `?pageSize=100000` est un déni de service à une requête.
  @Max(MAX_PAGE_SIZE)
  public pageSize?: number;
}

/** Les valeurs par défaut de la pagination, appliquées une fois. */
export function toTenantPageQuery(dto: ListTenantsQueryDto): { page: number; pageSize: number } {
  return { page: dto.page ?? 1, pageSize: dto.pageSize ?? DEFAULT_PAGE_SIZE };
}

/** Un établissement, mis en forme pour la réponse — l'instant en ISO 8601 UTC. */
export function toTenantSummaryDto(tenant: TenantSummary): TenantSummaryDto {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    timezone: tenant.timezone,
    defaultCurrency: tenant.defaultCurrency,
    isActive: tenant.isActive,
    billingStatus: tenant.billingStatus,
    trialEndsAt: tenant.trialEndsAt === null ? null : tenant.trialEndsAt.toISOString(),
    createdAt: tenant.createdAt.toISOString(),
  };
}

/** Une page d'établissements, mise en forme pour la réponse. */
export function toTenantPageDto(page: TenantPage): TenantPageDto {
  return {
    items: page.items.map(toTenantSummaryDto),
    page: page.page,
    pageSize: page.pageSize,
    totalItems: page.totalItems,
    totalPages: page.totalPages,
  };
}

/** Ce que rend l'ouverture d'un salon, mis en forme pour la réponse. */
export function toProvisionedTenantDto(provisioned: ProvisionedTenant): ProvisionedTenantDto {
  return {
    tenant: toTenantSummaryDto(provisioned.tenant),
    admin: { ...provisioned.admin },
    links: { ...provisioned.links },
    replayed: provisioned.replayed,
  };
}
