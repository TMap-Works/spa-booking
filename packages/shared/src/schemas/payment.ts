/**
 * Encaissement — en ligne ou au comptoir, carte ou espèces.
 *
 * **Frontière PCI, et c'est la raison d'être de ce fichier autant que ses
 * types** : aucun champ ci-dessous ne peut transporter une donnée de carte. Ni
 * PAN, ni cryptogramme, ni date d'expiration, ni nom du porteur. La tokenisation
 * se fait côté client vers Stripe ; le serveur ne voit que des références
 * opaques (`pi_…`, `pm_…`) et le périmètre reste en SAQ A.
 *
 * Le contrat est le bon endroit pour l'écrire : un champ ajouté ici serait
 * accepté par le `ValidationPipe` du back et sérialisé par le front sans que
 * personne n'ait à décider quoi que ce soit. Le `.strict()` de chaque schéma
 * d'entrée refuse ce qu'il ne connaît pas — un `cardNumber` glissé dans un corps
 * de requête sort en 422 plutôt que d'atterrir dans un log.
 */

import { z } from 'zod';

import { opaqueTokenSchema, reasonSchema, uuidSchema } from '../common/identifiers';
import {
  currencyCodeSchema,
  nonNegativeMoneySchema,
  positiveMoneySchema,
} from '../common/money';
import { utcInstantSchema } from '../common/time';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../constants/payment';

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);

/**
 * Encaissement tel que l'API le renvoie.
 *
 * `amount` et `refunded` sont deux `Money` complets et non deux entiers
 * partageant une devise implicite : le rapprochement additionne des montants,
 * et un entier sans devise est exactement ce qui permet d'additionner des euros
 * à des dollars sans que rien ne proteste.
 *
 * `appointmentId` et `capturedAt` sont `nullable` et non `optional` : l'API émet
 * explicitement `null` sur une vente retail sans rendez-vous et tant que
 * l'argent n'a pas été pris. « Absent » et « nul » ne sont pas la même chose
 * pour Zod, et c'est le second des deux écarts que #554 a tranchés — le contrat
 * suit ce que `PaymentTransactionDto` sert, plutôt que l'inverse.
 *
 * `refunded` porte le nom de la clé du fil, celui de `PaymentTransactionDto` :
 * décrire la même réponse sous deux noms était exactement ce qui obligeait le
 * back-office à redéclarer l'enveloppe au lieu de lire celle-ci.
 */
export const paymentSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.nullable(),
  amount: nonNegativeMoneySchema,
  refunded: nonNegativeMoneySchema,
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  capturedAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
});

export type Payment = z.infer<typeof paymentSchema>;

/**
 * Ouvre un paiement en ligne pour un rendez-vous.
 *
 * Le corps ne porte **pas** de montant : il est relu du rendez-vous côté
 * serveur. Laisser le client l'annoncer, c'est le laisser payer le prix qu'il
 * choisit — la validation « le montant envoyé égale le montant dû » n'ajoute
 * rien qu'une relecture serveur ne fasse déjà, et elle ouvre un écart dès que
 * les deux sources divergent.
 */
export const createPaymentIntentRequestSchema = z
  .object({
    appointmentId: uuidSchema,
  })
  .strict();

export type CreatePaymentIntentRequest = z.infer<typeof createPaymentIntentRequestSchema>;

