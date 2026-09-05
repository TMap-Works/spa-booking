import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
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
import type {
  Sale,
  SaleHistoryFilter,
  SaleItem,
  SaleLineRequest,
  SaleRequest,
  SaleSummary,
} from '../pos.types';
import { IsOffsetDateTime, PageQueryDto, toPageBounds, toWindowBound } from './validation';

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
 * Le ticket **sans ses lignes** — l'élément de l'historique des ventes (#62).
 *
 * `Omit` du DTO complet plutôt qu'une classe recopiée : les huit autres champs
 * doivent rester exactement ceux de `SaleDto`, description comprise. `OmitType`
 * de `@nestjs/swagger` reprend au passage les métadonnées OpenAPI, si bien que
 * le contrat publié ne diverge pas de la forme rendue.
 *
 * Les lignes sont écartées à dessein : une page de cinquante tickets de dix
 * lignes en ferait transiter cinq cents qu'aucun tableau n'affiche. Le détail
 * d'un ticket se demande par `GET /sales/:id`.
 */
export class SaleSummaryDto extends OmitType(SaleDto, ['items'] as const) {}

/** Une page de tickets, avec de quoi afficher un sélecteur de page. */
export class SalePageDto {
  @ApiProperty({ type: [SaleSummaryDto] })
  public items!: SaleSummaryDto[];

  @ApiProperty({ minimum: 1, example: 1 })
  public page!: number;

  @ApiProperty({ minimum: 1 })
  public pageSize!: number;

  @ApiProperty({ minimum: 0, description: 'Nombre total de tickets correspondant au filtre.' })
  public totalItems!: number;

  @ApiProperty({
    minimum: 0,
    description: '`0` sur un ensemble vide — « page 1 sur 0 » et non « page 1 sur 1 ».',
  })
  public totalPages!: number;
}

/**
 * Filtre de l'historique des ventes — `GET /sales`.
 *
 * Les quatre critères sont facultatifs : l'écran de caisse ouvre sur les
 * derniers tickets, pas sur un formulaire à remplir. `from` est **inclus**, `to`
 * **exclu** — même convention que l'historique des transactions, et pour la même
 * raison : deux journées de caisse bout à bout ne doivent compter le ticket de
 * minuit qu'une fois.
 *
 * `cashierUserId` et `appointmentId` répondent aux deux questions que le
 * back-office pose réellement : « qu'a vendu cette personne aujourd'hui ? » — la
 * relève de caisse — et « qu'a-t-on facturé sur ce rendez-vous ? » — le
 * rapprochement de la fiche cliente.
 */
export class ListSalesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00+02:00',
    description: 'Borne basse **incluse**, à offset explicite.',
  })
  @IsOptional()
  @IsOffsetDateTime()
  public from?: string;

  @ApiPropertyOptional({
    example: '2026-09-02T00:00:00+02:00',
    description: 'Borne haute **exclue**, à offset explicite.',
  })
  @IsOptional()
  @IsOffsetDateTime()
  public to?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restreindre à l’opérateur qui a composé les tickets — la relève de caisse.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'cashierUserId : identifiant d’opérateur attendu' })
  public cashierUserId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restreindre au rendez-vous facturé.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'appointmentId : identifiant de rendez-vous attendu' })
  public appointmentId?: string;
}

/**
 * Le filtre ramené à ce que le domaine connaît, valeurs par défaut appliquées.
 *
 * Les critères absents ne sont **pas** recopiés en `undefined` :
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini »,
 * et un `cashierUserId: undefined` porté jusqu'au `where` de Prisma s'y lirait
 * comme un filtre à composer plutôt que comme l'absence de filtre.
 */
export function toSaleHistoryFilter(dto: ListSalesQueryDto): SaleHistoryFilter {
  const from = toWindowBound(dto.from);
  const to = toWindowBound(dto.to);

  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(dto.cashierUserId === undefined ? {} : { cashierUserId: dto.cashierUserId }),
    ...(dto.appointmentId === undefined ? {} : { appointmentId: dto.appointmentId }),
    ...toPageBounds(dto),
  };
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

/**
 * Un montant du domaine, tel qu'il franchit la frontière HTTP.
 *
 * Exportée parce que `cash-payment.dto.ts` rend les mêmes montants et importe
 * déjà `MoneyDto` d'ici : deux copies de cette conversion, c'est deux endroits
 * où la devise pourrait cesser d'accompagner l'entier.
 */
export function toMoneyDto(money: { amountMinor: number; currency: string }): MoneyDto {
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

/** L'en-tête du ticket tel qu'il franchit la frontière HTTP — l'instant en UTC. */
export function toSaleSummaryDto(sale: SaleSummary): SaleSummaryDto {
  return {
    id: sale.id,
    appointmentId: sale.appointmentId,
    cashierUserId: sale.cashierUserId,
    subtotal: toMoneyDto(sale.subtotal),
    tax: toMoneyDto(sale.tax),
    tip: toMoneyDto(sale.tip),
    total: toMoneyDto(sale.total),
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    createdAt: sale.createdAt.toISOString(),
  };
}

/** Le ticket tel qu'il franchit la frontière HTTP, lignes comprises. */
export function toSaleDto(sale: Sale): SaleDto {
  return { ...toSaleSummaryDto(sale), items: sale.items.map((item) => toSaleItemDto(item)) };
}
