import { ApiProperty } from '@nestjs/swagger';
import {
  type CreatePaymentIntentRequest,
  createPaymentIntentRequestSchema,
  moneySchema,
  paymentIntentSchema,
} from '@spa/shared';
import type { z } from 'zod';

import { ZodValidationPipe } from '../../../common/validation';
import type { Money, PaymentIntentView, PaymentStatus } from '../payments.types';

/**
 * L'ouverture d'un paiement en ligne (#57), **validée par le contrat partagé**
 * (#510).
 *
 * ## Ce que ce fichier est devenu, et ce qu'il n'est plus
 *
 * Il ne décrit plus la frontière d'entrée : il la **documente**. La demande
 * d'intention appartient au contrat d'API, et `packages/shared` la décrit —
 * appariée ici une fois pour toutes :
 *
 * | Ce fichier | `packages/shared/src/schemas/payment.ts` |
 * |---|---|
 * | `createPaymentIntentBody` (le pipe) | `createPaymentIntentRequestSchema` |
 * | `CreatePaymentIntentDto` (la documentation) | idem, côté OpenAPI |
 *
 * La classe survit parce que le schéma OpenAPI de `/api/docs` sort des
 * décorateurs `@nestjs/swagger`, que Zod ne porte pas : la supprimer
 * supprimerait la documentation de la route. Elle a en revanche perdu **tous**
 * ses décorateurs `class-validator` — c'est la décision de
 * [l'ADR 0008](../../../../../../docs/adr/0008-validation-zod-classe-dto-documentaire.md),
 * et la conséquence à connaître avant de toucher à ce fichier : **typer un
 * paramètre de handler par cette classe viderait le corps de la requête**, le
 * `ValidationPipe` global appliquant `whitelist` à une classe qui n'a plus rien
 * à mettre sur sa liste blanche. Le handler prend le type inféré du schéma, et
 * déclare la classe par `@ApiBody`.
 *
 * La substitution ne change **aucun** comportement de la route :
 * `createPaymentIntentRequestSchema` valide `appointmentId` avec `uuidSchema`,
 * resserré sur la v4 par #404, c'est-à-dire exactement ce qu'exigeait
 * `@IsUUID('4')`.
 *
 * ## Le `.strict()` du contrat remplace `forbidNonWhitelisted`, et c'est ici un
 * dispositif de conformité
 *
 * Ce corps est un dispositif PCI autant qu'un contrat. Ce qu'il ne porte pas est
 * structurellement impossible à envoyer, et c'est là que se joue la frontière
 * (payments-stripe §1) :
 *
 * - **aucun champ de carte** — ni numéro, ni cryptogramme, ni date
 *   d'expiration, ni nom de porteur. Un PAN glissé dans ce corps est refusé
 *   avant d'atteindre la moindre ligne de code métier, et n'atteint donc ni nos
 *   journaux ni notre base. C'est le quatrième critère de #57 ;
 * - **aucun `amount`.** Le montant est le prix figé à la réservation, relu en
 *   base. Le laisser entrer ici aurait laissé n'importe qui payer un massage un
 *   centime (payments-stripe §4) ;
 * - **aucune `currency`.** Elle accompagne le prix, en base, et n'est pas au
 *   choix de l'appelant ;
 * - **aucun `tenantId`.** Il vient du slug d'URL résolu par le middleware, et
 *   de nulle part ailleurs (tenant-isolation §2).
 *
 * Le refus vient désormais du `.strict()` du schéma plutôt que du
 * `forbidNonWhitelisted` du pipe global. Les deux rendent le même 400 et le même
 * corps `VALIDATION_ERROR` : `ZodValidationPipe` refuse d'ailleurs au montage un
 * schéma d'entrée qui ne serait pas `.strict()`, si bien que la propriété est
 * vérifiée à l'amorçage de l'application et non à la première requête d'un
 * appelant qui aurait deviné le nom d'un champ.
 */

/**
 * Le pipe de la demande d'intention — c'est **lui** qui valide, et non la classe
 * ci-dessous.
 *
 * Instancié une fois au chargement du module plutôt qu'à chaque décoration : le
 * schéma ne change pas d'une requête à l'autre, et la garde `.strict()` du pipe
 * se paie ainsi une seule fois, à l'amorçage.
 */
export const createPaymentIntentBody = new ZodValidationPipe(createPaymentIntentRequestSchema);

/** La demande d'intention, telle que le contrat la rend au contrôleur. */
export type CreatePaymentIntentBody = CreatePaymentIntentRequest;

