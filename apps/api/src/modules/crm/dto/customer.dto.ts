import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CUSTOMER_HISTORY_MAX_VISITS,
  CUSTOMER_SEARCH_MAX_LENGTH,
  CUSTOMER_SEARCH_MIN_LENGTH,
  DEFAULT_PAGE_SIZE,
  EMAIL_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  MAX_PAGE_SIZE,
  NAME_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  type SetCustomerStatusRequest,
  customerPageSchema,
  customerSummarySchema,
  setCustomerStatusRequestSchema,
} from '@spa/shared';
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
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
// Import **de valeur** d'un vocabulaire de module voisin — même geste que
// l'`APPOINTMENT_STATUSES` de `customer-history.dto.ts`, et pour la même raison :
// l'énumération annoncée dans l'OpenAPI doit être *la* liste que la colonne
// écrit, pas une copie qui divergerait au premier motif ajouté. Le fichier
// importé ne porte que des types et des tableaux `as const`, sans dépendance
// Nest ni Prisma.
//
// Ce n'est **pas** l'`EMAIL_SUPPRESSION_REASONS` de `@spa/shared`, qui porte les
// mêmes deux motifs en **minuscules** (`hard_bounce`, `complaint`) : le contrat
// nomme ce que le front lit, cette classe documente ce que l'API émet — la casse
// de l'énumération PostgreSQL. Substituer l'import changerait l'énumération
// publiée par `/api/docs` sans changer une seule réponse, c'est-à-dire ferait
// mentir la documentation. Voir la note « ce qui reste » en fin de fichier.
import { EMAIL_SUPPRESSION_REASONS } from '../../notifications/notifications.types';
import type { CustomerPatch } from '../crm.repository';
import type { Customer, CustomerPage, CustomerSummary } from '../crm.types';

