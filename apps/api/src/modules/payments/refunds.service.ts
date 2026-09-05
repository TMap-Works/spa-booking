import { Inject, Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  PaymentNotRefundableError,
  PaymentProviderRefusedError,
  RefundExceedsCapturedError,
} from './payments.errors';
import type { RefundRecord, RefundablePayment } from './payments.types';
import { RefundsRepository, type RefundAmountRequest } from './refunds.repository';
import { STRIPE_GATEWAY, type StripeGateway, type StripeRefund } from './stripe/stripe.gateway';

/**
 * Le remboursement au comptoir — #63, CDC §4.9 et payments-stripe §6.
 *
 * ## Les quatre invariants qu'il tient
 *
 * 1. **Le remboursement passe par l'API du prestataire**, total ou partiel. Le
 *    « total » n'est pas un mode à part : c'est le solde restant, calculé côté
 *    serveur et envoyé explicitement.
 * 2. **Le cumul ne dépasse jamais le montant capturé.** Vérifié côté serveur, et
 *    pas seulement lu : la vérification et la réservation du montant sont dans
 *    une transaction sérialisable, sans quoi deux comptoirs simultanés
 *    passeraient tous deux le contrôle. Voir `refunds.repository.ts`.
 * 3. **Chaque geste laisse sa trace** — qui, quand, pourquoi. Le « qui » vient
 *    du jeton vérifié, le « quand » de la base, le « pourquoi » du corps ; c'est
 *    la seule valeur que l'appelant fournisse en propre, avec le montant.
 * 4. **Ce service n'écrit pas le statut de l'encaissement.** Ni `status`, ni
 *    `refunded_amount_minor` : ils sont l'affaire du webhook `charge.refunded`,
 *    et de lui seul (payments-stripe §6). Ce que ce service écrit est le
 *    *journal de l'ordre donné*, pas son effet.
 *
 * ## L'ordre des trois temps, et pourquoi il n'est pas négociable
 *
 * ```
 * 1. réserver   — transaction sérialisable : contrôle du cumul + ligne PENDING
 * 2. ordonner   — appel au prestataire, clé d'idempotence = identifiant de la ligne
 * 3. conclure   — SUCCEEDED + re_… si accepté, FAILED si refusé
 * ```
 *
 * Réserver **avant** d'ordonner est ce qui rend le deuxième critère vrai en
 * présence de pannes. L'inverse — ordonner puis inscrire — laisserait, sur un
 * arrêt du processus entre les deux, un remboursement sorti que notre cumul
 * ignore, donc rendu une seconde fois au clic suivant. Réservé d'abord, le pire
 * cas est une somme momentanément non remboursable : l'erreur du bon côté.
 *
 * C'est aussi ce qui donne la clé d'idempotence sa valeur : elle est
 * l'identifiant de la ligne, posé avant l'appel. Un renvoi après coupure réseau
 * porte donc la même clé et rend le remboursement déjà créé, plutôt que d'en
 * émettre un second.
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est le point. Le dépôt est scopé par le contexte de
 * requête : l'encaissement d'un autre établissement est *introuvable*, et le
 * remboursement est refusé en 404 — jamais 403, qui confirmerait son existence
 * (tenant-isolation §4). Ce service ne compare aucun `tenantId` parce qu'il n'en
 * reçoit aucun.
 *
 * ## Aucune donnée de carte, et aucune donnée personnelle chez le prestataire
 *
 * Il n'y a pas de paramètre pour recevoir une carte et pas de champ pour en
 * rendre une : on rembourse une **intention**, désignée par sa référence opaque
 * (payments-stripe §1). Le motif, lui, est un texte saisi par une personne et
 * peut nommer la cliente : il reste en base, et les métadonnées envoyées avec
 * l'ordre ne portent que des identifiants opaques (CDC §5.1).
 */

