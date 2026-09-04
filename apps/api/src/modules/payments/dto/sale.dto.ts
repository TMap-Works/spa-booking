import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { SALE_ITEM_KINDS } from '../pos.types';
import type { Sale, SaleItem, SaleLineRequest, SaleRequest } from '../pos.types';

/**
 * DTO du ticket de caisse — #60.
 *
 * ## Le champ qui n'existe pas
 *
 * Il n'y a **aucun** champ de montant sur une ligne `SERVICE` ou `PRODUCT`, et
 * aucun champ de total sur le ticket. Ce n'est pas une omission qu'un contrôle
 * rattrape ensuite : c'est la forme même du contrat. Le troisième critère de
 * #60 — « le montant envoyé par le front ne fait jamais autorité » — tient ici
 * par construction, et le `ValidationPipe` global (`whitelist` +
 * `forbidNonWhitelisted`) refuse en 400, en le nommant, tout champ qu'on y
 * glisserait.
 *
 * Le pourboire fait exception, et il est le seul : il n'existe dans aucune table
 * à relire. Le serveur ne peut que le valider — le borner, refuser un flottant
 * —, jamais le recalculer.
 *
 * ## Pourquoi une ligne plate plutôt qu'une union discriminée à la validation
 *
 * `class-transformer` sait instancier des sous-types selon un discriminant, mais
 * la combinaison avec `forbidNonWhitelisted` sur un tableau imbriqué est
 * fragile, et son échec est silencieux — exactement le genre de dépendance dont
 * on ne veut pas sur le chemin de l'argent. La ligne est donc un seul DTO, dont
 * chaque champ n'est **exigé** que pour la nature qui le porte.
 *
 * Un champ présent sur une nature qui ne l'utilise pas ne fait rien : c'est
 * `toSaleRequest` qui compose la demande du domaine, en ne lisant de chaque
 * ligne que ce que son `kind` autorise. Ce qui n'est pas lu n'atteint pas la
 * base.
 *
 * TODO(#26) : ces bornes rejoindront `@spa/shared` avec le reste du contrat.
 */

/** Les natures qu'un comptoir a le droit de demander. */
const REQUESTABLE_KINDS = ['SERVICE', 'PRODUCT', 'TIP'] as const;

/**
 * Bornes du ticket. Elles ne sont pas ergonomiques mais défensives : un tableau
 * non borné est un déni de service à une requête, et cent lignes de mille unités
 * suffisent déjà à dépasser ce qu'une colonne de montant peut porter.
 */
const MAX_LINES = 100;
const MAX_QUANTITY = 1000;

/** Borne haute d'un montant — celle du type de la colonne. */
const MAX_AMOUNT_MINOR = 2_147_483_647;

/**
 * Une ligne demandée par le comptoir.
 *
 * | `kind` | Champs exigés | Ce que le serveur fait |
 * |---|---|---|
 * | `SERVICE` | `serviceId`, `quantity` | relit le prix par `ServicesService` |
 * | `PRODUCT` | `productId`, `quantity` | relit le prix au rayon |
 * | `TIP` | `amountMinor` | valide et borne — il n'y a rien à relire |
 *
 * `TAX` n'est **pas** demandable : la taxe est composée par le serveur à partir
 * du taux de l'établissement. L'accepter du front aurait fait du navigateur
 * l'autorité sur ce que le salon doit au fisc.
 */
export class SaleLineDto {
  @ApiProperty({
    enum: REQUESTABLE_KINDS,
    description:
      'Nature de la ligne. `TAX` est absent à dessein : la taxe est composée ' +
      'par le serveur, jamais demandée.',
  })
  @IsIn(REQUESTABLE_KINDS, { message: `kind : une valeur parmi ${REQUESTABLE_KINDS.join(', ')}` })
  public kind!: (typeof REQUESTABLE_KINDS)[number];

