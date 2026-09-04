import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CLOSING_TIME_PATTERN, WALL_CLOCK_PATTERN } from '../opening-hours';
import { OpeningHoursEntryDto, PostalAddressDto, PublicTenantDto } from './public-tenant.dto';

/**
 * Réglages de l'établissement, tels que le back-office les lit et les écrit
 * (#343, CDC §1.4 « paramétrage de l'établissement »).
 *
 * `ValidationPipe` est global avec `whitelist` **et** `forbidNonWhitelisted` :
 * un champ non déclaré ici ne passe pas — en particulier un `tenantId` ou un
 * `slug` glissés dans le corps. L'établissement vient du jeton vérifié, jamais
 * de la charge utile (tenant-isolation §2).
 *
 * TODO(#26) : ces formes sont celles de `updateTenantRequestSchema` et
 * `tenantSchema` de `packages/shared`, et devront en être importées le jour où
 * `apps/api` dépendra du paquet. Les bornes sont donc **les mêmes valeurs**, aux
 * mêmes noms, pour que la substitution ne change pas une borne en silence.
 */

/** `VARCHAR(160)` — nom d'établissement, ligne d'adresse. */
const DISPLAY_NAME_MAX_LENGTH = 160;
const ADDRESS_LINE_MAX_LENGTH = 160;
/** `VARCHAR(16)` — code postal, tous formats en usage. */
const POSTAL_CODE_MAX_LENGTH = 16;
/** `VARCHAR(120)` — nom de commune. */
const CITY_MAX_LENGTH = 120;
/** `VARCHAR(64)` — identifiant de fuseau IANA. */
const TIMEZONE_MAX_LENGTH = 64;
/** RFC 5321 §4.5.3.1.3 — la borne que `@IsEmail` applique de toute façon. */
const EMAIL_ADDRESS_MAX_LENGTH = 254;
/** `VARCHAR(32)` — numéro de téléphone, format libre à ce stade du MVP. */
const PHONE_MAX_LENGTH = 32;

/**
 * Quatre coupures par jour : la coupure méridienne, la réouverture en soirée,
 * et de la marge. Même valeur que `MAX_OPENING_HOURS_ENTRIES` du contrat
 * partagé.
 */
export const MAX_OPENING_HOURS_ENTRIES = 28;

/**
 * Élague un libellé avant que les bornes ne le jugent.
 *
 * Sans lui, `"   "` passerait pour une ville — trois espaces font trois
 * caractères — et la vitrine afficherait une adresse à trou. Rend la valeur
 * telle quelle si ce n'est pas une chaîne : un `null` d'effacement doit
 * continuer à valoir « efface ».
 *
 * Jumeau de celui de `catalog/dto/validation.ts` et d'`availability/dto`,
 * dupliqué plutôt qu'importé d'un module voisin — un module n'importe pas un
 * fichier profond d'un autre (api-module §3), et sa place définitive est
 * `@spa/shared` (#26).
 */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Champ facultatif dont `null` n'est **pas** une valeur acceptée.
 *
 * `@IsOptional()` confond les deux : il ignore les validateurs aussi bien sur
 * `undefined` que sur `null`, si bien qu'un `null` explicite traverserait la
 * validation et descendrait jusqu'à une colonne `NOT NULL`.
 */
const OptionalPresent = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/**
 * Une adresse postale soumise par le back-office.
 *
 * `line1`, `city` et `country` sont **requis** : l'adresse se pose en entier ou
 * ne se pose pas. Pour l'effacer, on envoie `address: null` — voir
 * `UpdateTenantDto.address`.
 */
