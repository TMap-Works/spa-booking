import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
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
} from 'class-validator';

import type { CustomerPatch } from '../crm.repository';
import type { Customer, CustomerPage, CustomerSummary } from '../crm.types';

/**
 * DTO du fichier client — #56.
 *
 * TODO(#26) : ces bornes reprennent `@spa/shared` (`crm.ts`). Les recopier ici
 * suit le précédent des modules voisins — `apps/api` ne dépend pas encore du
 * paquet partagé — et l'import se substituera à ces constantes sans changer une
 * valeur.
 *
 * ## Ce qu'aucun DTO d'entrée ne porte
 *
 * Ni `tenantId`, ni `role`, ni `isActive` sur les deux premiers, ni `email` sur
 * la modification. Le `ValidationPipe` global est en `whitelist` +
 * `forbidNonWhitelisted` : un champ non déclaré ici est **refusé en 400 en le
 * nommant**, jamais ignoré en silence. C'est ce qui rend ces omissions
 * exécutoires plutôt que déclaratives — un `tenantId` glissé dans un corps JSON
 * est exactement le scénario de fuite qu'on refuse (tenant-isolation §2).
 */

/** `users.first_name` / `users.last_name` — `VARCHAR(80)`. */
const NAME_MAX_LENGTH = 80;

/** `users.phone` — `VARCHAR(32)`, format libre borné. */
const PHONE_MAX_LENGTH = 32;

/** `users.email` — `VARCHAR(320)`. */
const EMAIL_MAX_LENGTH = 320;

/** `users.internal_note` — `VARCHAR(2000)`, la largeur des textes libres du schéma. */
const NOTE_MAX_LENGTH = 2000;

/** Bornes de la recherche libre — voir `CUSTOMER_SEARCH_MIN_LENGTH` de `@spa/shared`. */
const SEARCH_MIN_LENGTH = 2;
const SEARCH_MAX_LENGTH = 254;

/** Bornes de la pagination — `DEFAULT_PAGE_SIZE` et `MAX_PAGE_SIZE` de `@spa/shared`. */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Borne haute du numéro de page — celle au-delà de laquelle `(page - 1) *
 * pageSize` cesse d'être un entier exact.
 *
 * `@IsInt()` ne juge pas la magnitude : `Number.isInteger(1e30)` vaut `true`, si
 * bien que `?page=1e30` traverse la validation et arrive au dépôt en un `skip`
 * de `2e31` — hors des bornes du `bigint` de PostgreSQL, donc une erreur du
 * moteur remontée en 500 là où le contrat annonce un 400 nommant le champ. La
 * borne n'est pas arbitraire : elle est le plus grand `page` dont le décalage
 * reste un entier sûr, et aucun écran n'en atteindra jamais le millionième.
 */
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE);

/** Fenêtre de l'historique — `CUSTOMER_HISTORY_MAX_VISITS` de `@spa/shared`. */
export const HISTORY_MAX_VISITS = 50;

/**
 * Numéro de téléphone — volontairement permissif, comme `phoneSchema` de
 * `@spa/shared` : refuser un numéro pourtant valide empêche d'être rappelée, en
 * accepter un douteux ne coûte qu'un SMS non délivré.
 */
const PHONE_PATTERN = /^[+0-9][0-9\s().-]*$/;

/**
 * Élague une chaîne avant que les bornes ne la jugent — sans quoi `"   "`
 * passerait pour un prénom. Jumeau de celui d'`identity/dto/users.dto.ts`,
 * dupliqué pour la même raison (un module n'importe pas un fichier profond d'un
 * autre, api-module §3) et destiné à disparaître avec #26.
 */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Fiche cliente réduite — l'élément des listes.
 *
 * **Pas de `internalNote` ici**, et c'est la moitié applicative du critère
 * « notes internes distinctes des informations visibles du client » : une liste
 * de deux cents fiches ferait transiter deux cents notes qu'aucun tableau
 * n'affiche. Le dépôt ne la lit d'ailleurs même pas sur ce chemin.
 */
export class CustomerSummaryDto implements CustomerSummary {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ example: 'Alice', maxLength: NAME_MAX_LENGTH })
  public firstName!: string;

  @ApiProperty({ example: 'Durand', maxLength: NAME_MAX_LENGTH })
  public lastName!: string;

  @ApiProperty({ example: 'alice@example.test', maxLength: EMAIL_MAX_LENGTH })
  public email!: string;

  @ApiProperty({ nullable: true, type: String, example: '+261 34 12 345 67' })
  public phone!: string | null;

  @ApiProperty({
    description:
      'Une fiche désactivée reste référencée par ses rendez-vous passés — il n’y ' +
      'a pas de suppression sur cette ressource.',
  })
  public isActive!: boolean;
}

/**
 * Fiche cliente complète — ce que rend `GET /customers/:id`.
 *
 * `internalNote` n'apparaît que sur cette forme, servie au rang `STAFF` et
 * au-dessus. Aucune route du parcours public ne la référence.
 */