/**
 * Ce que le front reçoit pour finir le paiement dans l'élément Stripe.
 *
 * `clientSecret` est un jeton opaque à usage unique, lié à une intention. Il
 * n'est **pas** un secret d'API : il ne permet que de confirmer ce paiement-là.
 * Le contrat le type comme opaque pour que personne ne soit tenté d'y lire
 * quelque chose. `publishableKey` est publiable par définition
 * (payments-stripe §7) : c'est elle qui évite de graver la clé Stripe du salon
 * dans le build du front. La clé **secrète** ne quitte jamais le serveur.
 *
 * ## Les six clés, et pourquoi elles sont six
 *
 * Ce schéma n'en portait que trois — `paymentId`, `clientSecret`, `amount` —, et
 * son `.strict()` aurait donc rejeté la réponse entière de
 * `POST /appointments/:id/payment-intent`, qui en sert six. C'est le premier des
 * deux écarts que #510 avait instruits sans pouvoir les refermer, et #554 l'a
 * tranché dans ce sens-ci : **le contrat suit la réponse**. Retirer
 * `appointmentId`, `status` et `publishableKey` de l'API aurait cassé le tunnel
 * de paiement, alors que les décrire ici ne coûte que cette déclaration — et
 * rend au back-office comme au module `payments` une enveloppe qu'ils
 * redéclaraient chacun de leur côté.
 *
 * `status` est nommé dans le vocabulaire **du contrat**, en minuscules. L'API
 * sert la casse de l'énumération PostgreSQL (`PENDING`) ; la conversion se fait
 * une fois, à la frontière du client d'API, par `receivedPaymentStatusSchema`.
 * C'est la même discipline que pour le statut d'un rendez-vous, et elle est
 * délibérée : un seul endroit sait dans quelle casse la valeur est arrivée.
 */
export const paymentIntentSchema = z
  .object({
    paymentId: uuidSchema,
    appointmentId: uuidSchema,
    amount: positiveMoneySchema,
    status: paymentStatusSchema,
    clientSecret: opaqueTokenSchema,
    publishableKey: opaqueTokenSchema,
  })
  .strict();

export type PaymentIntent = z.infer<typeof paymentIntentSchema>;

/**
 * Encaissement au comptoir (POS).
 *
 * `amount` est ici une entrée légitime, contrairement au paiement en ligne : une
 * vente retail sans rendez-vous n'a aucun montant à relire ailleurs. Le champ
 * est un `Money` strictement positif — encaisser zéro n'est pas une opération.
 *
 * Aucune référence de carte n'entre : un règlement carte au comptoir passe par
 * le terminal du salon, dont on ne conserve que l'issue.
 */
export const recordCounterPaymentRequestSchema = z
  .object({
    appointmentId: uuidSchema.optional(),
    amount: positiveMoneySchema,
    method: paymentMethodSchema,
  })
  .strict();

export type RecordCounterPaymentRequest = z.infer<typeof recordCounterPaymentRequestSchema>;

/**
 * Remboursement total ou partiel.
 *
 * `amount` omis vaut « tout ce qui reste encaissé ». Le plafonnement se fait
 * côté serveur — un remboursement supérieur au restant sort en
 * `REFUND_EXCEEDS_CAPTURED`, jamais en conversion silencieuse.
 *
 * **La devise déclarée ici n'est pas encore celle que la route reçoit.** Ce
 * schéma décrit un couple `{ amountMinor, currency }` là où
 * `POST /payments/:id/refunds` porte un `amountMinor` nu et relit la devise de
 * l'encaissement en base : elle n'est pas au choix de l'appelant, et l'API
 * n'émet aucun refus pour une devise contredite — il n'y en a pas à contredire.
 * L'écart est instruit, avec la décision qui reste à prendre, en tête de
 * `apps/api/src/modules/payments/dto/refund.dto.ts` : poster le couple tel quel
 * se fait aujourd'hui refuser en 400 par le `whitelist` du `ValidationPipe`.
 */
export const refundPaymentRequestSchema = z
  .object({
    amount: positiveMoneySchema.optional(),
    reason: reasonSchema.optional(),
  })
  .strict();

export type RefundPaymentRequest = z.infer<typeof refundPaymentRequestSchema>;

/**
 * Filtres du journal des encaissements du back-office.
 *
 * `currency` sert au rapprochement : un établissement qui encaisse en deux
 * devises n'additionne pas ses deux journaux.
 */
export const paymentListQuerySchema = z
  .object({
    appointmentId: uuidSchema.optional(),
    statuses: z.array(paymentStatusSchema).nonempty().optional(),
    method: paymentMethodSchema.optional(),
    currency: currencyCodeSchema.optional(),
  })
  .strict();

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