/**
 * DTO du fichier client — #56, **partiellement substitué par le contrat**
 * (#510, [ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 *
 * ## Ce qui a été substitué ici, et ce qui ne l'a pas été
 *
 * | Route | État | Pourquoi |
 * |---|---|---|
 * | `PATCH /customers/:id/status` | **validée par `setCustomerStatusRequestSchema`** | même règle, mot pour mot : un booléen obligatoire, rien d'autre |
 * | `POST /customers` | classe `class-validator` | le contrat ne porte pas `marketingConsent` — voir plus bas |
 * | `PATCH /customers/:id` | classe `class-validator` | même raison |
 * | `GET /customers` | classe `class-validator` | le contrat ne borne pas `page` par le haut — voir plus bas |
 *
 * Les **bornes**, elles, ne sont plus recopiées : elles viennent toutes de
 * `@spa/shared`, valeur pour valeur (`NAME_MAX_LENGTH` 80, `PHONE_MAX_LENGTH`
 * 32, `EMAIL_MAX_LENGTH` 320, `LONG_TEXT_MAX_LENGTH` 2000,
 * `CUSTOMER_SEARCH_MIN_LENGTH` 2, `CUSTOMER_SEARCH_MAX_LENGTH` 254,
 * `DEFAULT_PAGE_SIZE` 20, `MAX_PAGE_SIZE` 100, `CUSTOMER_HISTORY_MAX_VISITS`
 * 50). Aucune n'a changé de valeur au passage : c'était la condition pour les
 * importer sans relire le comportement de chaque route.
 *
 * ## Ce qu'aucun DTO d'entrée ne porte
 *
 * Ni `tenantId`, ni `role`, ni `isActive` sur les deux premiers, ni `email` sur
 * la modification. Le `ValidationPipe` global est en `whitelist` +
 * `forbidNonWhitelisted` sur les routes non substituées, et c'est le `.strict()`
 * du contrat sur `PATCH /customers/:id/status` : dans les deux cas, un champ non
 * déclaré est **refusé en 400 en le nommant**, jamais ignoré en silence. C'est ce
 * qui rend ces omissions exécutoires plutôt que déclaratives — un `tenantId`
 * glissé dans un corps JSON est exactement le scénario de fuite qu'on refuse
 * (tenant-isolation §2).
 *
 * ## Le piège de la substitution, à connaître avant de toucher ce fichier
 *
 * `SetCustomerStatusDto` n'a plus **aucun** décorateur `class-validator`. Typer
 * un paramètre de handler par cette classe **viderait le corps de la requête** :
 * le `ValidationPipe` global appliquerait `whitelist` à une classe qui n'a plus
 * rien à mettre sur sa liste blanche. Le handler prend le type inféré du schéma
 * (`SetCustomerStatusBody`) et déclare la classe par `@ApiBody`.
 *
 * Écart assumé, tranché en #554 : trois substitutions restent à faire, et aucune ne se fait ici
 * sans une décision de contrat, c'est-à-dire une modification de
 * `packages/shared` qui déborde l'empreinte de #510 :
 *
 * 1. **`POST /customers` et `PATCH /customers/:id`.**
 *    `createCustomerRequestSchema` et `updateCustomerRequestSchema` ne portent
 *    **pas** `marketingConsent`, que ces deux routes acceptent depuis #81. Les
 *    deux schémas étant `.strict()`, les monter ici refuserait en 400 un champ
 *    que l'API accepte aujourd'hui — un consentement RGPD perdu en silence à la
 *    saisie au comptoir. Le contrat doit d'abord décrire le champ (et la
 *    distinction « absent » / `false` qui le rend probant) ;
 * 2. **`GET /customers`.** `customerSearchQuerySchema` coerce bien les chaînes de
 *    la query string (`paginationQuerySchema` est en `z.coerce`), mais il ne
 *    borne pas `page` par le haut là où `ListCustomersQueryDto` applique
 *    {@link MAX_PAGE}. Le substituer ferait sortir `?page=1e30` en **500** —
 *    décalage hors du `bigint` de PostgreSQL — là où le contrat annonce un 400
 *    nommant le champ. Il faut d'abord porter la borne dans le contrat ;
 * 3. **`CustomerDto`.** `customerSchema` ne décrit ni `marketingConsent`, ni
 *    `marketingConsentAt` (#81). L'assertion « jeu de clés identique » ne peut
 *    donc pas être posée sur cette classe, contrairement à ses deux voisines
 *    ci-dessous ; c'est la même décision de contrat que le point 1.
 *    `anonymizedAt`, troisième champ de #81, **est** décrit par le contrat
 *    depuis #529 — l'avis d'adresse supprimée du back-office ne se lit pas sans
 *    lui.
 *
 * `EMAIL_SUPPRESSION_REASONS` reste importée du module `notifications` pour une
 * raison d'une autre nature, qui n'appelle aucune évolution du contrat : les deux
 * listes ne portent pas les mêmes valeurs — majuscules ici, minuscules dans le
 * contrat — parce qu'elles ne décrivent pas la même chose. Voir le commentaire de
 * l'import.
 */

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
 *
 * Elle est **locale**, et c'est ce qui retient la substitution de
 * `customerSearchQuerySchema` : le contrat ne la porte pas encore.
 */
const MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / MAX_PAGE_SIZE);

/**
 * Fenêtre de l'historique — c'est `CUSTOMER_HISTORY_MAX_VISITS` du contrat,
 * réexporté sous le nom que `customer-history.dto.ts` et le contrôleur
 * emploient déjà. Une seule écriture de la valeur, et elle est dans
 * `@spa/shared`.
 */
export const HISTORY_MAX_VISITS = CUSTOMER_HISTORY_MAX_VISITS;

/**
 * Numéro de téléphone — volontairement permissif, et c'est **le motif de
 * `storedPhoneSchema`** de `@spa/shared`, recopié faute que le paquet l'exporte
 * (il n'en publie que `E164_PATTERN` et `UUID_V4_PATTERN`).
 *
 * Le régime est celui que l'ADR 0008 arrête pour la fiche cliente : format libre
 * borné, **jamais** E.164. Une fiche s'enregistre et s'affiche ; elle ne se
 * compose pas — c'est le rappel SMS J-1 qui compose, et il part d'ailleurs.
 * Refuser un numéro pourtant valide empêche d'être rappelée, en accepter un
 * douteux ne coûte qu'un SMS non délivré.
 */
const PHONE_PATTERN = /^[+0-9][0-9\s().-]*$/;

/**
 * Élague une chaîne avant que les bornes ne la jugent — sans quoi `"   "`
 * passerait pour un prénom. Jumeau de celui d'`identity/dto/users.dto.ts`,
 * dupliqué pour la même raison (un module n'importe pas un fichier profond d'un
 * autre, api-module §3) et destiné à disparaître avec les trois substitutions
 * que l'écart assumé ci-dessus décrit : les schémas du contrat font le `.trim()`
 * eux-mêmes.
 */
