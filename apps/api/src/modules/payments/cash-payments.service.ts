import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { AppointmentNotSettleableError, PaymentAlreadySettledError } from './payments.errors';
import { PaymentsRepository } from './payments.repository';
import type { PaymentTransaction } from './payments.types';

/**
 * Le règlement en espèces au comptoir — premier et quatrième critères de #62.
 *
 * ## Pourquoi un service distinct de `PaymentsService`
 *
 * Parce que c'est la seule façon de rendre le quatrième critère — « aucun appel
 * Stripe sur le chemin espèces » — **vrai par construction** plutôt que par
 * vigilance. `PaymentsService` injecte `STRIPE_GATEWAY` et `StripeConfig` : y
 * ajouter une méthode `settleInCash` aurait laissé la passerelle à portée de
 * main, à un `this.stripe.` près, et le critère n'aurait plus tenu qu'à la
 * relecture. Ici il n'y a rien à appeler : ce fichier n'importe pas la
 * passerelle, le constructeur ne la reçoit pas, et un test le vérifie sur la
 * forme même de la classe.
 *
 * C'est le même raisonnement que celui qui tient le total du POS : on ne
 * contrôle pas qu'un montant n'a pas été envoyé, on fait qu'il n'y ait nulle
 * part où l'envoyer.
 *
 * ## Les trois invariants qu'il tient
 *
 * 1. **Le montant vient de la base, jamais de l'appelant.** Le corps de la
 *    requête ne porte qu'un identifiant de rendez-vous ; le prix est celui figé
 *    à la réservation (payments-stripe §4). Accepter un montant au comptoir
 *    aurait été la même faute qu'en ligne, avec en plus la personne devant soi.
 * 2. **Un rendez-vous, un encaissement.** Garanti en base par
 *    `@@unique([tenantId, appointmentId])`, pas par ce fichier. Un double clic
 *    rend deux fois le **même** reçu ; il n'encaisse jamais deux fois.
 * 3. **La caisse fait foi, donc l'encaissement naît abouti.** `SUCCEEDED` et
 *    `captured_at` dès l'écriture — il n'y a aucun tiers dont on attendrait la
 *    confirmation, contrairement à la carte où seul le webhook conclut
 *    (payments-stripe §2).
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est le point. Le dépôt est scopé par le contexte de
 * requête : un rendez-vous d'un autre établissement est *introuvable*, et le
 * règlement est refusé en 404 — jamais 403, qui confirmerait son existence
 * (tenant-isolation §4). Ce service ne compare aucun `tenantId` parce qu'il n'en
 * reçoit aucun.
 *
 * ## L'opérateur, et ce qu'il en advient aujourd'hui
 *
 * payments-stripe §4 demande d'enregistrer la vente « avec `method: 'cash'`,
 * l'opérateur, l'horodatage et le montant ». Trois des quatre sont écrits en
 * base. Le quatrième ne l'est pas : la table `payments` n'a **pas** de colonne
 * d'opérateur, et l'y ajouter est une migration — hors de l'empreinte de ce
 * ticket. L'identité vérifiée de la personne qui encaisse part donc au journal
 * structuré, où elle est traçable et horodatée, en attendant la colonne. Ce
 * n'est pas l'équivalent d'une écriture en base, et c'est dit comme tel dans le
 * README du module et dans l'issue de suivi.
 *
 * Ce que le ticket de caisse (`sales`), lui, porte déjà : `cashier_user_id`,
 * `NOT NULL`, depuis #60. Un règlement rattaché à un ticket a donc son opérateur
 * — c'est le règlement d'un rendez-vous sans ticket qui ne l'a pas.
 */

/**
 * Le seul statut de rendez-vous qui interdise un encaissement au comptoir.
 *
 * `CANCELLED` : le créneau a été rendu, la prestation n'a pas été vendue.
 * Encaisser dessus créerait une recette sans contrepartie.
 *
 * Tous les autres passent, `COMPLETED` et `NO_SHOW` compris — et c'est
 * précisément là que le comptoir diffère du tunnel public, qui les refuse. Voir
 * `AppointmentNotSettleableError` pour le détail du partage.
 */
const UNSETTLEABLE_APPOINTMENT_STATUS = 'CANCELLED';

