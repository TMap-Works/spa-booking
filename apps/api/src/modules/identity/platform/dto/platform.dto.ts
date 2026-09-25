import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import {
  DNS_LABEL_PATTERN,
  LOCALES,
  PLATFORM_NOTE_MAX_LENGTH,
  PLATFORM_STATUS_REASON_MAX_LENGTH,
  PLATFORM_STATUS_REASON_MIN_LENGTH,
  PLATFORM_TENANT_EVENT_KINDS,
  PLATFORM_TENANT_ORIGINS,
  PLATFORM_TENANT_SEARCH_MAX_LENGTH,
  PLATFORM_TENANT_STATES,
  SLUG_MAX_LENGTH,
  TENANT_BILLING_STATUSES,
  type PlatformOverview,
  type PlatformTenantDetail,
  type PlatformTenantEvent,
  type PlatformTenantOrigin,
  type PlatformTenantState,
  type Locale,
  type TenantBillingStatus,
  isValidTimeZone,
} from '@spa/shared';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
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
  type PlatformOverviewView,
  type PlatformSession,
  type ProvisionedTenant,
  type ReissuedTenantInvitation,
  type TenantAccessLinks,
  type TenantDetailView,
  type TenantEventRecord,
  type TenantListQuery,
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

// Les bornes de la clé d'idempotence — `IDEMPOTENCY_KEY_MIN_LENGTH` et
// `IDEMPOTENCY_KEY_MAX_LENGTH` — viennent de `common/validation/idempotency-key.ts` :
// `platform_tenant_provisionings.idempotency_key` et `payments.idempotency_key` ont la
// même largeur, et c'est `readIdempotencyKey` — que le contrôleur appelle — qui les
// applique à la frontière HTTP. Les élargir ici n'aurait rien élargi.

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

  /**
   * La langue dans laquelle le salon s'ouvre — **facultative**, `en` sinon
   * (#844, troisième critère d'acceptation).
   *
   * Facultative parce que c'est un défaut du système et non une question à
   * poser : la clientèle du produit est nord-américaine (décision du PO du
   * 2026-09-19), et l'ouverture d'un salon est l'écran qu'on veut le plus court.
   * Le salon qui parle français le dit ici, ou le changera dans ses réglages.
   *
   * Le défaut est posé par le **service** (`PlatformService.provisionTenant`),
   * pas ici : un `?? 'en'` dans le contrôleur en aurait fait un second avis, à
   * côté de celui de l'inscription libre-service.
   */
  @ApiPropertyOptional({
    enum: LOCALES,
    example: 'en',
    description:
      'Langue par défaut du salon. Facultative — `en` par défaut. La casse est ' +
      'normalisée ; toute valeur hors `fr`/`en` est refusée en 400.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(LOCALES as readonly string[], {
    message: `defaultLocale : langue attendue parmi ${LOCALES.join(', ')}`,
  })
  public defaultLocale?: Locale;

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

  @ApiProperty({
    enum: PLATFORM_TENANT_ORIGINS,
    description:
      '`console` : ouvert par l’éditeur ; `signup` : inscrit en libre-service ; ' +
      '`legacy` : antérieur à la console (seed, jeu d’essai).',
  })
  public origin!: PlatformTenantOrigin;
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

  @ApiPropertyOptional({
    maxLength: PLATFORM_TENANT_SEARCH_MAX_LENGTH,
    description:
      'Cherche dans le nom, l’adresse, l’e-mail de contact et l’e-mail des gérants ' +
      'et administrateurs. Insensible à la casse.',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PLATFORM_TENANT_SEARCH_MAX_LENGTH)
  public q?: string;

  @ApiPropertyOptional({ enum: TENANT_BILLING_STATUSES })
  @IsOptional()
  @IsIn(TENANT_BILLING_STATUSES, { message: 'billingStatus : statut de facturation inconnu' })
  public billingStatus?: TenantBillingStatus;

  @ApiPropertyOptional({ enum: PLATFORM_TENANT_STATES })
  @IsOptional()
  @IsIn(PLATFORM_TENANT_STATES, { message: 'state : « active » ou « suspended » attendu' })
  public state?: PlatformTenantState;
}

