import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Min, ValidateIf } from 'class-validator';

import { REFUND_STATUSES } from '../payments.types';
import type { RefundRecord } from '../payments.types';
import { MoneyDto, toMoneyDto } from './sale.dto';

/**
 * DTO du remboursement au comptoir — #63.
 *
 * ## Les deux champs qui existent, et les quatre qui n'existent pas
 *
 * `CreateRefundDto` porte un montant **facultatif** et un motif obligatoire. Il
 * ne porte ni `paymentId` — il est dans le chemin —, ni opérateur — il vient de
 * `@CurrentUser()`, donc d'un jeton vérifié —, ni `tenantId` — il vient de la
 * revendication signée (tenant-isolation §2) —, ni devise : celle de
 * l'encaissement fait foi, et en accepter une seconde ouvrirait la porte à un
 * cumul qui additionne deux monnaies.
 *
 * Le `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted`) refuse en
 * 400, en le nommant, tout champ qu'on y glisserait — un numéro de carte
 * compris (payments-stripe §1).
 *
 * ## Pourquoi le montant, lui, est accepté de l'appelant
 *
 * Contrairement au prix d'une prestation, un remboursement partiel n'existe
 * dans aucune table à relire : une personne le décide au comptoir, comme le
 * pourboire du ticket (#60). Il est donc accepté, puis **borné côté serveur** —
 * entier positif ici, cumul inférieur au montant capturé dans le service, et
 * `payment_refunds_amount_minor_check` en base. Ce n'est pas le front qui fait
 * autorité : c'est lui qui propose, et trois barrières qui disposent.
 *
 * TODO(#26) : ces formes rejoindront `@spa/shared` avec le reste du contrat.
 */
export class CreateRefundDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Montant à rendre, **entier** dans la plus petite unité de la devise de ' +
      'l’encaissement. Omis, c’est tout le solde restant qui est remboursé — le ' +
      'serveur le calcule, l’appelant n’a pas à le deviner.',
  })
  // `@ValidateIf` et non `@IsOptional()` : ce dernier ignore aussi `null`, si
  // bien qu'un corps portant `"amountMinor": null` traversait la validation
  // pour se faire refuser plus loin par le contrôle de cumul — un 422 « le
  // cumul dépasserait le montant encaissé » sur une requête simplement mal
  // formée. Absent, le champ vaut « tout le solde » ; présent, il est un entier
  // ou c'est un 400 qui le nomme.
  @ValidateIf((dto: CreateRefundDto) => dto.amountMinor !== undefined)
  @Type(() => Number)
  @IsInt({ message: 'amountMinor : entier attendu, dans la plus petite unité de la devise' })
  // Le zéro est refusé ici et pas seulement en base : un remboursement de rien
  // n'est pas un remboursement, et le laisser passer inscrirait une ligne de
  // traçabilité pour un geste qui n'a pas eu lieu.
  @Min(1, { message: 'amountMinor : au moins 1' })
  public amountMinor?: number;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Le **pourquoi** du remboursement, tel que le comptoir l’écrit. Obligatoire : ' +
      'un remboursement sans motif ne se rapproche de rien (CDC §4.9). Il reste en ' +
      'base et ne part jamais chez le prestataire — il peut nommer la cliente.',
  })
  @IsString({ message: 'reason : texte attendu' })
  @Length(3, 500, { message: 'reason : entre 3 et 500 caractères' })
  public reason!: string;
}

/**
 * Un remboursement, tel que l'API le rend — la ligne de traçabilité du CDC §4.9.
 *
 * `tenantId` n'y figure pas : information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4). Aucune donnée de
 * carte non plus — le domaine n'en a pas la notion, donc cette vue n'a pas de
 * champ où en ranger une (payments-stripe §1).
 */
export class RefundDto {
  @ApiProperty({ format: 'uuid', description: 'Notre identifiant de ligne — pas celui de Stripe.' })
  public id!: string;

  @ApiProperty({ format: 'uuid', description: 'L’encaissement remboursé.' })
  public paymentId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Montant rendu, dans la devise de l’encaissement.' })
  public amount!: MoneyDto;

  @ApiProperty({ maxLength: 500, description: 'Le motif saisi au comptoir — le « pourquoi ».' })
  public reason!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Le compte qui a ordonné le remboursement — le « qui ». Un identifiant ' +
      'opaque : ni nom, ni adresse électronique.',
  })
  public requestedByUserId!: string;

  @ApiProperty({
    enum: REFUND_STATUSES,
    description:
      'Sort de la **demande**, à ne pas confondre avec le statut de ' +
      'l’encaissement : celui-ci n’est écrit que par le webhook `charge.refunded`.',
  })
  public status!: RefundRecord['status'];

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Référence du remboursement chez le prestataire — celle du relevé. `null` ' +
      'tant que l’ordre n’a pas été accepté.',
  })
  public providerRefundId!: string | null;

  @ApiProperty({
    format: 'date-time',
    description: 'Instant UTC de la demande — le « quand ».',
  })
  public createdAt!: string;
}

/** Le remboursement tel qu'il franchit la frontière HTTP — les instants en UTC. */
export function toRefundDto(refund: RefundRecord): RefundDto {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: toMoneyDto(refund.amount),
    reason: refund.reason,
    requestedByUserId: refund.requestedByUserId,
    status: refund.status,
    providerRefundId: refund.providerRefundId,
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    createdAt: refund.createdAt.toISOString(),
  };
}
