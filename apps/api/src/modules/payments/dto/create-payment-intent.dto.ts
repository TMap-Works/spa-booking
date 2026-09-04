import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import type { Money, PaymentIntentView, PaymentStatus } from '../payments.types';

/**
 * Le corps de la création d'intention — **un identifiant, et rien d'autre**.
 *
 * Ce DTO est un dispositif de conformité autant qu'un contrat. `ValidationPipe`
 * est global avec `whitelist` **et** `forbidNonWhitelisted` : un champ non
 * déclaré ici ne passe pas, il fait rejeter la requête en 400. Ce que ce corps
 * ne porte pas est donc structurellement impossible à envoyer, et c'est là que
 * se joue la frontière PCI (payments-stripe §1) :
 *
 * - **aucun champ de carte** — ni numéro, ni cryptogramme, ni date
 *   d'expiration, ni nom de porteur. Un PAN glissé dans ce corps est refusé par
 *   le pipe avant d'atteindre la moindre ligne de code métier, et n'atteint
 *   donc ni nos journaux ni notre base. C'est le quatrième critère de #57 ;
 * - **aucun `amount`.** Le montant est le prix figé à la réservation, relu en
 *   base. Le laisser entrer ici aurait laissé n'importe qui payer un massage un
 *   centime (payments-stripe §4) ;
 * - **aucune `currency`.** Elle accompagne le prix, en base, et n'est pas au
 *   choix de l'appelant ;
 * - **aucun `tenantId`.** Il vient du slug d'URL résolu par le middleware, et
 *   de nulle part ailleurs (tenant-isolation §2).
 *
 * TODO(#26) : cette forme appartient au contrat d'API et devra venir de
 * `@spa/shared` le jour où `apps/api` dépendra du paquet — même TODO que dans
 * les DTO d'`appointments`.
 */
export class CreatePaymentIntentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Le rendez-vous à payer, tel que l’écran de confirmation l’a rendu. C’est ' +
      'la connaissance de cet identifiant — un UUID v4 — qui autorise l’appel, ' +
      'exactement comme pour le report et l’annulation du même tunnel.',
    example: '3f1b1f6e-0a2b-4c3d-8e4f-5a6b7c8d9e0f',
  })
  // `IsUUID` et non un simple `IsString` : un identifiant mal formé est un 400
  // qui nomme le champ, jamais une requête qui descend jusqu'au pilote
  // PostgreSQL pour en revenir en 500.
  @IsUUID('4')
  public appointmentId!: string;
}

/** Un montant, tel que toute l'API le rend. */
export class MoneyDto implements Money {
  @ApiProperty({
    description:
      'Entier, dans la plus petite unité de la devise — jamais un flottant. ' +
      'Pour une devise sans sous-unité (JPY, MGA), c’est l’unité principale.',
    example: 7000,
  })
  public amountMinor!: number;

  @ApiProperty({ description: 'Code ISO 4217.', example: 'EUR' })
  public currency!: string;
}

/**
 * L'intention de paiement rendue au navigateur.
 *
 * ## Les deux valeurs qui sortent du serveur, et pourquoi elles peuvent
 *
 * `clientSecret` est un laissez-passer à usage unique, lié à cette intention,
 * qui n'autorise rien d'autre que la confirmer — c'est le mécanisme même de
 * Stripe Elements. `publishableKey` est publiable par définition
 * (payments-stripe §7).
 *
 * La clé **secrète** n'apparaît dans aucune réponse de l'API : elle vit dans
 * AWS Secrets Manager, atteint le conteneur par sa définition de tâche ECS, et
 * ne quitte `StripeConfig` que pour l'en-tête `Authorization` de la passerelle.
 * C'est le troisième critère de #57.
 *
 * ## Ce que ce corps ne porte pas
 *
 * Ni `tenantId`, ni marque de carte, ni quatre derniers chiffres : au moment où
 * cette réponse part, aucune carte n'a été saisie — et quand elle le sera, ce
 * sera dans une iframe servie par Stripe, que notre DOM ne lit pas.
 */
export class PaymentIntentDto implements PaymentIntentView {
  @ApiProperty({
    format: 'uuid',
    description: 'Notre ligne d’encaissement — l’identifiant Stripe n’est pas rendu.',
  })
  public paymentId!: string;

  @ApiProperty({ format: 'uuid' })
  public appointmentId!: string;

  @ApiProperty({ type: MoneyDto, description: 'Le prix figé à la réservation, relu en base.' })
  public amount!: MoneyDto;

  @ApiProperty({
    description:
      '`PENDING` tant que Stripe n’a pas confirmé. Le passage à `SUCCEEDED` est ' +
      'l’affaire du webhook signé (#58) : le navigateur n’a jamais autorité pour ' +
      'déclarer un paiement abouti.',
    example: 'PENDING',
  })
  public status!: PaymentStatus;

  @ApiProperty({
    description:
      'Laissez-passer à usage unique, à remettre à Stripe Elements. Il n’est pas ' +
      'conservé en base : une reprise le redemande à sa source.',
    example: 'pi_3ABC…_secret_XYZ…',
  })
  public clientSecret!: string;

  @ApiProperty({
    description:
      'La clé publiable du salon, rendue par l’API plutôt que gravée dans le ' +
      'build du front : changer de compte Stripe ne demande alors aucun ' +
      'redéploiement.',
    example: 'pk_test_51ABC…',
  })
  public publishableKey!: string;
}