/** Les valeurs par défaut de la pagination, appliquées une fois ; un terme vide ne filtre pas. */
export function toTenantPageQuery(dto: ListTenantsQueryDto): TenantListQuery {
  return {
    page: dto.page ?? 1,
    pageSize: dto.pageSize ?? DEFAULT_PAGE_SIZE,
    ...(dto.q === undefined || dto.q === '' ? {} : { q: dto.q }),
    ...(dto.billingStatus === undefined ? {} : { billingStatus: dto.billingStatus }),
    ...(dto.state === undefined ? {} : { state: dto.state }),
  };
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
    origin: tenant.origin,
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

// ---------------------------------------------------------------------------
// Tableau de bord et fiche salon
// ---------------------------------------------------------------------------

/**
 * Une note interne — `POST /platform/tenants/:id/notes`.
 *
 * Élaguée avant d'être jugée : une note faite d'espaces est une note vide.
 */
export class CreatePlatformNoteDto {
  @ApiProperty({ maxLength: PLATFORM_NOTE_MAX_LENGTH, example: 'Relancée par téléphone le 18/09.' })
  @Trim()
  @IsString()
  @MinLength(1, { message: 'body : la note est vide' })
  @MaxLength(PLATFORM_NOTE_MAX_LENGTH)
  public body!: string;
}

/**
 * Suspendre ou réactiver un salon — `PUT /platform/tenants/:id/status`.
 *
 * Le motif est obligatoire dans les deux sens : c'est lui que l'historique
 * garde.
 */
export class UpdateTenantStatusDto {
  @ApiProperty({ description: '`false` suspend le salon, `true` le réactive.' })
  @IsBoolean({ message: 'isActive : booléen attendu' })
  public isActive!: boolean;

  @ApiProperty({
    minLength: PLATFORM_STATUS_REASON_MIN_LENGTH,
    maxLength: PLATFORM_STATUS_REASON_MAX_LENGTH,
    example: 'Impayé depuis 30 jours, gérant injoignable.',
  })
  @Trim()
  @IsString()
  @MinLength(PLATFORM_STATUS_REASON_MIN_LENGTH, { message: 'reason : indiquez le motif' })
  @MaxLength(PLATFORM_STATUS_REASON_MAX_LENGTH)
  public reason!: string;
}

class MoneyAmountDto {
  @ApiProperty({ example: 2900, description: 'Plus petite unité monétaire — jamais un flottant.' })
  public amountMinor!: number;

  @ApiProperty({ example: 'EUR' })
  public currency!: string;
}

class OverviewTenantsDto {
  @ApiProperty()
  public total!: number;

  @ApiProperty({ description: 'Salons suspendus par l’éditeur.' })
  public suspended!: number;

  @ApiProperty({
    description: 'Nombre de salons par statut de facturation — les six statuts, zéro compris.',
    example: { managed: 3, pending: 1, trialing: 4, active: 12, past_due: 1, canceled: 2 },
  })
  public byBillingStatus!: Record<TenantBillingStatus, number>;
}

class OverviewRevenueDto {
  @ApiProperty({ type: MoneyAmountDto, description: 'Salons abonnés × tarif mensuel.' })
  public monthlyRecurring!: MoneyAmountDto;

  @ApiProperty({ type: MoneyAmountDto, description: 'Salons en impayé × tarif mensuel.' })
  public atRisk!: MoneyAmountDto;

  @ApiProperty({ type: MoneyAmountDto, description: 'Salons en essai × tarif mensuel.' })
  public inTrial!: MoneyAmountDto;
}

class SignupWeekDto {
  @ApiProperty({ example: '2026-09-14', description: 'Le lundi de la semaine, en UTC.' })
  public weekStart!: string;

  @ApiProperty()
  public console!: number;

  @ApiProperty()
  public signup!: number;
}

class ActivationDto {
  @ApiProperty({ description: 'Salons ouverts — hors inscriptions non payées.' })
  public opened!: number;

  @ApiProperty({ description: 'Avec au moins une prestation et un praticien actifs.' })
  public configured!: number;

  @ApiProperty({ description: 'Avec au moins un rendez-vous, depuis toujours.' })
  public booked!: number;

  @ApiProperty({ description: 'Avec au moins un rendez-vous pris dans les 30 derniers jours.' })
  public activeLast30Days!: number;
}

/** La vue d'ensemble de la plateforme — `GET /platform/overview`. */
export class PlatformOverviewDto {
  @ApiProperty({ format: 'date-time' })
  public generatedAt!: string;

  @ApiProperty({ type: OverviewTenantsDto })
  public tenants!: OverviewTenantsDto;

  @ApiProperty({ type: OverviewRevenueDto })
  public revenue!: OverviewRevenueDto;

  @ApiProperty({ type: [TenantSummaryDto] })
  public trialsEndingSoon!: TenantSummaryDto[];

  @ApiProperty({ type: [SignupWeekDto] })
  public signupsByWeek!: SignupWeekDto[];

  @ApiProperty({ type: ActivationDto })
  public activation!: ActivationDto;

  @ApiProperty({ type: [TenantSummaryDto] })
  public recent!: TenantSummaryDto[];
}

/** Une ligne de l'historique d'un salon. */
export class PlatformTenantEventDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty({ enum: PLATFORM_TENANT_EVENT_KINDS })
  public kind!: PlatformTenantEvent['kind'];

  @ApiProperty({ nullable: true, type: String })
  public body!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Alice D.' })
  public operatorName!: string | null;

  @ApiProperty({ format: 'date-time' })
  public createdAt!: string;
}

class TenantAccountDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public firstName!: string;

  @ApiProperty()
  public lastName!: string;

  @ApiProperty()
  public email!: string;

  @ApiProperty({ enum: ['staff', 'manager', 'admin'] })
  public role!: 'staff' | 'manager' | 'admin';

  @ApiProperty()
  public isActive!: boolean;

  @ApiProperty({ description: 'L’invitation a été acceptée : un mot de passe est posé.' })
  public activated!: boolean;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  public lastLoginAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  public createdAt!: string;
}