@Injectable()
export class CashPaymentsService {
  public constructor(
    private readonly payments: PaymentsRepository,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Encaisse un rendez-vous en espèces.
   *
   * Rejouable sans effet de bord : appelée deux fois, elle rend deux fois le
   * même encaissement, et la caisse n'est créditée qu'une fois. Deux mécanismes
   * s'y emploient — la ligne déjà présente, relue avant d'écrire, et l'unicité
   * en base qui tranche la course que cette relecture ne peut pas voir.
   *
   * @throws {NotFoundError} rendez-vous inconnu — ou appartenant à un autre
   * établissement, ce qui doit être indiscernable (tenant-isolation §4).
   * @throws {AppointmentNotSettleableError} rendez-vous annulé.
   * @throws {PaymentAlreadySettledError} un encaissement existe déjà et il n'est
   * pas ce règlement-ci — une carte en cours, aboutie ou remboursée.
   */
  public async settle(appointmentId: string, operatorUserId: string): Promise<PaymentTransaction> {
    const appointment = await this.payments.findPayableAppointment(appointmentId);

    if (appointment === null) {
      // Le message ne distingue pas « inconnu » de « chez le voisin » : la
      // différence servirait de sonde d'existence, et `details` reste vide pour
      // que les deux refus soient identiques octet pour octet.
      throw new NotFoundError('Rendez-vous introuvable.');
    }

    if (appointment.status === UNSETTLEABLE_APPOINTMENT_STATUS) {
      throw new AppointmentNotSettleableError(appointment.status);
    }

    const existing = await this.payments.findTransactionByAppointment(appointmentId);

    if (existing !== null) {
      return replayOrRefuse(existing);
    }

    const recorded = await this.payments.recordCashPayment({
      appointmentId,
      // Le prix figé en base, et lui seul.
      amount: appointment.price,
    });

    if (recorded === null) {
      // Course perdue : une requête concurrente a inscrit la ligne entre notre
      // lecture et notre écriture. Rien à compenser — la contrainte a refusé
      // l'insertion, donc aucun second encaissement n'existe —, seulement la
      // ligne gagnante à relire.
      const winner = await this.payments.findTransactionByAppointment(appointmentId);

      if (winner === null) {
        // La contrainte a refusé l'insertion, mais la ligne est introuvable :
        // l'état est incohérent et se signale plutôt que de se deviner. Même
        // corps que ci-dessus, pour la même raison.
        throw new NotFoundError('Rendez-vous introuvable.');
      }

      return replayOrRefuse(winner);
    }

    // La trace de l'opérateur, faute de colonne où l'écrire — voir l'en-tête.
    // Aucune donnée personnelle : deux identifiants opaques, un montant et une
    // devise (CDC §5.1).
    this.logger.log(
      'encaissement en espèces au comptoir',
      {
        paymentId: recorded.id,
        appointmentId,
        operatorUserId,
        amountMinor: recorded.amount.amountMinor,
        currency: recorded.amount.currency,
      },
      CashPaymentsService.name,
    );

    return recorded;
  }
}

/**
 * Rend l'encaissement déjà inscrit s'il **est** ce règlement-ci, le refuse sinon.
 *
 * La distinction est celle du deuxième clic : un règlement en espèces déjà
 * abouti est la réponse que l'appelant attendait, et la lui rendre est ce qui
 * rend la route rejouable. Tout le reste — une intention carte en cours, une
 * carte aboutie, un remboursement — est un encaissement *autre*, et l'écraser
 * ferait disparaître une pièce comptable. 409, et le comptoir tranche.
 *
 * Un `FAILED` carte tombe ici aussi, et c'est délibéré : le tunnel public sait
 * le reprendre — `@@unique([tenantId, appointmentId])` interdisant d'inscrire
 * une seconde ligne, le traiter comme clos rendrait le rendez-vous impayable —
 * mais le comptoir, lui, ne peut pas le *transformer* en espèces sans effacer
 * l'intention Stripe qui attend encore une autre carte. Le remède est
 * l'annulation de l'intention, qui relève de #63.
 */
function replayOrRefuse(existing: PaymentTransaction): PaymentTransaction {
  if (existing.method === 'CASH' && existing.status === 'SUCCEEDED') {
    return existing;
  }

  throw new PaymentAlreadySettledError(existing.status);
}
