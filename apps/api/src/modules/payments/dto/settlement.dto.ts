import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { PAYMENT_METHODS } from '../payments.types';
import type { PaymentMethod, SaleSettlement } from '../payments.types';
import type { SaleLineRequest } from '../pos.types';
import type { SettlementRequest } from '../settlement.rules';
import {
  CreateCashPaymentDto,
  PaymentTransactionDto,
  toPaymentTransactionDto,
} from './cash-payment.dto';
import { MAX_AMOUNT_MINOR, MoneyDto, toMoneyDto, toSaleLineRequests } from './sale.dto';

/**
 * DTO du règlement d'un ticket — #817.
 *
 * ## Les deux montants, et pourquoi ils ne sont pas un seul
 *
 * `amountMinor` est **ce qu'on règle** ; `tenderedAmountMinor` est **ce que la
 * cliente a tendu**. Sur un ticket de 78,00 €, « je règle 50,00 € » et « voici
 * un billet de 100,00 € » sont deux gestes différents : le premier laisse
 * 28,00 € dus, le second solde le ticket et ouvre le tiroir pour 22,00 €. Les
 * fondre en un seul champ aurait obligé le serveur à deviner lequel des deux on
 * lui demande, et deviner sur le chemin de l'argent est exactement ce qu'on
 * évite.
 *
 * Ils s'excluent donc : les envoyer tous les deux est refusé en 400, avec le
 * champ nommé. Le second n'a de sens qu'en espèces — un terminal débite un
 * montant exact et n'a pas de monnaie à rendre.
 *
 * ## Ce que le corps ne porte pas
 *
 * Ni total, ni devise, ni `saleId`, ni opérateur, ni `tenantId`. Le montant dû
 * est celui que le serveur a composé, relu en base sous verrou (cinquième
 * critère) ; le ticket est désigné par l'URL ; l'opérateur vient du jeton et
 * l'établissement de la revendication signée (tenant-isolation §2). Le
 * `ValidationPipe` global refuse en 400, en le nommant, tout champ qu'on y
 * glisserait.
 */

/**
 * Les deux moitiés d'un règlement s'excluent, et le billet tendu ne vaut qu'en
 * espèces.
 *
 * Écrites comme des contraintes de validation plutôt que comme des refus du
 * service : c'est la **forme** de la requête qui est fautive, pas une règle
 * métier qu'un état de la base rendrait vraie ou fausse — donc 400, et le champ
 * nommé, plutôt qu'un 422 qui laisserait croire que le ticket est en cause.
 */
@ValidatorConstraint({ name: 'coherentSettlementAmounts', async: false })
export class CoherentSettlementAmounts implements ValidatorConstraintInterface {
  public validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SettleSaleDto;

    if (dto.amountMinor !== undefined && dto.tenderedAmountMinor !== undefined) {
      return false;
    }

    return dto.tenderedAmountMinor === undefined || dto.method === 'CASH';
  }

  public defaultMessage(args: ValidationArguments): string {
    const dto = args.object as SettleSaleDto;

    return dto.amountMinor !== undefined && dto.tenderedAmountMinor !== undefined
      ? 'tenderedAmountMinor : un billet tendu et une part réglée sont deux gestes distincts'
      : 'tenderedAmountMinor : seules les espèces rendent la monnaie';
  }
}