  @ApiPropertyOptional({ format: 'uuid', description: 'Exigé — et lu — sur une ligne `SERVICE`.' })
  @ValidateIf((line: SaleLineDto) => line.kind === 'SERVICE')
  @IsUUID('4', { message: 'serviceId : identifiant de prestation attendu' })
  public serviceId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Exigé — et lu — sur une ligne `PRODUCT`.' })
  @ValidateIf((line: SaleLineDto) => line.kind === 'PRODUCT')
  @IsUUID('4', { message: 'productId : identifiant d’article attendu' })
  public productId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_QUANTITY,
    description: 'Exigé sur `SERVICE` et `PRODUCT`. Une ligne de quantité nulle n’est pas une ligne.',
  })
  @ValidateIf((line: SaleLineDto) => line.kind === 'SERVICE' || line.kind === 'PRODUCT')
  @IsInt({ message: 'quantity : entier attendu' })
  @Min(1, { message: 'quantity : au moins 1' })
  @Max(MAX_QUANTITY)
  public quantity?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_AMOUNT_MINOR,
    description:
      'Exigé sur `TIP`, et **le seul montant que l’API accepte** : un pourboire ' +
      'n’existe dans aucune table à relire. En entier, dans la plus petite ' +
      'unité de la devise de l’établissement.',
  })
  @ValidateIf((line: SaleLineDto) => line.kind === 'TIP')
  @IsInt({ message: 'amountMinor : entier attendu, dans la plus petite unité monétaire' })
  @Min(1, { message: 'amountMinor : un pourboire nul ne se saisit pas' })
  @Max(MAX_AMOUNT_MINOR)
  public amountMinor?: number;
}

/**
 * Au plus **un** pourboire par ticket.
 *
 * La règle est écrite ici parce qu'elle n'existe nulle part ailleurs : le
 * pourboire est la seule valeur que l'appelant fournit, et `composeSale` fond
 * les lignes `TIP` reçues en une seule ligne de reçu. Sans cette borne, deux
 * lignes envoyées par mégarde — un double clic sur « ajouter un pourboire », un
 * renvoi de formulaire — seraient **silencieusement additionnées**, et la
 * cliente réglerait deux fois ce qu'elle a laissé une fois, sans qu'aucun refus
 * ne le signale.
 *
 * Un refus en 400 plutôt qu'une somme : sur le chemin de l'argent, une
 * ambiguïté se rejette, elle ne s'interprète pas.
 */
@ValidatorConstraint({ name: 'atMostOneTipLine', async: false })
export class AtMostOneTipLine implements ValidatorConstraintInterface {
  public validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      // La forme est le problème d'`@IsArray`, pas le nôtre : rendre `false`
      // ici doublerait un refus déjà nommé par un message qui parle d'autre
      // chose.
      return true;
    }

    let tips = 0;
    for (const line of value as readonly unknown[]) {
      if (typeof line === 'object' && line !== null && (line as { kind?: unknown }).kind === 'TIP') {
        tips += 1;
      }
    }

    return tips <= 1;
  }

  public defaultMessage(): string {
    return 'lines : un seul pourboire par ticket';
  }
}

/**
 * Ouverture d'un ticket — `POST /sales`.
 *
 * Ni `cashierUserId`, ni `tenantId`, ni le moindre total : l'opérateur vient de
 * `@CurrentUser()`, l'établissement de la revendication signée, et les montants
 * du serveur.
 */
export class CreateSaleDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'Le rendez-vous que ce ticket facture. Absent ou `null` pour une vente ' +
      'retail autonome — deuxième critère de #60.',
  })
  // `@IsOptional()` et non `@ValidateIf` : ici `null` et « absent » disent la
  // même chose — pas de rendez-vous —, et il n'y a pas de valeur antérieure à
  // effacer sur une création.
  @IsOptional()
  @IsUUID('4', { message: 'appointmentId : identifiant de rendez-vous attendu' })
  public appointmentId?: string | null;

  @ApiProperty({
    type: [SaleLineDto],
    minItems: 1,
    maxItems: MAX_LINES,
    description:
      'Les lignes du ticket, dans l’ordre où le comptoir les a saisies. Au ' +
      'plus une ligne `TIP` : deux pourboires seraient additionnés en silence.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'lines : au moins une ligne' })
  @ArrayMaxSize(MAX_LINES)
  @Validate(AtMostOneTipLine)
  @ValidateNested({ each: true })
  // `@Type` est **nécessaire** : sans lui, `class-transformer` laisse des objets
  // nus et `@ValidateNested` n'a aucune classe sur laquelle appliquer les
  // décorateurs — le tableau traverserait la validation sans être jugé.
  @Type(() => SaleLineDto)
  public lines!: SaleLineDto[];
}

/** Un montant tel que l'API le rend — l'entier et sa devise, toujours ensemble. */
export class MoneyDto {
  @ApiProperty({ example: 1850, description: 'Entier, dans la plus petite unité de la devise.' })
  public amountMinor!: number;

  @ApiProperty({ example: 'EUR', minLength: 3, maxLength: 3, description: 'Code ISO 4217.' })
  public currency!: string;
}

/** Une ligne du ticket, telle que l'API la rend. */
export class SaleItemDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({
    enum: SALE_ITEM_KINDS,
    description: '`TAX` et `TIP` apparaissent ici — ce sont des lignes, jamais des colonnes.',
  })
  public kind!: SaleItem['kind'];

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  public serviceId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  public productId!: string | null;

  @ApiProperty({
    example: 'Shampoing hydratant 250 ml',
    description: 'Libellé **figé à la vente** : un renommage ultérieur ne réécrit pas les reçus.',
  })
  public label!: string;

  @ApiProperty({ example: 2, minimum: 1 })
  public quantity!: number;

  @ApiProperty({ type: MoneyDto })
  public unitAmount!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: '`unitAmount × quantity`, vérifié en base.' })
  public lineAmount!: MoneyDto;

  @ApiProperty({ minimum: 0, description: 'Rang de la ligne sur le reçu, à partir de 0.' })
  public position!: number;
}

