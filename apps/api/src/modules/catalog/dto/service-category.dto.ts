import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  type CreateServiceCategoryRequest,
  DISPLAY_NAME_MAX_LENGTH,
  LONG_TEXT_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  type UpdateServiceCategoryRequest,
  createServiceCategoryRequestSchema,
  serviceCategorySchema,
  serviceCategorySummarySchema,
  updateServiceCategoryRequestSchema,
} from '@spa/shared';
import { IsBoolean } from 'class-validator';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { ServiceCategorySummary, ServiceCategoryView } from '../catalog.types';
import { BooleanQuery, OptionalPresent, optionalBody } from './validation';

/**
 * DTO des catégories du catalogue — **validés par le contrat partagé** (#510).
 *
 * ## Ce que ces classes sont devenues, et ce qu'elles ne sont plus
 *
 * Elles ne décrivent plus la frontière : elles la **documentent**.
 * `createServiceCategoryRequestSchema` et `updateServiceCategoryRequestSchema`
 * de `@spa/shared` décrivent ces deux corps, et ce sont eux qui les jugent,
 * montés par `ZodValidationPipe`
 * ([ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md)).
 * Les classes survivent parce que le schéma OpenAPI de `/api/docs` sort des
 * décorateurs `@nestjs/swagger`, que Zod ne porte pas.
 *
 * La conséquence à connaître avant de toucher à ce fichier : **typer un
 * paramètre de handler par l'une de ces classes viderait le corps de la
 * requête**, le `ValidationPipe` global appliquant `whitelist` à une classe qui
 * n'a plus aucun décorateur `class-validator` à mettre sur sa liste blanche. Le
 * handler prend le type inféré du schéma et déclare la classe par `@ApiBody`.
 *
 * ## Les écarts constatés avant de substituer : aucun
 *
 * | Champ | Le DTO validait | Le contrat valide | Effet |
 * |---|---|---|---|
 * | `name` | `@Trim()` + `@MinLength(1)` + `@MaxLength(160)` | `displayNameSchema` — `.trim().min(1).max(160)` | identique |
 * | `slug` | `@NormalizeSlug()` + `@MaxLength(63)` + `@Matches(SLUG_PATTERN)` | `slugSchema` — `.trim().toLowerCase().min(1).max(63)` + le même motif | identique |
 * | `description` | `@Trim()` + `@MaxLength(2000)` | `longTextSchema` | identique |
 * | `isActive` | `@IsBoolean()` | `z.boolean()` | identique |
 *
 * Le `.strict()` du contrat remplace `forbidNonWhitelisted` : un `tenantId`
 * glissé dans le corps est **refusé**, pas silencieusement ignoré
 * (tenant-isolation §2). `.extend()` et `.partial()` conservent cette propriété,
 * et `ZodValidationPipe` la vérifie au montage.
 *
 * ## Ce qui reste sous `class-validator`, et pourquoi
 *
 * `ListServiceCategoriesQueryDto` seul. Une chaîne de requête ne transporte que
 * des chaînes, et aucun schéma du contrat ne décrit ce filtre ni ne coerce
 * `"true"` en booléen — voir le `TODO(#536)` de `service.dto.ts`.
 */

/**
 * Les deux pipes du module — ce sont **eux** qui valident, et non les classes.
 *
 * Instanciés une fois au chargement du module plutôt qu'à chaque décoration :
 * les schémas ne changent pas d'une requête à l'autre, et la garde `.strict()`
 * du pipe se paie ainsi une seule fois, à l'amorçage.
 */
export const createServiceCategoryBody = new ZodValidationPipe(createServiceCategoryRequestSchema);

/**
 * `optionalBody` n'enveloppe que la **modification** : aucun de ses champs n'est
 * obligatoire, et un `PATCH` sans corps du tout répondait 200 avant la
 * substitution. La création, elle, exige un nom — son refus reste un 400 qui le
 * nomme.
 */
export const updateServiceCategoryBody = new ZodValidationPipe(
  optionalBody(updateServiceCategoryRequestSchema),
);

/** La création d'une rubrique, telle que le contrat la rend au contrôleur. */
export type CreateServiceCategoryBody = CreateServiceCategoryRequest;

/** La modification d'une rubrique, telle que le contrat la rend au contrôleur. */
export type UpdateServiceCategoryBody = UpdateServiceCategoryRequest;

/** La création d'une rubrique — la documentation de `createServiceCategoryRequestSchema`. */
export class CreateServiceCategoryDto {
  @ApiProperty({ example: 'Soins du visage', maxLength: DISPLAY_NAME_MAX_LENGTH })
  public name!: string;