const Trim = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * Fiche cliente réduite — l'élément des listes, et la documentation de
 * `customerSummarySchema`.
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
 *
 * Elle porte **deux champs que `customerSchema` ne décrit pas** —
 * `marketingConsent` et `marketingConsentAt`, ajoutés par #81. C'est pourquoi
 * elle n'a pas les deux assertions de compilation de `CustomerSummaryDto` : les
 * poser ferait échouer le `tsc` sur un écart réel, qui se referme dans le
 * contrat et non ici (écart assumé de l'en-tête). Le troisième champ de #81,
 * `anonymizedAt`, a fait le chemin inverse en #529 : il est entré au contrat
 * parce que le back-office en a besoin pour taire l'avis d'adresse supprimée sur
 * une fiche anonymisée.
 */
export class CustomerDto
  extends CustomerSummaryDto
  implements
    Omit<Customer, 'createdAt' | 'marketingConsentAt' | 'anonymizedAt' | 'emailSuppressedAt'>
{
  @ApiProperty({
    nullable: true,
    type: String,
    maxLength: LONG_TEXT_MAX_LENGTH,
    description:
      'Note interne du salon. **Jamais servie au parcours public** : c’est un ' +
      'champ de back-office, réservé aux rôles internes.',
  })
  public internalNote!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de création de la fiche.' })
  public createdAt!: string;

  @ApiProperty({
    description:
      'Consentement au démarchage commercial (RGPD, CDC §5.1). Ne gouverne **pas** ' +
      'les notifications transactionnelles — confirmation, rappel, annulation —, qui ' +
      'relèvent de l’exécution du contrat et non du consentement.',
  })
  public marketingConsent!: boolean;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Instant du dernier changement du consentement — la preuve exigée par ' +
      'l’art. 7.1. `null` tant que personne ne s’est prononcé : « jamais demandé » ' +
      'n’est pas « refusé à telle date ».',
  })
  public marketingConsentAt!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Instant de l’anonymisation, ou `null` sur une fiche vivante. Daté, la fiche ' +
      'ne porte plus qu’un pseudonyme ; ses rendez-vous et ses encaissements restent ' +
      'comptés.',
  })
  public anonymizedAt!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Instant UTC auquel l’adresse a cessé d’être écrite — rebond définitif ou ' +
      'plainte —, ou `null` sur une adresse vivante. Le back-office l’affiche dans ' +
      'le fuseau de l’établissement : une cliente dont l’adresse est supprimée ne ' +
      'reçoit plus ni confirmation, ni rappel, ni avis d’annulation.',
  })
  public emailSuppressedAt!: string | null;

  @ApiProperty({
    enum: EMAIL_SUPPRESSION_REASONS,
    nullable: true,
    type: String,
    description:
      'Ce qui a valu la suppression — nul **exactement** quand `emailSuppressedAt` ' +
      'l’est. `HARD_BOUNCE` : la boîte n’existe pas ou la refuse définitivement. ' +
      '`COMPLAINT` : le destinataire a signalé le message comme indésirable. Un ' +
      'rebond transitoire ne supprime rien et n’apparaît donc jamais ici.',
  })
  public emailSuppressionReason!: Customer['emailSuppressionReason'];
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
 *
 * Cette classe **valide encore** : voir le point 2 de l'écart assumé de l'en-tête.
 */