/**
 * Le corps de la création d'intention — **un identifiant, et rien d'autre**.
 *
 * La documentation de `createPaymentIntentRequestSchema`, et rien de plus : la
 * règle appliquée à la requête est écrite là-bas, une seule fois.
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
 *
 * ## Ce qui tient cette sortie, et ce qui ne peut pas la tenir
 *
 * Le patron de l'ADR 0008 garde une sortie par deux assertions contre
 * `z.input<…>` du schéma correspondant. Il n'y avait longtemps pas de
 * correspondance à garder : `paymentIntentSchema` ne portait que `paymentId`,
 * `clientSecret` et `amount`, là où cette classe sert en plus `appointmentId`,
 * `status` et `publishableKey`, et un **jeu de clés** différent des deux côtés
 * empêchait même la première des deux assertions de compiler.
 *
 * #554 a tranché en faveur de la réponse — le contrat porte les six clés — et
 * l'assertion de jeu de clés est donc revenue, en fin de fichier. La **seconde**
 * assertion, celle de lisibilité (`Dto extends Wire`), reste hors de portée et
 * le restera : le contrat nomme le statut en minuscules (`pending`) quand ce
 * module porte la casse de l'énumération PostgreSQL (`PENDING`). Cet écart-là
 * est délibéré et se referme à la frontière du client d'API, jamais ici.
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

// ---------------------------------------------------------------------------
// Les formes tenues par le contrat — à la compilation, faute de pouvoir l'être
// à l'exécution
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;

/**
 * La classe qui documente `/api/docs` doit annoncer **exactement** les champs
 * que le pipe accepte.
 *
 * Sans cette garde, la substitution aurait déplacé le risque plutôt que de le
 * supprimer — la validation n'a plus qu'une écriture, mais la documentation en
 * garde une seconde, et une `@ApiProperty` oubliée décrirait une route qui
 * refuse ce qu'elle annonce. Sur cette route-ci, elle porte davantage : un champ
 * ajouté à la classe sans l'être au contrat serait un champ **documenté comme
 * acceptable** sur le seul corps de requête du tunnel de paiement.
 */
type _CreatePaymentIntentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof CreatePaymentIntentDto, keyof z.input<typeof createPaymentIntentRequestSchema>>
  | Exclude<keyof z.input<typeof createPaymentIntentRequestSchema>, keyof CreatePaymentIntentDto>
>;

/**
 * Le montant servi est celui du contrat — jeu de clés, puis champ par champ.
 *
 * `moneySchema` est la seule écriture de l'argent dans le contrat, et
 * `CLAUDE.md` en fait une règle non négociable : entier dans la plus petite
 * unité, code devise explicite, jamais de flottant. Un `amount` de type `number`
 * ajouté à côté d'`amountMinor`, ou une `currency` devenue facultative,
 * casseraient ici la compilation plutôt que d'atteindre un rapprochement
 * bancaire.
 */
type MoneyWire = z.input<typeof moneySchema>;

type _MoneyDtoHasTheContractKeys = AssertNever<
  Exclude<keyof MoneyDto, keyof MoneyWire> | Exclude<keyof MoneyWire, keyof MoneyDto>
>;

type _MoneyDtoIsReadableByTheContract = AssertTrue<MoneyDto extends MoneyWire ? true : false>;

/**
 * La réponse du tunnel annonce **exactement** les clés que le contrat décrit.
 *
 * C'est l'assertion que l'en-tête disait manquante, et elle a un sens précis
 * depuis #554 : `paymentIntentSchema` porte les six champs que cette classe
 * sert, si bien qu'un champ ajouté d'un seul côté casse la compilation au lieu
 * d'atteindre le front. Un champ retiré du contrat sans l'être ici la casse
 * aussi — c'est la même garde, prise dans les deux sens.
 *
 * Elle ne compare que les **clés**. La lisibilité champ à champ resterait fausse
 * sur `status`, que ce module écrit en majuscules et que le contrat nomme en
 * minuscules : la normalisation appartient au client d'API
 * (`receivedPaymentStatusSchema`), pas à cette classe.
 */
type PaymentIntentWire = z.input<typeof paymentIntentSchema>;

type _PaymentIntentDtoHasTheContractKeys = AssertNever<
  | Exclude<keyof PaymentIntentDto, keyof PaymentIntentWire>
  | Exclude<keyof PaymentIntentWire, keyof PaymentIntentDto>
>;
