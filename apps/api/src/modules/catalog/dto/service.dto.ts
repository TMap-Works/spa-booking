import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AMOUNT_MINOR_MAX,
  DISPLAY_NAME_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  bufferMinutesSchema,
  createServiceRequestSchema,
  durationMinutesSchema,
  nonNegativeMoneySchema,
  serviceSchema,
  updateServiceRequestSchema,
} from '@spa/shared';
import { IsBoolean, IsUUID } from 'class-validator';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { Money, ServiceView } from '../catalog.types';
import { ServiceCategorySummaryDto } from './service-category.dto';
import {
  BooleanQuery,
  CURRENCY_PATTERN,
  MAX_DURATION_MINUTES,
  MIN_BUFFER_MINUTES,
  MIN_DURATION_MINUTES,
  NON_NEGATIVE_AMOUNT_MINOR_FLOOR,
  OptionalPresent,
  optionalBody,
} from './validation';

/**
 * DTO des prestations du catalogue — **validés par le contrat partagé** (#510).
 *
 * ## Ce que ces classes sont devenues, et ce qu'elles ne sont plus
 *
 * Elles ne décrivent plus la frontière : elles la **documentent**.
 * `createServiceRequestSchema` et `updateServiceRequestSchema` de `@spa/shared`
 * décrivent ces deux corps, et ce sont eux qui les jugent, montés par
 * `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 *
 * La conséquence à connaître avant de toucher à ce fichier : **typer un
 * paramètre de handler par l'une de ces classes viderait le corps de la
 * requête**, le `ValidationPipe` global appliquant `whitelist` à une classe qui
 * n'a plus aucun décorateur `class-validator` à mettre sur sa liste blanche.
 *
 * ## L'écart constaté avant de substituer, et le seul qui reste
 *
 * | Champ | Le DTO validait | Le contrat valide | Verdict |
 * |---|---|---|---|
 * | `name` | `@Trim()` + `@MinLength(1)` + `@MaxLength(160)` | `displayNameSchema` | identique |
 * | `slug` | `@NormalizeSlug()` + `@Matches(SLUG_PATTERN)` + `@MaxLength(63)` | `slugSchema` | identique |
 * | `description` | `@Trim()` + `@MaxLength(2000)` | `longTextSchema` | identique |
 * | `categoryId` | `@IsUUID('4')` | `uuidSchema`, resserré sur la v4 par #403 | identique |
 * | `price.amountMinor` | `@IsInt()` + `@Min(0)` + `@Max(2 147 483 647)` | `nonNegativeMoneySchema` | identique |
 * | `price.currency` | `@NormalizeCurrency()` + `@Matches(/^[A-Z]{3}$/)` | `currencyCodeSchema` — `.trim().toUpperCase().length(3)` + le même motif | identique |
 * | `durationMinutes`, les deux tampons | `@Min(…)` **et `@Max(1440)`** | `durationMinutesSchema` / `bufferMinutesSchema`, **sans plafond** | voir ci-dessous |
 *
 * Le plafond est le seul écart, et il va dans le sens dangereux : substituer les
 * schémas tels quels **relâcherait** la frontière, là où l'ADR 0008 ne referme
 * un écart qu'en resserrant. `duration_minutes` est un `integer` PostgreSQL, et
 * une valeur au-delà de 2³¹ sortirait en `numeric value out of range` — un 500
 * là où l'appelant recevait un 400 nommant le champ.
 *
 * TODO(#536) : le plafond est donc **ajouté au schéma partagé** par les deux
 * `.extend()` ci-dessous, en attendant que le contrat le porte lui-même. Le
 * resserrement appartient à `packages/shared` et déborde l'empreinte de #510 :
 * `durationMinutesSchema` est lu par les schémas de rendez-vous, de créneaux et
 * de disponibilité, dont aucun n'est dans ce module. Une fois la borne posée
 * là-bas, les deux `.extend()` disparaissent et les schémas s'importent tels
 * quels. Le même TODO couvre les deux DTO de chaîne de requête du module —
 * `ListServicesQueryDto` et `ListServiceCategoriesQueryDto` — qu'aucun schéma du
 * contrat ne décrit, et dont les valeurs arrivent en `string` sans qu'aucun
 * schéma partagé ne les coerce.
 */

/**
 * Les durées, bornées par le haut — le contrat plus le plafond que la colonne
 * impose.
 *
 * `.max()` sur un schéma importé produit un **nouveau** schéma : `@spa/shared`
 * n'est pas modifié, et le plafond ne vaut que pour les deux routes de ce
 * module.
 */
const boundedDurationMinutesSchema = durationMinutesSchema.max(MAX_DURATION_MINUTES, {
  message: `une durée n’excède pas ${String(MAX_DURATION_MINUTES)} minutes`,
});

const boundedBufferMinutesSchema = bufferMinutesSchema.max(MAX_DURATION_MINUTES, {
  message: `un tampon n’excède pas ${String(MAX_DURATION_MINUTES)} minutes`,
});

