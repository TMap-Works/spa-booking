/**
 * Les deux réponses d'encaissement que le back-office lit, rejouées contre un
 * schéma (#59).
 *
 * ## Pourquoi elles ne viennent pas de `@spa/shared`
 *
 * Le contrat partagé publie bien `paymentIntentSchema` et `paymentSchema`, mais
 * ni l'un ni l'autre ne décrit ce que l'API **sert aujourd'hui** :
 *
 * | Contrat partagé | Ce que l'API rend | Écart |
 * |---|---|---|
 * | `paymentIntentSchema` — `.strict()`, trois champs | `PaymentIntentDto` — six champs, dont `publishableKey` | le `.strict()` rejetterait la réponse entière |
 * | `paymentSchema` — `capturedAt` optionnel | `PaymentTransactionDto` — `capturedAt: null` | « absent » et « nul » ne sont pas la même chose pour Zod |
 *
 * Les DTO d'`apps/api` portent tous le même `TODO(#26)` : ils rejoindront
 * `packages/shared` le jour où l'API dépendra du paquet, et les deux formes se
 * rejoindront alors. D'ici là, corriger le contrat partagé pour un écran
 * reviendrait à changer une source de vérité que trois autres branches lisent —
 * pour un module que #26 supprimera. Les schémas vivent donc ici, **composés des
 * primitives du contrat** (`nonNegativeMoneySchema`, `uuidSchema`,
 * `utcInstantSchema`, les deux énumérations de paiement) : rien du vocabulaire
 * n'est redéclaré, seule l'enveloppe l'est.
 *
 * ## La frontière PCI, dans la forme même de ces schémas
 *
 * Aucun champ ci-dessous ne peut porter une donnée de carte : ni PAN, ni
 * cryptogramme, ni date d'expiration, ni nom de porteur — et pas davantage une
 * marque ou quatre derniers chiffres. Un objet Zod **retire** les clés qu'il ne
 * déclare pas : si l'API se mettait un jour à en émettre une, elle n'atteindrait
 * ni un composant, ni un journal du front (payments-stripe §1). C'est la même
 * propriété de forme que celle des DTO d'entrée côté serveur, appliquée au sens
 * de la lecture.
 *
 * Les deux références de prestataire (`providerPaymentIntentId`,
 * `providerChargeId`) sont, elles, volontairement **non déclarées** : elles
 * servent le rapprochement, qui est l'écran du journal des transactions, au
 * seuil `MANAGER`. Le comptoir encaisse ; il n'a pas à porter la référence
 * Stripe d'une vente sur son écran ni sur son ticket.
 */

import {
  nonNegativeMoneySchema,
  opaqueTokenSchema,
  paymentMethodSchema,
  paymentStatusSchema,
  utcInstantSchema,
  uuidSchema,
} from '@spa/shared';
import { z } from 'zod';

/**
 * Moyen de paiement **tel qu'il arrive du fil** — l'API émet `CASH`, le contrat
 * nomme `cash`.
 *
 * Même normalisation, et pour la même raison, que
 * `receivedAppointmentStatusSchema` du contrat partagé : la conversion se fait
 * une fois, à la frontière, et au-delà aucun composant n'a à se demander dans
 * quelle casse il compare un moyen de paiement.
 */
export const receivedPaymentMethodSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(paymentMethodSchema);

/** Statut d'encaissement reçu du fil (`SUCCEEDED`), même normalisation. */
export const receivedPaymentStatusSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(paymentStatusSchema);

/**
 * L'intention de paiement d'un rendez-vous — de quoi monter Stripe Elements.
 *
 * Les deux valeurs sensibles en apparence ne le sont pas :
 *
 * - `clientSecret` est un laissez-passer à usage unique qui n'autorise que la
 *   confirmation de **cette** intention. Il n'ouvre aucune autre ressource, et
 *   il n'est pas conservé — une reprise le redemande à sa source ;
 * - `publishableKey` est publiable par définition (payments-stripe §7). La clé
 *   **secrète** ne quitte jamais le serveur d'API.
 *
 * C'est ce qui permet à ces deux champs de traverser la frontière serveur vers
 * le navigateur, là où un jeton de session ne le pourrait pas.
 */
export const appointmentPaymentIntentSchema = z.object({
  paymentId: uuidSchema,
  appointmentId: uuidSchema,
  amount: nonNegativeMoneySchema,
  status: receivedPaymentStatusSchema,
  clientSecret: opaqueTokenSchema,
  publishableKey: opaqueTokenSchema,
});

export type AppointmentPaymentIntent = z.infer<typeof appointmentPaymentIntentSchema>;

/**
 * Un encaissement inscrit, tel que le comptoir le relit après un règlement en
 * espèces.
 *
 * `capturedAt` est `nullable` et non `optional` : l'API émet explicitement
 * `null` tant que l'argent n'a pas été pris. Sur un règlement en espèces il est
 * toujours renseigné — la caisse fait foi, l'encaissement naît abouti — mais le
 * schéma décrit la route, pas le seul cas qu'on en attend.
 */
export const paymentTransactionSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.nullable(),
  amount: nonNegativeMoneySchema,
  refunded: nonNegativeMoneySchema,
  method: receivedPaymentMethodSchema,
  status: receivedPaymentStatusSchema,
  capturedAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
});

export type PaymentTransaction = z.infer<typeof paymentTransactionSchema>;