  @ApiPropertyOptional({
    description:
      'Slug d’URL. Dérivé du nom quand il est absent ; le fournir sert à figer ' +
      'l’URL publique d’une rubrique qu’on renomme. Élagué et abaissé à la frontière.',
    example: 'soins-du-visage',
    maxLength: SLUG_MAX_LENGTH,
  })
  public slug?: string;

  @ApiPropertyOptional({ maxLength: LONG_TEXT_MAX_LENGTH })
  public description?: string;
}

/**
 * Modification d'une catégorie — tous les champs facultatifs, la documentation
 * d'`updateServiceCategoryRequestSchema`.
 *
 * `isActive` s'y ajoute, et c'est **ainsi** qu'une rubrique sort du catalogue :
 * il n'y a pas de suppression, parce que des prestations la référencent et que
 * le reporting doit continuer à savoir sous quelle rubrique une vente a été
 * faite.
 *
 * `description` accepte `null` — il vaut « efface ce texte ». Les autres champs
 * refusent `null` : un nom ou un slug ne s'efface pas, il se remplace. Le
 * contrat tient la distinction là où `@IsOptional()` la perdait.
 */
export class UpdateServiceCategoryDto {
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
    description: 'Retire la rubrique du catalogue, ou l’y remet. Jamais une suppression.',
  })
  public isActive?: boolean;
}

/**
 * Filtres de la liste des catégories.
 *
 * Seule classe du fichier qui **valide encore** : une chaîne de requête arrive
 * en `string`, et aucun schéma du contrat ne décrit ce filtre. Voir le
 * `TODO(#536)` de `service.dto.ts`.
 */
export class ListServiceCategoriesQueryDto {
  @ApiPropertyOptional({
    description: 'Ne rendre que les rubriques actives. Par défaut, tout le catalogue.',
  })
  @OptionalPresent()
  @BooleanQuery()
  @IsBoolean()
  public activeOnly?: boolean;
}

/** Forme réduite, telle qu'imbriquée dans une prestation. */
export class ServiceCategorySummaryDto implements ServiceCategorySummary {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty()
  public slug!: string;

  @ApiProperty()
  public name!: string;
}

/**
 * La catégorie telle qu'elle sort de l'API.
 *
 * **Sans `tenantId`** : c'est une information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4). C'est pour cela
 * qu'aucune entité Prisma ne sort d'un contrôleur (api-module §4).
 */
export class ServiceCategoryDto extends ServiceCategorySummaryDto implements ServiceCategoryView {
  @ApiProperty({ nullable: true, type: String })
  public description!: string | null;

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
type _CreateServiceCategoryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CreateServiceCategoryDto, keyof z.input<typeof createServiceCategoryRequestSchema>>
  | Exclude<keyof z.input<typeof createServiceCategoryRequestSchema>, keyof CreateServiceCategoryDto>
>;

type _UpdateServiceCategoryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof UpdateServiceCategoryDto, keyof z.input<typeof updateServiceCategoryRequestSchema>>
  | Exclude<keyof z.input<typeof updateServiceCategoryRequestSchema>, keyof UpdateServiceCategoryDto>
>;

/**
 * Les deux sorties, tenues dans le sens que l'exécution ne peut pas tenir.
 *
 * Le contrat décrit ce que le **front lit** ; valider notre propre sortie contre
 * lui à l'exécution changerait le format du fil sur les vocabulaires à casse
 * divergente. Ici il n'y en a aucun — une rubrique n'a ni statut ni rôle — et la
 * garde tient donc à la compilation le jeu de clés **et** l'assignabilité champ
 * par champ.
 */
type ServiceCategoryWire = z.input<typeof serviceCategorySchema>;
type ServiceCategorySummaryWire = z.input<typeof serviceCategorySummarySchema>;

type _ServiceCategoryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof ServiceCategoryDto, keyof ServiceCategoryWire>
  | Exclude<keyof ServiceCategoryWire, keyof ServiceCategoryDto>
>;

type _ServiceCategoryDtoIsReadableByTheContract = AssertTrue<
  ServiceCategoryDto extends ServiceCategoryWire ? true : false
>;

type _ServiceCategorySummaryDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof ServiceCategorySummaryDto, keyof ServiceCategorySummaryWire>
  | Exclude<keyof ServiceCategorySummaryWire, keyof ServiceCategorySummaryDto>
>;

type _ServiceCategorySummaryDtoIsReadableByTheContract = AssertTrue<
  ServiceCategorySummaryDto extends ServiceCategorySummaryWire ? true : false
>;