/**
 * Le contrat de création, plus le plafond des durées.
 *
 * `.extend()` conserve le `.strict()` du schéma d'origine — un `tenantId` glissé
 * dans le corps reste refusé (tenant-isolation §2), et `ZodValidationPipe` le
 * vérifie au montage.
 */
const boundedCreateServiceRequestSchema = createServiceRequestSchema.extend({
  durationMinutes: boundedDurationMinutesSchema,
  bufferBeforeMinutes: boundedBufferMinutesSchema.optional(),
  bufferAfterMinutes: boundedBufferMinutesSchema.optional(),
});

/** Le contrat de modification, plus le même plafond. `.partial()` le conserve. */
const boundedUpdateServiceRequestSchema = updateServiceRequestSchema.extend({
  durationMinutes: boundedDurationMinutesSchema.optional(),
  bufferBeforeMinutes: boundedBufferMinutesSchema.optional(),
  bufferAfterMinutes: boundedBufferMinutesSchema.optional(),
});

/**
 * Les deux pipes du module — ce sont **eux** qui valident, et non les classes.
 *
 * Instanciés une fois au chargement du module plutôt qu'à chaque décoration :
 * les schémas ne changent pas d'une requête à l'autre, et la garde `.strict()`
 * du pipe se paie ainsi une seule fois, à l'amorçage.
 */
export const createServiceBody = new ZodValidationPipe(boundedCreateServiceRequestSchema);

/**
 * `optionalBody` n'enveloppe que la **modification** : aucun de ses champs n'est
 * obligatoire, et un `PATCH` sans corps du tout répondait 200 avant la
 * substitution. La création, elle, exige un nom, une durée et un prix — son
 * refus reste un 400 qui les nomme.
 */
export const updateServiceBody = new ZodValidationPipe(
  optionalBody(boundedUpdateServiceRequestSchema),
);

/** La création d'une prestation, telle que le contrat la rend au contrôleur. */
export type CreateServiceBody = z.infer<typeof boundedCreateServiceRequestSchema>;

/** La modification d'une prestation, telle que le contrat la rend au contrôleur. */
export type UpdateServiceBody = z.infer<typeof boundedUpdateServiceRequestSchema>;

/**
 * Un montant : entier dans la plus petite unité, plus son code devise — la
 * documentation de `nonNegativeMoneySchema`.
 *
 * **Jamais de flottant** (CLAUDE.md) : `0.1 + 0.2 !== 0.3` en IEEE 754, et
 * l'écart invisible sur un panier ne l'est plus au rapprochement bancaire de fin
 * de mois.
 *
 * Les deux champs voyagent dans le même objet, jamais côte à côte au premier
 * niveau du corps : deux champs indépendants peuvent être mis à jour séparément,
 * et il existerait alors un instant où le montant est libellé dans l'ancienne
 * devise.
 *
 * Le plancher publié est `0` et non `AMOUNT_MINOR_MIN` de `@spa/shared`
 * (−2 147 483 648) : celui-là est la borne de la colonne, que `moneySchema`
 * applique aux montants **signés**. Un prix passe par `nonNegativeMoneySchema`,
 * dont le plancher est zéro — publier l'autre annoncerait dans `/api/docs` un
 * prix négatif que la route refuse en 400.
 */
export class MoneyDto implements Money {
  @ApiProperty({
    description: 'Montant entier dans la plus petite unité monétaire — 3500 pour 35,00 €.',
    example: 3500,
    minimum: NON_NEGATIVE_AMOUNT_MINOR_FLOOR,
    maximum: AMOUNT_MINOR_MAX,
  })
  public amountMinor!: number;

  @ApiProperty({
    description: 'Code devise ISO 4217. Élagué et mis en majuscules à la frontière.',
    example: 'EUR',
    pattern: CURRENCY_PATTERN.source,
  })
  public currency!: string;
}

/** La création d'une prestation — la documentation du schéma borné ci-dessus. */
export class CreateServiceDto {
  @ApiProperty({ example: 'Massage californien 60 min', maxLength: DISPLAY_NAME_MAX_LENGTH })
  public name!: string;

  @ApiPropertyOptional({
    description:
      'Slug d’URL. Dérivé du nom quand il est absent ; le fournir sert à figer ' +
      'l’URL publique d’une prestation qu’on renomme. Élagué et abaissé à la frontière.',
    example: 'massage-californien-60-min',
    maxLength: SLUG_MAX_LENGTH,
  })
  public slug?: string;