/**
 * Les statuts d'encaissement depuis lesquels un remboursement a un sens.
 *
 * `SUCCEEDED` est le cas nominal, `PARTIALLY_REFUNDED` le remboursement
 * complémentaire — le second geste sur le même encaissement, que le partiel
 * rend possible.
 *
 * `REFUNDED` en est exclu : il ne reste rien à rendre, et le refuser ici donne
 * un message plus juste que le contrôle de cumul, qui parlerait d'un solde de
 * zéro. `PENDING` et `FAILED` le sont aussi, et pour une raison plus forte :
 * aucun argent n'a été capturé. Le remède y est l'annulation de l'intention, un
 * geste que ce ticket ne pose pas.
 */
const REFUNDABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set([
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
]);

/**
 * Le moyen d'encaissement que le prestataire sait rembourser.
 *
 * `CASH` en est exclu par construction : rendre un billet est un geste de
 * caisse. Envoyer un ordre au prestataire pour de l'argent qui n'y est jamais
 * entré ferait apparaître au relevé un remboursement sans encaissement
 * correspondant — c'est-à-dire un rapprochement qui ne tombe plus jamais juste.
 */
const REFUNDABLE_METHOD = 'CARD';

/**
 * Les statuts que le prestataire rend sur un ordre qui **n'a pas** abouti.
 *
 * Un corps de réponse 2xx ne veut pas dire « argent rendu » : Stripe rend le
 * remboursement créé avec son propre statut, et il peut naître `failed` — la
 * banque de la cliente a refusé le mouvement — ou `canceled`. Inscrire ces
 * lignes-là en `SUCCEEDED` immobiliserait leur montant pour toujours dans le
 * cumul réservé, alors qu'aucun centime n'est sorti : la cliente ne serait plus
 * remboursable par cette route, et le rapprochement compterait un geste qui n'a
 * pas eu lieu.
 *
 * `pending` n'y figure pas, et c'est délibéré : le mouvement est engagé, seule
 * sa confirmation tarde — c'est exactement ce que `SUCCEEDED` décrit ici, et ce
 * que `charge.refunded` viendra confirmer sur la ligne `payments`.
 */
const REJECTED_PROVIDER_REFUND_STATUSES: ReadonlySet<string> = new Set(['failed', 'canceled']);