export class ListCustomersQueryDto {
  @ApiPropertyOptional({
    example: 'dur',
    minLength: CUSTOMER_SEARCH_MIN_LENGTH,
    maxLength: CUSTOMER_SEARCH_MAX_LENGTH,
    description:
      'Recherche par **préfixe** de nom, de prénom, d’adresse e-mail ou de numéro. ' +
      'Absent, la liste rend tout le fichier.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MinLength(CUSTOMER_SEARCH_MIN_LENGTH, {
    message: `q : au moins ${String(CUSTOMER_SEARCH_MIN_LENGTH)} caractères`,
  })
  @MaxLength(CUSTOMER_SEARCH_MAX_LENGTH)
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
  // C'est mot pour mot le prédicat de `customerSearchQuerySchema`, qui refuse lui
  // aussi `z.coerce.boolean()` pour cette raison précise.
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
  // annoncé. Le contrat ne le porte pas encore — c'est ce qui retient la
  // substitution de cette classe.
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
 *
 * Cette classe **valide encore** : voir le point 1 de l'écart assumé de l'en-tête —
 * `createCustomerRequestSchema` est `.strict()` et ne déclare pas
 * `marketingConsent`.
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
    maxLength: LONG_TEXT_MAX_LENGTH,
    description:
      'Note interne, acceptée dès la création : le front-desk a souvent la ' +
      'remarque à noter au même instant que la fiche.',
  })
  @IsOptional()
  @IsString()
  @Trim()
  @MaxLength(LONG_TEXT_MAX_LENGTH)
  public internalNote?: string;

  @ApiPropertyOptional({
    description:
      'Consentement au démarchage commercial. **Absent, il vaut refus** et aucune ' +
      'date n’est enregistrée : le consentement est un acte positif (RGPD art. 4.11), ' +
      'et « jamais demandé » n’est pas « refusé à telle date ». Présent — à `true` ' +
      'comme à `false` —, il date la réponse.',
  })
  // `@ValidateIf` et non `@IsOptional()`, contrairement à `phone` et
  // `internalNote` : `@IsOptional()` laisse aussi passer un `null` explicite,
  // et sur un booléen `null` n'est pas une valeur — `marketing_consent` est
  // `NOT NULL`. Un `null` accepté ici serait lu comme « quelqu'un s'est
  // prononcé », et daterait une preuve de refus que personne n'a donnée.
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean({ message: 'marketingConsent : booléen attendu' })
  public marketingConsent?: boolean;
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
 *
 * Cette classe **valide encore** : voir le point 1 de l'écart assumé de l'en-tête —
 * `updateCustomerRequestSchema` est `.strict()` et ne déclare pas
 * `marketingConsent`.
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
    maxLength: LONG_TEXT_MAX_LENGTH,
    description: '`null` efface la note ; le champ absent la laisse telle quelle.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Trim()
  @MaxLength(LONG_TEXT_MAX_LENGTH)
  public internalNote?: string | null;

  @ApiPropertyOptional({
    description:
      'Consentement au démarchage commercial. Le champ absent le laisse tel quel ; ' +
      'une valeur **différente** de l’actuelle l’écrit et le date. Renvoyer la valeur ' +
      'en place ne décale pas la date — elle répond à « depuis quand », pas à ' +
      '« quand a-t-on enregistré pour la dernière fois ».',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsBoolean({ message: 'marketingConsent : booléen attendu' })
  public marketingConsent?: boolean;
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
    // La **date** du consentement n'est pas dans le correctif : c'est le service
    // qui l'appose, et seulement s'il constate un changement. Un client qui la
    // choisirait choisirait sa propre preuve.
    ...(dto.marketingConsent === undefined ? {} : { marketingConsent: dto.marketingConsent }),
  };
}

/**
 * Le pipe de `PATCH /customers/:id/status` — c'est **lui** qui valide, et non la
 * classe ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 *
 * `setCustomerStatusRequestSchema` est `.strict()` : un `tenantId`, un `role` ou
 * un `email` glissé dans ce corps est **refusé**, exactement comme le faisait
 * `forbidNonWhitelisted` (tenant-isolation §2). Le refus a la même forme —
 * `BadRequestException` portant un tableau de messages, servie en
 * `VALIDATION_ERROR` par `DomainExceptionFilter` — et aucun client ne distingue
 * cette route de ses voisines non encore substituées.
 */
export const setCustomerStatusBody = new ZodValidationPipe(setCustomerStatusRequestSchema);

/** L'état demandé, tel que le contrat le rend au contrôleur. */
export type SetCustomerStatusBody = SetCustomerStatusRequest;

/**
 * Activation ou désactivation d'une fiche — `PATCH /customers/:id/status`, la
 * documentation de `setCustomerStatusRequestSchema`.
 *
 * Un booléen et non deux routes `/deactivate` et `/reactivate` : la
 * réactivation est le même geste, et deux points d'entrée auraient deux jeux de
 * gardes à tenir en accord. Le champ est **obligatoire** — un corps vide qui
 * « bascule » l'état rendrait l'opération non idempotente, donc dangereuse à
 * rejouer.
 *
 * Elle n'a plus **aucun** décorateur `class-validator` : la typer sur un
 * paramètre de handler viderait le corps de la requête (ADR 0008).
 */
