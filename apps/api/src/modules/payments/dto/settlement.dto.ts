import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { saleSettlementSchema, settleSaleRequestSchema } from '@spa/shared';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import type { z } from 'zod';

import { COUNTER_SETTLEMENT_MEANS } from '../payments.types';
import type { CounterSettlementMean, SaleSettlement } from '../payments.types';
import type { SaleLineRequest } from '../pos.types';
import type { SettlementRequest } from '../settlement.rules';
import { MAX_TERMINAL_REFERENCE_LENGTH, judgeTerminalReference } from '../terminal-reference';
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

/**
 * La référence du ticket du TPE : réservée au terminal, et jamais un numéro de
 * carte — #834, deuxième critère.
 *
 * Trois refus sous un seul validateur, parce qu'ils portent tous sur le même
 * champ et qu'un message par faute est ce dont le comptoir a besoin :
 *
 * | Ce qui est envoyé | Le message |
 * |---|---|
 * | une référence sur un règlement en espèces | « seul un passage au terminal en porte une » |
 * | autre chose que 32 caractères alphanumériques au plus | « forme attendue » |
 * | 13 à 19 chiffres dont la clé de Luhn est juste | « ce champ n'est pas celui d'un numéro de carte » |
 *
 * **400 et non 422** : c'est la forme de la requête qui est fautive, pas une
 * règle métier qu'un état de la base rendrait vraie ou fausse. Le refus tombe
 * donc dans le `ValidationPipe` global, avant qu'aucune ligne de code métier ne
 * s'exécute et avant que la valeur n'atteigne un journal — ce qui est la seule
 * façon de garantir qu'un PAN saisi par mégarde ne laisse aucune trace
 * (payments-stripe §1).
 */
@ValidatorConstraint({ name: 'legitimateTerminalReference', async: false })
export class LegitimateTerminalReference implements ValidatorConstraintInterface {
  public validate(value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as SettleSaleDto;

    if (typeof value !== 'string') {
      // La forme est le problème d'`@IsString`, pas le nôtre : un second refus
      // sur la même faute produirait deux messages qui parlent d'autre chose.
      return true;
    }

    return dto.method === 'CARD_TERMINAL' && judgeTerminalReference(value) === 'ok';
  }

  public defaultMessage(args: ValidationArguments): string {
    const dto = args.object as SettleSaleDto;

    if (dto.method !== 'CARD_TERMINAL') {
      return 'terminalReference : seul un passage au terminal en porte une';
    }

    return judgeTerminalReference(String(args.value)) === 'ressemble-a-une-carte'
      ? 'terminalReference : ce champ n’est pas celui d’un numéro de carte — saisir le numéro du ticket du terminal'
      : `terminalReference : ${String(MAX_TERMINAL_REFERENCE_LENGTH)} caractères alphanumériques au plus`;
  }
}

export class SettleSaleDto {
  @ApiProperty({
    enum: COUNTER_SETTLEMENT_MEANS,
    description:
      'Le moyen employé au comptoir. `CARD_TERMINAL` est le **TPE autonome du ' +
      'salon** — celui de sa banque, non relié à l’application : l’API n’appelle ' +
      'aucun prestataire, et rien de ce que le terminal manipule ne traverse ' +
      'notre code (#834, ADR 0015). Le paiement par carte **en ligne** n’est pas ' +
      'une valeur de ce champ : il vit dans le tunnel public, pas au comptoir.',
  })
  @IsIn(COUNTER_SETTLEMENT_MEANS, {
    message: `method : une valeur parmi ${COUNTER_SETTLEMENT_MEANS.join(', ')}`,
  })
  public method!: CounterSettlementMean;

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

  @ApiPropertyOptional({
    maxLength: MAX_TERMINAL_REFERENCE_LENGTH,
    example: 'A0000123',
    description:
      'Le numéro du ticket ou de l’autorisation imprimé par le TPE — **TPE ' +
      'seulement**, et facultatif : le caissier n’a pas toujours le ticket sous ' +
      'la main, et refuser le règlement pour cela bloquerait la caisse sur un ' +
      'champ de confort. Il sert le rapprochement de fin de journée avec le ' +
      'relevé du terminal. **Ce n’est pas un champ de carte** : une valeur de 13 ' +
      'à 19 chiffres dont la clé de Luhn est juste est refusée en 400.',
  })
  @IsOptional()
  @Validate(LegitimateTerminalReference)
  @IsString({ message: 'terminalReference : chaîne attendue' })
  public terminalReference?: string;
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