export class CustomerDto extends CustomerSummaryDto implements Omit<Customer, 'createdAt'> {
  @ApiProperty({
    nullable: true,
    type: String,
    maxLength: NOTE_MAX_LENGTH,
    description:
      'Note interne du salon. **Jamais servie au parcours public** : c’est un ' +
      'champ de back-office, réservé aux rôles internes.',
  })
  public internalNote!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de création de la fiche.' })
  public createdAt!: string;
}

/** Une page de fiches, avec de quoi afficher un sélecteur de page. */
export class CustomerPageDto implements Omit<CustomerPage, 'items'> {
  @ApiProperty({ type: [CustomerSummaryDto] })
  public items!: CustomerSummaryDto[];

  @ApiProperty({ minimum: 1, example: 1 })
  public page!: number;

  @ApiProperty({ minimum: 1, example: DEFAULT_PAGE_SIZE })
  public pageSize!: number;

  @ApiProperty({ minimum: 0, description: 'Nombre total de fiches correspondant au filtre.' })
  public totalItems!: number;

  @ApiProperty({
    minimum: 0,
    description: '`0` sur un ensemble vide — « page 1 sur 0 » et non « page 1 sur 1 ».',
  })
  public totalPages!: number;
}

/**
 * Recherche et pagination du fichier client — `GET /customers`.
 *
 * `q` interroge nom, téléphone et e-mail d'un seul terme : le front-desk tape ce
 * qu'il a sous la main et n'a pas à choisir un champ avant de chercher. Trois
 * paramètres distincts auraient obligé l'écran à deviner la nature de ce qui
 * vient d'être tapé.
 *
 * Le plancher de deux caractères n'est pas de l'ergonomie : une lettre unique
 * ramènerait la quasi-totalité du fichier à chaque frappe, sans qu'aucun index
 * ne puisse aider.
 *
 * `@Type(() => Number)` est **nécessaire** : une query string ne transporte que
 * des chaînes, et le `ValidationPipe` global est en
 * `enableImplicitConversion: false` — `?page=2` arriverait sinon en `'2'` et
 * `@IsInt()` le refuserait.
 */