export class UpdateTenantAddressDto {
  @ApiProperty({ maxLength: ADDRESS_LINE_MAX_LENGTH, example: '12 rue des Lilas' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  public line1!: string;

  @ApiPropertyOptional({ type: String, maxLength: ADDRESS_LINE_MAX_LENGTH })
  @OptionalPresent()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  public line2?: string;

  @ApiPropertyOptional({ type: String, maxLength: POSTAL_CODE_MAX_LENGTH, example: '75011' })
  @OptionalPresent()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(POSTAL_CODE_MAX_LENGTH)
  public postalCode?: string;

  @ApiProperty({ maxLength: CITY_MAX_LENGTH, example: 'Paris' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(CITY_MAX_LENGTH)
  public city!: string;

  @ApiProperty({
    example: 'FR',
    description: 'ISO 3166-1 alpha-2. La casse est normalisée en majuscules.',
  })
  // Normalisé avant d'être jugé : « fr » et « FR » désignent le même pays, et la
  // colonne porte une borne `CHECK` sur les majuscules. Sans cette
  // normalisation, une saisie en minuscules produirait un 500 en base là où
  // l'utilisateur attendait au pire un message de champ.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{2}$/, {
    message: 'country : code pays ISO 3166-1 alpha-2 attendu (« FR »)',
  })
  public country!: string;
}

/** Une plage d'ouverture soumise par le back-office. */
export class UpdateOpeningHoursEntryDto {
  @ApiProperty({ minimum: 1, maximum: 7, example: 2 })
  @IsInt()
  @Min(1)
  @Max(7)
  public weekday!: number;

  @ApiProperty({ example: '09:00' })
  @Matches(WALL_CLOCK_PATTERN, {
    message: 'opensAt : heure locale attendue au format HH:MM (00:00 à 23:59)',
  })
  public opensAt!: string;

  @ApiProperty({ example: '19:00' })
  @Matches(CLOSING_TIME_PATTERN, {
    message: 'closesAt : heure locale attendue au format HH:MM, ou « 24:00 » pour minuit',
  })
  public closesAt!: string;
}

/**
 * Modification partielle des réglages de l'établissement.
 *
 * **Absent** vaut « ne touche pas », `null` vaut « efface ». La distinction est
 * celle d'`UpdateProfileDto` et elle est load-bearing : un formulaire qui
 * renverrait `null` sur les champs qu'il n'affiche pas effacerait les
 * coordonnées du salon sans que personne l'ait demandé.
 *
 * Ni `slug`, ni `isActive`, ni `id` : le slug est l'adresse publique du salon —
 * la changer casserait les liens et le référencement acquis —, et fermer un
 * établissement n'est pas un réglage d'écran. Le `whitelist` global refuse de
 * toute façon ce qui n'est pas déclaré ici.
 */
export class UpdateTenantDto {
  @ApiPropertyOptional({ type: String, maxLength: DISPLAY_NAME_MAX_LENGTH })
  @OptionalPresent()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(DISPLAY_NAME_MAX_LENGTH)
  public name?: string;

  @ApiPropertyOptional({ type: String, example: 'Europe/Paris' })
  @OptionalPresent()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(TIMEZONE_MAX_LENGTH)
  public timezone?: string;

  @ApiPropertyOptional({ type: String, example: 'EUR', description: 'ISO 4217, majuscules.' })
  @OptionalPresent()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'defaultCurrency : code devise ISO 4217 attendu (« EUR »)' })
  public defaultCurrency?: string;

  /** `null` efface l'adresse e-mail publiée. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsEmail({}, { message: 'contactEmail : adresse e-mail attendue' })
  @MaxLength(EMAIL_ADDRESS_MAX_LENGTH)
  public contactEmail?: string | null;

  /** `null` efface le numéro publié. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(/^[+0-9][0-9\s().-]*$/, { message: 'contactPhone : numéro de téléphone attendu' })
  public contactPhone?: string | null;

  /**
   * L'adresse se pose ou s'efface **en entier**. `null` retire les cinq
   * colonnes d'un coup.
   *
   * Il n'y a pas de mise à jour partielle d'adresse, et c'est voulu : « change
   * la ville sans changer la rue » n'est pas une opération dont un formulaire
   * d'adresse a besoin, et l'autoriser rendrait représentable une adresse à
   * moitié réécrite — l'ancienne rue avec la nouvelle ville.
   */
  @ApiPropertyOptional({ type: UpdateTenantAddressDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateTenantAddressDto)
  public address?: UpdateTenantAddressDto | null;

  /**
   * Remplacement **intégral** de la semaine d'ouverture.
   *
   * Même arbitrage que `SetStaffScheduleDto` : la seule invariante qui compte —
   * aucune plage ne se recouvre — porte sur l'ensemble, et la vérifier plage par
   * plage ferait dépendre le résultat de l'ordre des appels. Un tableau vide
   * efface les horaires publiés ; `null` n'est pas accepté, il ne voudrait rien
   * dire de plus.
   */
  @ApiPropertyOptional({
    type: [UpdateOpeningHoursEntryDto],
    maxItems: MAX_OPENING_HOURS_ENTRIES,
  })
  @OptionalPresent()
  @IsArray()
  @ArrayMaxSize(MAX_OPENING_HOURS_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => UpdateOpeningHoursEntryDto)
  public openingHours?: UpdateOpeningHoursEntryDto[];
}

/**
 * L'établissement tel que le back-office le lit : la vitrine, plus l'état
 * d'activation que seul le staff a besoin de connaître.
 *
 * Étend `PublicTenantDto` plutôt que de le recopier — un champ ajouté à la
 * vitrine se propage ici, l'inverse n'est pas vrai. Même composition que
 * `tenantSchema` du contrat partagé, et pour la même raison.
 *
 * **Sans `tenantId`** : cet objet *est* l'établissement, et son `id` est la
 * seule exception documentée à « ne jamais exposer `tenantId` »
 * (tenant-isolation §4).
 */
export class TenantDto extends PublicTenantDto {
  @ApiProperty({
    description:
      'Établissement actif. Un établissement désactivé se comporte comme un ' +
      'établissement inexistant pour le public — d’où l’absence de ce champ de ' +
      'la vitrine.',
  })
  public isActive!: boolean;
}

// Réexportés pour que le contrôleur et le service n'aient qu'un import de DTO à
// faire : les formes publiques et les formes de réglage décrivent le même objet.
export { OpeningHoursEntryDto, PostalAddressDto };
