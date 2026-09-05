import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../payments.types';
import type { PaymentHistoryFilter, PaymentTransaction } from '../payments.types';
import { MoneyDto, toMoneyDto } from './sale.dto';
import { IsOffsetDateTime, PageQueryDto, toPageBounds, toWindowBound } from './validation';

/**
 * DTO du règlement en espèces et de l'historique des transactions — #62.
 *
 * ## Le champ qui n'existe pas, et celui qui n'existe pas non plus
 *
 * `CreateCashPaymentDto` ne porte **ni montant, ni devise** : le prix est celui
 * figé à la réservation, relu en base. Ce n'est pas une omission qu'un contrôle
 * rattrape ensuite — il n'y a nulle part où l'envoyer, et le `ValidationPipe`
 * global (`whitelist` + `forbidNonWhitelisted`) refuse en 400, en le nommant,
 * tout champ qu'on y glisserait. Même propriété de forme que le ticket de #60,
 * appliquée au règlement.
 *
 * Il ne porte **pas non plus d'opérateur** : l'identité de la personne qui
 * encaisse vient de `@CurrentUser()`, donc d'un jeton vérifié. L'accepter du
 * corps aurait laissé n'importe quel poste encaisser sous le nom d'un autre —
 * exactement ce que la traçabilité de payments-stripe §4 cherche à établir.
 *
 * Ni `tenantId` : l'établissement vient de la revendication signée
 * (tenant-isolation §2).
 *
 * TODO(#26) : ces formes rejoindront `@spa/shared` avec le reste du contrat.
 */
export class CreateCashPaymentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Le rendez-vous réglé. **Seul champ du corps** : le montant est celui figé ' +
      'à la réservation, l’opérateur vient du jeton, l’établissement de la ' +
      'revendication signée.',
  })
  @IsUUID('4', { message: 'appointmentId : identifiant de rendez-vous attendu' })
  public appointmentId!: string;
}

/**
 * Une transaction, telle que l'API la rend — la ligne de rapprochement.
 *
 * `tenantId` n'y figure pas : information interne qui n'apporte rien au
 * consommateur et invite aux essais (tenant-isolation §4). Aucune donnée de
 * carte non plus — ni marque, ni quatre derniers chiffres : le domaine n'en a
 * pas la notion, donc cette vue n'a pas de champ où en ranger une
 * (payments-stripe §1).
 */
export class PaymentTransactionDto {
  @ApiProperty({ format: 'uuid', description: 'Notre identifiant de ligne — pas celui de Stripe.' })
  public id!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: '`null` pour une vente retail sans rendez-vous.',
  })
  public appointmentId!: string | null;

  @ApiProperty({ type: MoneyDto })
  public amount!: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description:
      'Cumul remboursé, dans la devise de l’encaissement. `0` tant que rien ne ' +
      'l’a été — une ligne remboursée reste au relevé, et un total qui l’ignore ' +
      'ne tombe jamais juste.',
  })
  public refunded!: MoneyDto;

  @ApiProperty({
    enum: PAYMENT_METHODS,
    description: '`CASH` n’a jamais appelé Stripe ; `CARD` s’y retrouve.',
  })
  public method!: PaymentTransaction['method'];

  @ApiProperty({ enum: PAYMENT_STATUSES })
  public status!: PaymentTransaction['status'];

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Référence d’intention Stripe — celle du tableau de bord. **`null` sur ' +
      'une vente en espèces**, par construction : aucun appel n’a eu lieu pour ' +
      'en produire une.',
  })
  public providerPaymentIntentId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Référence de charge Stripe — celle qui figure sur le relevé de virement. ' +
      'C’est par elle que le rapprochement se fait, ligne à ligne.',
  })
  public providerChargeId!: string | null;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Instant UTC où l’argent a été pris — celui qui décide du jour de caisse. ' +
      '`null` tant que l’encaissement n’a pas abouti.',
  })
  public capturedAt!: string | null;

  @ApiProperty({ format: 'date-time', description: 'Instant UTC d’ouverture de l’encaissement.' })
  public createdAt!: string;
}

/** Une page de transactions, avec de quoi afficher un sélecteur de page. */
export class PaymentTransactionPageDto {
  @ApiProperty({ type: [PaymentTransactionDto] })
  public items!: PaymentTransactionDto[];

  @ApiProperty({ minimum: 1, example: 1 })
  public page!: number;

  @ApiProperty({ minimum: 1 })
  public pageSize!: number;

  @ApiProperty({ minimum: 0, description: 'Nombre total de transactions correspondant au filtre.' })
  public totalItems!: number;

  @ApiProperty({
    minimum: 0,
    description: '`0` sur un ensemble vide — « page 1 sur 0 » et non « page 1 sur 1 ».',
  })
  public totalPages!: number;
}

/**
 * Filtre de l'historique des transactions — `GET /payments`.
 *
 * Les quatre critères sont facultatifs : un comptoir qui ouvre l'écran veut les
 * dernières transactions, pas une fenêtre à saisir avant de voir quoi que ce
 * soit. `from` est **inclus**, `to` **exclu** — c'est ce qui permet de poser deux
 * journées de caisse bout à bout sans compter deux fois l'encaissement de
 * minuit.
 *
 * Une fenêtre à l'envers est refusée en 422 par le service, et non ignorée :
 * « aucune transaction ce jour-là » et « la fenêtre est à l'envers » appellent
 * deux conduites différentes.
 */
export class ListPaymentsQueryDto extends PageQueryDto {
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
    enum: PAYMENT_METHODS,
    description:
      '`CARD` isole ce qui doit se retrouver sur un relevé Stripe, `CASH` ce ' +
      'dont la caisse fait foi.',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHODS, { message: `method : une valeur parmi ${PAYMENT_METHODS.join(', ')}` })
  public method?: PaymentTransaction['method'];

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES, { message: `status : une valeur parmi ${PAYMENT_STATUSES.join(', ')}` })
  public status?: PaymentTransaction['status'];
}

/**
 * Le DTO ramené à ce que le domaine connaît, valeurs par défaut appliquées.
 *
 * Les critères absents ne sont **pas** recopiés en `undefined` :
 * `exactOptionalPropertyTypes` distingue « absent » de « présent et indéfini »,
 * et un `method: undefined` porté jusqu'au `where` de Prisma s'y lirait comme un
 * filtre à composer plutôt que comme l'absence de filtre.
 */
export function toPaymentHistoryFilter(dto: ListPaymentsQueryDto): PaymentHistoryFilter {
  const from = toWindowBound(dto.from);
  const to = toWindowBound(dto.to);

  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(dto.method === undefined ? {} : { method: dto.method }),
    ...(dto.status === undefined ? {} : { status: dto.status }),
    ...toPageBounds(dto),
  };
}

/** La transaction telle qu'elle franchit la frontière HTTP — les instants en UTC. */
export function toPaymentTransactionDto(
  transaction: PaymentTransaction,
): PaymentTransactionDto {
  return {
    id: transaction.id,
    appointmentId: transaction.appointmentId,
    amount: toMoneyDto(transaction.amount),
    refunded: toMoneyDto(transaction.refunded),
    method: transaction.method,
    status: transaction.status,
    providerPaymentIntentId: transaction.providerPaymentIntentId,
    providerChargeId: transaction.providerChargeId,
    // `…Z` et rien d'autre : un seul référentiel, deux horodatages se comparent
    // alors par simple ordre lexicographique (ADR 0006).
    capturedAt: transaction.capturedAt === null ? null : transaction.capturedAt.toISOString(),
    createdAt: transaction.createdAt.toISOString(),
  };
}