/**
 * Le ticket, tel que l'API le rend.
 *
 * `tenantId` n'y figure pas : c'est une information interne qui n'apporte rien
 * au consommateur et invite aux essais (tenant-isolation §4).
 */
export class SaleDto {
  @ApiProperty({ format: 'uuid' })
  public id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  public appointmentId!: string | null;

  @ApiProperty({
    format: 'uuid',
    description: 'Le compte qui a composé le ticket — la traçabilité du comptoir.',
  })
  public cashierUserId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Somme des lignes `SERVICE` et `PRODUCT`.' })
  public subtotal!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Somme des lignes `TAX`.' })
  public tax!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Somme des lignes `TIP`.' })
  public tip!: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      '`subtotal + tax + tip`, **recalculé côté serveur** et vérifié par une ' +
      'contrainte de la base.',
  })
  public total!: MoneyDto;

  @ApiProperty({ type: [SaleItemDto] })
  public items!: SaleItemDto[];

  @ApiProperty({ format: 'date-time', description: 'Instant UTC de composition du ticket.' })
  public createdAt!: string;
}

/**
 * Le DTO ramené à ce que le domaine connaît.
 *
 * De chaque ligne, seuls les champs que son `kind` autorise sont lus : un
 * `serviceId` glissé sur une ligne `TIP` n'atteint donc jamais la base. Les
 * assertions non nulles sont couvertes par les `@ValidateIf` du DTO — une ligne
 * `SERVICE` sans `serviceId` a déjà été refusée en 400 avant d'arriver ici.
 */
export function toSaleRequest(dto: CreateSaleDto): SaleRequest {
  return {
    appointmentId: dto.appointmentId ?? null,
    lines: dto.lines.map((line): SaleLineRequest => {
      if (line.kind === 'SERVICE') {
        return { kind: 'SERVICE', serviceId: line.serviceId as string, quantity: line.quantity as number };
      }

      if (line.kind === 'PRODUCT') {
        return { kind: 'PRODUCT', productId: line.productId as string, quantity: line.quantity as number };
      }

      return { kind: 'TIP', amountMinor: line.amountMinor as number };
    }),
  };
}

function toMoneyDto(money: { amountMinor: number; currency: string }): MoneyDto {
  return { amountMinor: money.amountMinor, currency: money.currency };
}

function toSaleItemDto(item: SaleItem): SaleItemDto {
  return {
    id: item.id,
    kind: item.kind,
    serviceId: item.serviceId,
    productId: item.productId,
    label: item.label,
    quantity: item.quantity,
    unitAmount: toMoneyDto(item.unitAmount),
    lineAmount: toMoneyDto(item.lineAmount),
    position: item.position,
  };
}

/** Le ticket tel qu'il franchit la frontière HTTP — les instants en UTC. */
export function toSaleDto(sale: Sale): SaleDto {
  return {
    id: sale.id,
    appointmentId: sale.appointmentId,
    cashierUserId: sale.cashierUserId,
    subtotal: toMoneyDto(sale.subtotal),
    tax: toMoneyDto(sale.tax),
    tip: toMoneyDto(sale.tip),
    total: toMoneyDto(sale.total),
    items: sale.items.map((item) => toSaleItemDto(item)),
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    createdAt: sale.createdAt.toISOString(),
  };
}