export class SetCustomerStatusDto {
  @ApiProperty({
    description:
      '`false` retire la fiche des écrans de saisie. Ses rendez-vous passés et ' +
      'son historique restent intacts.',
  })
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
    marketingConsent: customer.marketingConsent,
    // `null` traverse tel quel : « jamais prononcé » et « jamais anonymisée »
    // sont des faits, pas des dates manquantes.
    marketingConsentAt: customer.marketingConsentAt?.toISOString() ?? null,
    anonymizedAt: customer.anonymizedAt?.toISOString() ?? null,
    // Les deux champs de #525 voyagent **appariés** — nuls ensemble, renseignés
    // ensemble. Ce n'est pas cette fonction qui le garantit : c'est l'unique
    // écriture qui les pose, dans `notifications`. Ici, `null` traverse tel quel
    // comme pour les deux dates précédentes, parce que « adresse vivante » est un
    // fait et non une date manquante.
    emailSuppressedAt: customer.emailSuppressedAt?.toISOString() ?? null,
    // La valeur de l'énumération PostgreSQL, telle quelle : le contrat partagé
    // la ramène en minuscules à la lecture (`receivedEmailSuppressionReasonSchema`),
    // exactement comme il le fait des rôles émis par `identity`.
    emailSuppressionReason: customer.emailSuppressionReason,
  };
}

// ---------------------------------------------------------------------------
// La sortie tenue par le contrat — à la compilation, faute de pouvoir l'être à
// l'exécution
// ---------------------------------------------------------------------------

/**
 * Les schémas de sortie du contrat décrivent ce que le **front lit**, pas ce que
 * l'API **émet** : `receivedEmailSuppressionReasonSchema` ramène `HARD_BOUNCE` en
 * `hard_bounce`, comme il le fait des rôles. Valider notre propre sortie contre
 * eux exigerait donc de changer le format du fil, ce qui déborde ce ticket et
 * casserait tout lecteur du back-office.
 *
 * Ce que le contrat peut garder, en revanche, c'est la **forme entrante** qu'il
 * sait lire — `z.input<…>` —, et il la garde à la compilation. Les assertions
 * ci-dessous coûtent zéro à l'exécution et échouent au `tsc` :
 *
 * 1. le **jeu de clés** est exactement celui du schéma. Un champ ajouté d'un
 *    côté et pas de l'autre casse la compilation, là où il aurait autrement
 *    voyagé sans que personne ne le lise ;
 * 2. **chaque champ** est assignable à ce que le schéma sait lire.
 *
 * Elles portent sur `CustomerSummaryDto` et `CustomerPageDto`, dont les jeux de
 * clés coïncident avec le contrat. `CustomerDto` en est privée, et l'en-tête dit
 * pourquoi : `customerSchema` ignore `marketingConsent` et `marketingConsentAt`,
 * les deux champs de #81 qu'aucun écran ne lit encore.
 */
type CustomerSummaryWire = z.input<typeof customerSummarySchema>;
type CustomerPageWire = z.input<typeof customerPageSchema>;

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

type _CustomerSummaryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CustomerSummaryDto, keyof CustomerSummaryWire>
  | Exclude<keyof CustomerSummaryWire, keyof CustomerSummaryDto>
>;

type _CustomerSummaryDtoIsReadableByTheContract = AssertTrue<
  CustomerSummaryDto extends CustomerSummaryWire ? true : false
>;

type _CustomerPageDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CustomerPageDto, keyof CustomerPageWire>
  | Exclude<keyof CustomerPageWire, keyof CustomerPageDto>
>;

type _CustomerPageDtoIsReadableByTheContract = AssertTrue<
  CustomerPageDto extends CustomerPageWire ? true : false
>;

/**
 * Même garde sur l'**entrée** substituée, dans l'autre sens : la classe qui
 * documente `/api/docs` doit annoncer exactement les champs que le pipe accepte.
 *
 * Sans elle, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce.
 */
type _SetCustomerStatusDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof SetCustomerStatusDto, keyof z.input<typeof setCustomerStatusRequestSchema>>
  | Exclude<keyof z.input<typeof setCustomerStatusRequestSchema>, keyof SetCustomerStatusDto>
>;