@Injectable()
export class RefundsService {
  public constructor(
    private readonly refunds: RefundsRepository,
    private readonly tenants: TenantContextService,
    @Inject(STRIPE_GATEWAY) private readonly stripe: StripeGateway,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Rembourse un encaissement, en totalité ou en partie.
   *
   * `amountMinor` omis vaut « tout ce qui reste » — le solde calculé côté
   * serveur, et non un mode d'appel distinct chez le prestataire.
   *
   * @throws {NotFoundError} encaissement inconnu — ou appartenant à un autre
   * établissement, ce qui doit être indiscernable (tenant-isolation §4).
   * @throws {PaymentNotRefundableError} encaissement en espèces, ou dont rien
   * n'a été capturé.
   * @throws {RefundExceedsCapturedError} le cumul dépasserait le montant
   * encaissé — le deuxième critère de #63, rendu à l'appelant.
   * @throws {PaymentProviderUnavailableError} le prestataire a refusé ou n'a pas
   * répondu. La réservation n'est relâchée que sur un refus **définitif** — sur
   * une issue ambiguë elle est conservée, faute de quoi une reprise rendrait
   * l'argent deux fois.
   */
  public async refund(
    paymentId: string,
    request: { readonly amountMinor?: number; readonly reason: string },
    operatorUserId: string,
  ): Promise<RefundRecord> {
    // Relu avant la transaction pour un seul motif : le message. Un
    // encaissement en espèces ou jamais capturé se refuse pour ce qu'il est —
    // 422 nommant le moyen et le statut — plutôt que par un contrôle de cumul
    // qui parlerait d'un solde. La garantie, elle, ne repose pas sur cette
    // lecture : le cumul est revérifié dans la transaction.
    const existing = await this.refunds.findRefundable(paymentId);

    if (existing === null) {
      // Le message ne distingue pas « inconnu » de « chez le voisin » : la
      // différence servirait de sonde d'existence, et `details` reste vide pour
      // que les deux refus soient identiques octet pour octet
      // (tenant-isolation §6).
      throw new NotFoundError('Encaissement introuvable.');
    }

    // Rend la référence d'intention plutôt qu'un simple verdict : c'est elle
    // qu'il faudra désigner au prestataire, et l'obtenir du contrôle évite de
    // la redemander ensuite à une valeur que le typage sait nullable.
    const paymentIntentId = requireRefundable(existing);

    const amount: RefundAmountRequest =
      request.amountMinor === undefined
        ? { kind: 'remaining' }
        : { kind: 'exact', amountMinor: request.amountMinor };

    const reservation = await this.refunds.reserve(paymentId, amount, {
      reason: request.reason,
      requestedByUserId: operatorUserId,
    });

    if (reservation.outcome === 'payment-not-found') {
      // La ligne a disparu entre les deux lectures — un cas que rien ne devrait
      // produire, la table n'ayant aucune suppression. Même corps que ci-dessus,
      // pour la même raison.
      throw new NotFoundError('Encaissement introuvable.');
    }

    if (reservation.outcome === 'exceeds-captured') {
      const { amount: captured, alreadyRefundedMinor } = reservation.payment;
      throw new RefundExceedsCapturedError(
        captured.amountMinor - alreadyRefundedMinor,
        captured.currency,
      );
    }

    return this.order(reservation.payment, reservation.refund, paymentIntentId);
  }

  /**
   * Envoie l'ordre au prestataire et conclut la réservation.
   *
   * ## Le seul échec qui relâche la réservation
   *
   * Un refus **définitif** — le prestataire a reçu l'ordre, l'a compris et l'a
   * rejeté, ou l'a créé dans un état qui dit qu'il n'aboutira pas. Rien n'est
   * sorti, la somme redevient remboursable, et le comptoir peut recommencer.
   *
   * Tout le reste — délai dépassé, coupure, panne du prestataire, corps
   * illisible — laisse le sort de l'ordre **inconnu**, et la réservation est
   * alors **conservée**. C'est la seule conduite qui ne puisse pas rendre
   * l'argent deux fois : une reprise repartirait avec une autre clé
   * d'idempotence, que le prestataire n'aurait aucun moyen de reconnaître comme
   * un doublon. Le prix est une somme immobilisée jusqu'à un rapprochement
   * manuel — réparable, là où un double remboursement ne l'est pas.
   */
  private async order(
    payment: RefundablePayment,
    refund: RefundRecord,
    paymentIntentId: string,
  ): Promise<RefundRecord> {
    let accepted: StripeRefund;

    try {
      accepted = await this.stripe.createRefund({
        paymentIntentId,
        amountMinor: refund.amount.amountMinor,
        // La clé est l'identifiant de la ligne réservée, donc stable et posée
        // avant l'appel : un renvoi après coupure réseau rend le remboursement
        // déjà créé au lieu d'en émettre un second.
        idempotencyKey: refund.id,
        metadata: this.metadataFor(payment.id, refund.id),
      });
    } catch (error) {
      if (error instanceof PaymentProviderRefusedError) {
        await this.release(payment, refund, 'refus définitif du prestataire');
      } else {
        // Sort inconnu : la réservation reste `PENDING` et immobilise sa somme.
        // L'alerte est ce qui amène quelqu'un à relire les remboursements chez
        // le prestataire et à trancher — c'est une **alerte à traiter**, pas
        // une trace.
        this.logger.error(
          'remboursement au sort inconnu — réservation conservée, rapprochement requis',
          {
            refundId: refund.id,
            paymentId: payment.id,
            amountMinor: refund.amount.amountMinor,
            currency: refund.amount.currency,
            operatorUserId: refund.requestedByUserId,
          },
          RefundsService.name,
        );
      }

      throw error;
    }

    // Un 2xx n'est pas une acceptation : le remboursement peut naître `failed`
    // ou `canceled`, auquel cas rien n'est sorti. Le conclure en `SUCCEEDED`
    // réserverait son montant à jamais — voir
    // `REJECTED_PROVIDER_REFUND_STATUSES`.
    if (REJECTED_PROVIDER_REFUND_STATUSES.has(accepted.status)) {
      // Refus définitif, et non ambigu : le prestataire a bien créé l'objet et
      // nous en donne l'état. Rien n'est sorti, la somme est donc relâchée.
      await this.release(payment, refund, `remboursement ${accepted.status} chez le prestataire`);

      throw new PaymentProviderRefusedError();
    }

    const concluded = await this.refunds.markAccepted(refund.id, accepted.id);

    if (concluded === null) {
      // La réservation n'était plus `PENDING` : une reprise l'a conclue entre
      // notre appel et notre écriture. La clé d'idempotence garantit qu'il n'y a
      // eu qu'un seul remboursement chez le prestataire — il n'y a donc rien à
      // compenser, seulement la ligne à relire.
      const winner = await this.refunds.findById(refund.id);

      if (winner === null) {
        throw new NotFoundError('Encaissement introuvable.');
      }

      return winner;
    }

    // La trace du geste, en plus de la ligne : elle porte l'identité vérifiée de
    // l'opérateur et la référence du prestataire, ce qui rend le rapprochement
    // possible depuis le journal comme depuis la base (CDC §4.9). Aucune donnée
    // personnelle — des identifiants opaques, un montant, une devise — et
    // **pas le motif**, qui peut nommer la cliente.
    this.logger.log(
      'remboursement ordonné au comptoir',
      {
        refundId: concluded.id,
        paymentId: payment.id,
        providerRefundId: concluded.providerRefundId,
        amountMinor: concluded.amount.amountMinor,
        currency: concluded.amount.currency,
        operatorUserId: concluded.requestedByUserId,
      },
      RefundsService.name,
    );

    return concluded;
  }

  /**
   * Relâche une réservation que le prestataire n'a pas honorée, et le journalise.
   *
   * Sans ce relâchement, un refus immobiliserait la somme pour toujours : le
   * comptoir ne pourrait plus rendre l'argent par aucun moyen. Le motif n'est
   * pas journalisé — il peut nommer la cliente.
   */
  private async release(
    payment: RefundablePayment,
    refund: RefundRecord,
    motif: string,
  ): Promise<void> {
    await this.refunds.markFailed(refund.id);

    this.logger.error(
      'remboursement refusé par le prestataire — réservation relâchée',
      {
        motif,
        refundId: refund.id,
        paymentId: payment.id,
        amountMinor: refund.amount.amountMinor,
        currency: refund.amount.currency,
        operatorUserId: refund.requestedByUserId,
      },
      RefundsService.name,
    );
  }

  /**
   * Ce que le prestataire conservera avec le remboursement.
   *
   * Trois identifiants opaques, et rien d'autre : ni nom, ni adresse, ni le
   * motif saisi au comptoir (CDC §5.1). `tenantId` y figure pour la même raison
   * qu'à la création de l'intention — c'est ce qui permet de résoudre
   * l'établissement d'un événement qui n'arrive qu'avec une référence.
   */
  private metadataFor(paymentId: string, refundId: string): Record<string, string> {
    return { tenantId: this.tenants.requireTenantId(), paymentId, refundId };
  }
}

/**
 * La référence d'intention d'un encaissement remboursable, ou un refus.
 *
 * Trois conditions sous un seul code, parce que le comptoir n'a qu'une conduite
 * pour les trois : traiter le geste hors de cette route. Voir
 * `PaymentNotRefundableError` pour le détail de chacune.
 *
 * Elle rend la référence plutôt qu'un booléen : c'est la valeur que l'appel au
 * prestataire réclame, et la faire sortir d'ici est ce qui évite un `?? ''` ou
 * un `!` sur une colonne que le schéma déclare nullable — parce qu'un règlement
 * en espèces, lui, n'en a légitimement pas.
 */
function requireRefundable(payment: RefundablePayment): string {
  if (
    payment.method !== REFUNDABLE_METHOD ||
    !REFUNDABLE_PAYMENT_STATUSES.has(payment.status) ||
    payment.providerPaymentIntentId === null
  ) {
    throw new PaymentNotRefundableError(payment.method, payment.status);
  }

  return payment.providerPaymentIntentId;
}
