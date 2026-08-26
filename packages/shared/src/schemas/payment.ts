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
 * `amount` et `refundedAmount` sont deux `Money` complets et non deux entiers
 * partageant une devise implicite : le rapprochement additionne des montants,
 * et un entier sans devise est exactement ce qui permet d'additionner des euros
 * à des dollars sans que rien ne proteste.
 *
 * `appointmentId` est absent d'une vente au comptoir sans rendez-vous — d'où
 * l'optionalité, qui suit la colonne nullable correspondante.
 */
export const paymentSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.optional(),
  amount: nonNegativeMoneySchema,
  refundedAmount: nonNegativeMoneySchema,
  method: paymentMethodSchema,
  status: paymentStatusSchema,
  capturedAt: utcInstantSchema.optional(),
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
 * quelque chose.
 */
export const paymentIntentSchema = z
  .object({
    paymentId: uuidSchema,
    clientSecret: opaqueTokenSchema,
    amount: positiveMoneySchema,
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
 * `REFUND_EXCEEDS_CAPTURED_AMOUNT`, et une devise différente de celle de
 * l'encaissement en `CURRENCY_MISMATCH`, jamais en conversion silencieuse.
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