  @ApiProperty({
    description:
      '`true` lorsque la clé `Idempotency-Key` désignait un règlement **déjà ' +
      'inscrit** : rien n’a été écrit, et `payment` est celui de la première ' +
      'soumission (#834). L’écran n’a rien de différent à faire des deux cas — ' +
      'c’est l’intérêt de la clé — mais le comptoir a le droit de savoir qu’il ' +
      'n’a pas encaissé deux fois.',
  })
  public replayed!: boolean;
}

/** Le geste demandé, tel que le service le lit. */
export function toSettlementRequest(dto: SettleSaleDto): SettlementRequest {
  return {
    // La frontière est ici, et elle est le seul endroit où les deux
    // vocabulaires se rencontrent : le contrat nomme `CARD_TERMINAL` pour ne
    // rien laisser à deviner, le domaine dit `CARD` parce qu'au comptoir une
    // carte n'a plus qu'un chemin (ADR 0015). Même partage que la casse des
    // statuts, documentée en tête de `payments.types.ts`.
    method: dto.method === 'CASH' ? 'CASH' : 'CARD',
    ...(dto.amountMinor === undefined ? {} : { amountMinor: dto.amountMinor }),
    ...(dto.tenderedAmountMinor === undefined
      ? {}
      : { tenderedAmountMinor: dto.tenderedAmountMinor }),
    ...(dto.terminalReference === undefined
      ? {}
      : { terminalReference: dto.terminalReference }),
  };
}

/**
 * Le règlement d'un rendez-vous : espèces, et **tout le reste dû**.
 *
 * Aucune part, aucun billet tendu : le geste de cette route est « solder ce
 * rendez-vous », et le montant est celui que le serveur a composé. Le règlement
 * partiel et la monnaie rendue vivent sur `POST /sales/{saleId}/payments`, qui
 * rend l'enveloppe où l'un et l'autre se lisent — celle-ci rend la ligne
 * d'encaissement, comme depuis #62.
 */
export function toCashSettlementRequest(_dto: CreateCashPaymentDto): SettlementRequest {
  return { method: 'CASH' };
}

/** Les lignes ajoutées au ticket d'un rendez-vous, ou aucune. */
export function toExtraLines(dto: CreateCashPaymentDto): readonly SaleLineRequest[] {
  return dto.lines === undefined ? [] : toSaleLineRequests(dto.lines);
}

type AssertNever<T extends never> = T;

/**
 * Le corps de règlement annonce **exactement** les clés que le contrat décrit —
 * #1026.
 *
 * Pris dans les deux sens, parce qu'une entrée n'a pas d'excédent légitime : le
 * `.strict()` du contrat et le `forbidNonWhitelisted` du `ValidationPipe`
 * décrivent la même liste blanche, et un champ ajouté ici sans l'être là-bas
 * serait un champ **documenté comme acceptable** sur le chemin de l'argent. En
 * sens inverse, un champ que le contrat déclare et que la route refuse est ce que
 * #1026 a trouvé : `method: 'CARD'` et pas de `terminalReference`, c'est-à-dire un
 * contrat qui ne savait construire qu'un 400.
 */
type SettleSaleWire = z.input<typeof settleSaleRequestSchema>;

type _SettleSaleDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof SettleSaleDto, keyof SettleSaleWire>
  | Exclude<keyof SettleSaleWire, keyof SettleSaleDto>
>;

/**
 * La réponse du comptoir annonce **exactement** les clés du contrat — #1026.
 *
 * Les deux sens ici aussi, et c'est le `replayed` manquant qui le justifie : le
 * contrat était `.strict()` sans lui, si bien qu'un `.parse()` de cette réponse
 * levait `unrecognized_keys` et fermait l'écran de caisse pour un champ qu'il ne
 * lit pas. La garde casse désormais la compilation au lieu de laisser l'écart
 * atteindre le front.
 *
 * Elle ne compare que les **clés**. La lisibilité champ à champ resterait fausse
 * sur `payment.method` et `payment.status`, que ce module écrit en majuscules et
 * que le contrat ramène en minuscules à la réception — la normalisation appartient
 * au schéma partagé, pas à cette classe.
 */
type SaleSettlementWire = z.input<typeof saleSettlementSchema>;

type _SaleSettlementDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof SaleSettlementDto, keyof SaleSettlementWire>
  | Exclude<keyof SaleSettlementWire, keyof SaleSettlementDto>
>;

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
    replayed: settlement.replayed,
  };
}