export class SettleSaleDto {
  @ApiProperty({
    enum: PAYMENT_METHODS,
    description:
      'Le moyen employé au comptoir. `CARD` désigne le **terminal du salon** — ' +
      'jamais Stripe (#834) : rien de ce que le terminal manipule ne traverse ' +
      'notre code, et le serveur n’en conserve que l’issue.',
  })
  @IsIn(PAYMENT_METHODS, { message: `method : une valeur parmi ${PAYMENT_METHODS.join(', ')}` })
  public method!: PaymentMethod;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_AMOUNT_MINOR,
    description:
      'La part réglée maintenant, en entier dans la plus petite unité. Omise, ' +
      'c’est **tout le reste dû** — le cas courant du règlement en une fois. ' +
      'Supérieure au reste dû, elle sort en 422 `SALE_OVERPAYMENT` : le ' +
      'serveur ne rogne jamais un montant en silence.',
  })
  @IsOptional()
  @IsInt({ message: 'amountMinor : entier attendu, dans la plus petite unité monétaire' })
  @Min(1, { message: 'amountMinor : un règlement nul ne se saisit pas' })
  @Max(MAX_AMOUNT_MINOR)
  public amountMinor?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_AMOUNT_MINOR,
    description:
      'Ce que la cliente a tendu — **espèces seulement**. L’excédent n’est pas ' +
      'un dépassement, c’est la monnaie rendue : `change` la porte dans la ' +
      'réponse. S’exclut de `amountMinor`.',
  })
  @IsOptional()
  @Validate(CoherentSettlementAmounts)
  @IsInt({ message: 'tenderedAmountMinor : entier attendu, dans la plus petite unité monétaire' })
  @Min(1, { message: 'tenderedAmountMinor : un billet nul ne se tend pas' })
  @Max(MAX_AMOUNT_MINOR)
  public tenderedAmountMinor?: number;
}

/**
 * Ce que le comptoir reçoit d'un règlement.
 *
 * Trois faits, et il faut les trois : l'encaissement inscrit, l'état du ticket
 * après lui, et la monnaie à rendre. Sans `remaining`, l'écran ne saurait pas
 * s'il reste à encaisser ; sans `change`, il devrait recalculer une différence
 * dont le serveur seul connaît les deux termes.
 */
export class SaleSettlementDto {
  @ApiProperty({ type: PaymentTransactionDto })
  public payment!: PaymentTransactionDto;

  @ApiProperty({ format: 'uuid', description: 'Le ticket réglé.' })
  public saleId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Le total du ticket, composé par le serveur.' })
  public total!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: 'Ce qui est engagé après ce règlement.' })
  public settled!: MoneyDto;

  @ApiProperty({ type: MoneyDto, description: '`total − settled`. `0` sur un ticket soldé.' })
  public remaining!: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'La monnaie à rendre. `0` partout sauf lorsqu’un billet dépasse le reste ' +
      'dû — elle n’est jamais encaissée, donc jamais inscrite en base.',
  })
  public change!: MoneyDto;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Instant UTC du solde, ou `null` s’il reste à encaisser.',
  })
  public settledAt!: string | null;
}

/** Le geste demandé, tel que le service le lit. */
export function toSettlementRequest(dto: SettleSaleDto): SettlementRequest {
  return {
    method: dto.method,
    ...(dto.amountMinor === undefined ? {} : { amountMinor: dto.amountMinor }),
    ...(dto.tenderedAmountMinor === undefined
      ? {}
      : { tenderedAmountMinor: dto.tenderedAmountMinor }),
  };
}

/** Le règlement d'un rendez-vous : espèces, et le reste dû par défaut. */
export function toCashSettlementRequest(dto: CreateCashPaymentDto): SettlementRequest {
  return {
    method: 'CASH',
    ...(dto.tenderedAmountMinor === undefined
      ? {}
      : { tenderedAmountMinor: dto.tenderedAmountMinor }),
  };
}

/** Les lignes ajoutées au ticket d'un rendez-vous, ou aucune. */
export function toExtraLines(dto: CreateCashPaymentDto): readonly SaleLineRequest[] {
  return dto.lines === undefined ? [] : toSaleLineRequests(dto.lines);
}

/** L'issue du règlement telle qu'elle franchit la frontière HTTP — instants en UTC. */
export function toSaleSettlementDto(settlement: SaleSettlement): SaleSettlementDto {
  return {
    payment: toPaymentTransactionDto(settlement.payment),
    saleId: settlement.saleId,
    total: toMoneyDto(settlement.total),
    settled: toMoneyDto(settlement.settled),
    remaining: toMoneyDto(settlement.remaining),
    change: toMoneyDto(settlement.change),
    settledAt: settlement.settledAt === null ? null : settlement.settledAt.toISOString(),
  };
}