export class ListCustomersQueryDto {
  @ApiPropertyOptional({
    example: 'dur',
    minLength: SEARCH_MIN_LENGTH,
    maxLength: SEARCH_MAX_LENGTH,
    description:
      'Recherche par **préfixe** de nom, de prénom, d’adresse e-mail ou de numéro. ' +
      'Absent, la liste rend tout le fichier.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MinLength(SEARCH_MIN_LENGTH, {
    message: `q : au moins ${String(SEARCH_MIN_LENGTH)} caractères`,
  })
  @MaxLength(SEARCH_MAX_LENGTH)
  public q?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Inclut les fiches désactivées. `false` par défaut : elles n’ont rien à ' +
      'faire dans l’écran de prise de rendez-vous, qui est l’usage dominant.',
  })
  @IsOptional()
  // `'true'` / `'false'` en query string : la conversion est explicite ici parce
  // que le pipe global ne convertit pas implicitement. Toute autre valeur vaut
  // `false` — un `?includeInactive=oui` ne doit pas ouvrir la liste par accident.
  @Transform(({ value }: { value: unknown }) => value === true || value === 'true')
  @IsBoolean()
  public includeInactive?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page : entier attendu' })
  @Min(1)
  // Plafond **serveur** lui aussi : `@IsInt()` laisse passer `1e30`, dont le
  // décalage dépasse le `bigint` de PostgreSQL et sort en 500 au lieu du 400
  // annoncé.
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
export function toSearchQuery(dto: ListCustomersQueryDto): {
  q?: string;
  includeInactive: boolean;
  page: number;
  pageSize: number;
} {
  return {
    ...(dto.q === undefined ? {} : { q: dto.q }),
    includeInactive: dto.includeInactive ?? false,
    page: dto.page ?? 1,
    pageSize: dto.pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

/**
 * Création d'une fiche au comptoir — `POST /customers`.
 *
 * **Aucun mot de passe, aucun rôle.** La fiche naît inconnectable : elle existe
 * pour être réservée et rappelée, pas pour ouvrir une session.
 *
 * Limite connue : cette fiche ne peut pas encore devenir un compte —
 * `POST /auth/register` refuse en 409 une adresse déjà prise dans
 * l'établissement, empreinte nulle ou non. Le correctif appartient à `identity`
 * et fait l'objet d'une issue de suivi ; voir l'en-tête de
 * `createCustomerRequestSchema` dans `@spa/shared`.
 */
export class CreateCustomerDto {
  @ApiProperty({ example: 'alice@example.test', maxLength: EMAIL_MAX_LENGTH })
  // Élagué **avant** d'être jugé, contrairement au DTO d'invitation du personnel.
  // `emailSchema` de `@spa/shared` fait `.trim().toLowerCase()` : sans ce
  // décorateur, le contrat déclarerait bonne une adresse copiée-collée avec son
  // espace de fin, l'écran l'enverrait, et récolterait un 400 qu'il vient
  // lui-même d'annoncer impossible. C'est le sens dangereux de l'écart —
  // l'API plus stricte que le contrat qui la décrit.
  //
  // La casse, elle, n'est pas touchée ici : `@IsEmail()` accepte les majuscules,
  // et la canonisation en minuscules est faite une fois par `normalizeEmail`
  // côté service — la **même** fonction que `/auth/login`, pour que l'unicité
  // `(tenant_id, email)`, qui porte sur les octets, reste fiable.
  @Trim()
  @IsEmail({}, { message: 'email : adresse invalide' })
  @MaxLength(EMAIL_MAX_LENGTH)
  public email!: string;

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
  // `@IsOptional()` et non le `@ValidateIf` de la modification : à la création
  // il n'y a pas de valeur antérieure à effacer, « absent » et « null » disent
  // donc la même chose — pas de numéro.
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(PHONE_PATTERN, { message: 'phone : numéro de téléphone invalide' })
  public phone?: string;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX_LENGTH,
    description:
      'Note interne, acceptée dès la création : le front-desk a souvent la ' +
      'remarque à noter au même instant que la fiche.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(NOTE_MAX_LENGTH)
  public internalNote?: string;
}

/**
 * Modification d'une fiche — `PATCH /customers/:id`.
 *
 * Ni `email`, ni `isActive`, ni `role`. Le premier est la clé de
 * `@@unique([tenantId, email])` et l'identifiant de connexion : le changer
 * demande une vérification de la nouvelle adresse que le périmètre MVP ne
 * prévoit pas. Le deuxième a sa propre route. Le troisième est un geste
 * d'administration des droits, réservé à `ADMIN`.
 *
 * `@ValidateIf(value !== undefined)` plutôt que `@IsOptional()` sur les deux
 * noms : `@IsOptional()` laisse aussi passer un `null` explicite, qui
 * descendrait jusqu'à une colonne `NOT NULL`. Sur `phone` et `internalNote`, en
 * revanche, `null` **est** une valeur — c'est ainsi qu'on efface —, et la
 * validation le laisse traverser.
 */
export class UpdateCustomerDto {
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
    maxLength: PHONE_MAX_LENGTH,
    description: '`null` efface le numéro ; le champ absent le laisse tel quel.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Trim()
  @MinLength(1, { message: 'phone : renseigner un numéro ou envoyer null pour l’effacer' })
  @MaxLength(PHONE_MAX_LENGTH)
  @Matches(PHONE_PATTERN, { message: 'phone : numéro de téléphone invalide' })
  public phone?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    maxLength: NOTE_MAX_LENGTH,
    description: '`null` efface la note ; le champ absent la laisse telle quelle.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Trim()
  @MaxLength(NOTE_MAX_LENGTH)
  public internalNote?: string | null;
}

/**
 * Le DTO ramené à ce que le domaine connaît : les champs **présents**, et eux
 * seuls.
 *
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini »,
 * et le service doit pouvoir faire la même distinction : un `phone: undefined`
 * recopié dans un `data` Prisma effacerait le numéro, là où l'appelant demandait
 * seulement de ne pas y toucher.
 */
export function toCustomerPatch(dto: UpdateCustomerDto): CustomerPatch {
  return {
    ...(dto.firstName === undefined ? {} : { firstName: dto.firstName }),
    ...(dto.lastName === undefined ? {} : { lastName: dto.lastName }),
    ...(dto.phone === undefined ? {} : { phone: dto.phone }),
    ...(dto.internalNote === undefined ? {} : { internalNote: dto.internalNote }),
  };
}

/**
 * Activation ou désactivation d'une fiche — `PATCH /customers/:id/status`.
 *
 * Un booléen et non deux routes `/deactivate` et `/reactivate` : la
 * réactivation est le même geste, et deux points d'entrée auraient deux jeux de
 * gardes à tenir en accord. Le champ est **obligatoire** — un corps vide qui
 * « bascule » l'état rendrait l'opération non idempotente, donc dangereuse à
 * rejouer.
 */
export class SetCustomerStatusDto {
  @ApiProperty({
    description:
      '`false` retire la fiche des écrans de saisie. Ses rendez-vous passés et ' +
      'son historique restent intacts.',
  })
  @IsBoolean({ message: 'isActive : booléen attendu' })
  public isActive!: boolean;
}

/** La fiche telle qu'elle franchit la frontière HTTP — les instants en UTC. */
export function toCustomerDto(customer: Customer): CustomerDto {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    isActive: customer.isActive,
    internalNote: customer.internalNote,
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    createdAt: customer.createdAt.toISOString(),
  };
}