  @ApiPropertyOptional({ maxLength: LONG_TEXT_MAX_LENGTH })
  public description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Rubrique du catalogue. Une prestation non classée reste vendable — ' +
      'imposer une catégorie obligerait à en inventer une avant la première prestation.',
  })
  public categoryId?: string;

  @ApiProperty({
    description: 'Durée facturée du soin, en minutes — ce que le client voit et paie.',
    example: 60,
    minimum: MIN_DURATION_MINUTES,
    maximum: MAX_DURATION_MINUTES,
  })
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
  public bufferBeforeMinutes?: number;

  @ApiPropertyOptional({
    description: 'Temps de remise en état après le soin, en minutes. Mêmes règles.',
    example: 15,
    default: 0,
    minimum: MIN_BUFFER_MINUTES,
    maximum: MAX_DURATION_MINUTES,
  })
  public bufferAfterMinutes?: number;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Prix affiché. **Obligatoire** : un corps sans prix est refusé en 400 par le ' +
      'schéma, là où la validation imbriquée de `class-validator` sautait sur une ' +
      'valeur absente et laissait le service déréférencer un `undefined`.',
  })
  public price!: MoneyDto;
}

/**
 * Modification d'une prestation — tous les champs facultatifs, la documentation
 * d'`updateServiceRequestSchema`.
 *
 * `isActive` s'y ajoute, et c'est **ainsi** qu'une prestation sort du catalogue.
 * Il n'y a pas de suppression : les rendez-vous passés la référencent, et le
 * reporting doit continuer à savoir ce qui a été vendu. Aucune route `DELETE`
 * n'existe dans ce module.
 *
 * `description` et `categoryId` acceptent `null` — respectivement « efface ce
 * texte » et « déclasse cette prestation ». Les autres champs le refusent : un
 * prix ou une durée ne s'efface pas, il se remplace. Le contrat tient la
 * distinction là où `@IsOptional()` la perdait.
 */
export class UpdateServiceDto {
  @ApiPropertyOptional({ maxLength: DISPLAY_NAME_MAX_LENGTH })
  public name?: string;

  @ApiPropertyOptional({ maxLength: SLUG_MAX_LENGTH })
  public slug?: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: '`null` efface la description.',
    maxLength: LONG_TEXT_MAX_LENGTH,
  })
  public description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'uuid',
    description: '`null` déclasse la prestation.',
  })
  public categoryId?: string | null;

  @ApiPropertyOptional({ minimum: MIN_DURATION_MINUTES, maximum: MAX_DURATION_MINUTES })
  public durationMinutes?: number;

  @ApiPropertyOptional({ minimum: MIN_BUFFER_MINUTES, maximum: MAX_DURATION_MINUTES })
  public bufferBeforeMinutes?: number;

  @ApiPropertyOptional({ minimum: MIN_BUFFER_MINUTES, maximum: MAX_DURATION_MINUTES })
  public bufferAfterMinutes?: number;

  @ApiPropertyOptional({ type: MoneyDto })
  public price?: MoneyDto;

  @ApiPropertyOptional({
    description: 'Retire la prestation du catalogue, ou l’y remet. Jamais une suppression.',
  })
  public isActive?: boolean;
}

/**
 * Filtres de la liste des prestations.
 *
 * Seule classe du fichier qui **valide encore** : une chaîne de requête arrive
 * en `string`, et aucun schéma du contrat ne décrit ce filtre ni ne coerce
 * `"true"` en booléen. Voir le `TODO(#536)` de l'en-tête.
 */
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

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

/**
 * Les classes qui documentent `/api/docs` doivent annoncer **exactement** les
 * champs que les pipes acceptent.
 *
 * Sans cette garde, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce.
 */
type _CreateServiceDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CreateServiceDto, keyof z.input<typeof boundedCreateServiceRequestSchema>>
  | Exclude<keyof z.input<typeof boundedCreateServiceRequestSchema>, keyof CreateServiceDto>
>;

type _UpdateServiceDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof UpdateServiceDto, keyof z.input<typeof boundedUpdateServiceRequestSchema>>
  | Exclude<keyof z.input<typeof boundedUpdateServiceRequestSchema>, keyof UpdateServiceDto>
>;

/**
 * La sortie, tenue dans le sens que l'exécution ne peut pas tenir.
 *
 * Une prestation ne porte aucun vocabulaire à casse divergente — ni statut, ni
 * rôle —, si bien que le jeu de clés **et** l'assignabilité champ par champ se
 * tiennent tous deux à la compilation, sans rien changer au format du fil.
 */
type ServiceWire = z.input<typeof serviceSchema>;
type MoneyWire = z.input<typeof nonNegativeMoneySchema>;

type _ServiceDtoHasTheContractKeys = AssertNever<
  Exclude<keyof ServiceDto, keyof ServiceWire> | Exclude<keyof ServiceWire, keyof ServiceDto>
>;

type _ServiceDtoIsReadableByTheContract = AssertTrue<ServiceDto extends ServiceWire ? true : false>;

type _MoneyDtoHasTheContractKeys = AssertNever<
  Exclude<keyof MoneyDto, keyof MoneyWire> | Exclude<keyof MoneyWire, keyof MoneyDto>
>;

type _MoneyDtoIsReadableByTheContract = AssertTrue<MoneyDto extends MoneyWire ? true : false>;