/** La fiche d'un salon — `GET /platform/tenants/:id`. Le schéma complet vit dans `@spa/shared`. */
export class PlatformTenantDetailDto {
  @ApiProperty({ type: TenantSummaryDto })
  public tenant!: TenantSummaryDto;

  @ApiProperty({ description: 'Coordonnées de contact du salon.' })
  public contact!: PlatformTenantDetail['contact'];

  @ApiProperty({ nullable: true, description: 'Adresse postale, ou `null` si non saisie.' })
  public address!: PlatformTenantDetail['address'];

  @ApiProperty({ nullable: true, type: String })
  public legalName!: string | null;

  @ApiProperty({
    enum: LOCALES,
    description:
      'La langue du salon — celle de sa vitrine et de ses e-mails. Rendue aussi ' +
      'pour un salon suspendu, dont la vitrine ne répond plus.',
  })
  public defaultLocale!: Locale;

  @ApiProperty({ description: 'Statut, fin d’essai, fin de période et client Stripe.' })
  public billing!: PlatformTenantDetail['billing'];

  @ApiProperty({ description: 'Vitrine et back-office — jamais le lien d’activation.' })
  public links!: PlatformTenantDetail['links'];

  @ApiProperty({ type: [TenantAccountDto] })
  public accounts!: TenantAccountDto[];

  @ApiProperty({ description: 'Nombre de comptes clients — jamais leur liste.' })
  public clientCount!: number;

  @ApiProperty({ description: 'Où en est la mise en route du salon.' })
  public setup!: PlatformTenantDetail['setup'];

  @ApiProperty({ description: 'Trente jours d’activité, en nombres.' })
  public activity!: PlatformTenantDetail['activity'];

  @ApiProperty({ type: [PlatformTenantEventDto] })
  public events!: PlatformTenantEventDto[];
}

function isoOrNull(instant: Date | null): string | null {
  return instant === null ? null : instant.toISOString();
}

/** Une ligne d'historique, mise en forme pour la réponse. */
export function toPlatformTenantEventDto(event: TenantEventRecord): PlatformTenantEvent {
  return {
    id: event.id,
    kind: event.kind,
    body: event.body,
    operatorName: event.operatorName,
    createdAt: event.createdAt.toISOString(),
  };
}

/** La vue d'ensemble, mise en forme pour la réponse — le type du contrat en garantit la forme. */
export function toPlatformOverviewDto(view: PlatformOverviewView): PlatformOverview {
  return {
    generatedAt: view.generatedAt.toISOString(),
    tenants: {
      total: view.tenants.total,
      suspended: view.tenants.suspended,
      byBillingStatus: { ...view.tenants.byBillingStatus },
    },
    revenue: {
      monthlyRecurring: { ...view.revenue.monthlyRecurring },
      atRisk: { ...view.revenue.atRisk },
      inTrial: { ...view.revenue.inTrial },
    },
    trialsEndingSoon: view.trialsEndingSoon.map(toTenantSummaryDto),
    signupsByWeek: view.signupsByWeek.map((week) => ({ ...week })),
    activation: { ...view.activation },
    recent: view.recent.map(toTenantSummaryDto),
  };
}

/** La fiche d'un salon, mise en forme pour la réponse. */
export function toPlatformTenantDetailDto(view: TenantDetailView): PlatformTenantDetail {
  const { record } = view;

  return {
    tenant: toTenantSummaryDto(record.summary),
    contact: { email: record.contactEmail, phone: record.contactPhone },
    address: record.address === null ? null : { ...record.address },
    legalName: record.legalName,
    defaultLocale: record.defaultLocale,
    billing: {
      status: record.summary.billingStatus,
      trialEndsAt: isoOrNull(record.summary.trialEndsAt),
      currentPeriodEndsAt: isoOrNull(record.currentPeriodEndsAt),
      stripeCustomerId: record.stripeCustomerId,
    },
    links: { ...view.links },
    accounts: view.accounts.map((account) => ({
      id: account.id,
      firstName: account.firstName,
      lastName: account.lastName,
      email: account.email,
      role: account.role,
      isActive: account.isActive,
      activated: account.activated,
      lastLoginAt: isoOrNull(account.lastLoginAt),
      createdAt: account.createdAt.toISOString(),
    })),
    clientCount: view.clientCount,
    setup: {
      adminActivated: view.setup.adminActivated,
      address: view.setup.address,
      legalIdentity: view.setup.legalIdentity,
      openingHours: view.setup.openingHours,
      activeServices: view.setup.activeServices,
      activeStaff: view.setup.activeStaff,
      staffWithSchedule: view.setup.staffWithSchedule,
      firstAppointmentAt: isoOrNull(view.setup.firstAppointmentAt),
    },
    activity: {
      createdLast30Days: view.activity.createdLast30Days,
      upcoming: view.activity.upcoming,
      completedLast30Days: view.activity.completedLast30Days,
      noShowLast30Days: view.activity.noShowLast30Days,
      cancelledLast30Days: view.activity.cancelledLast30Days,
      lastBookingAt: isoOrNull(view.activity.lastBookingAt),
    },
    events: view.events.map(toPlatformTenantEventDto),
  };
}
