import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import { StructuredLogger } from '../../common/logging/structured-logger';
import {
  AppointmentNotSettleableError,
  AppointmentTicketAlreadyOpenError,
  PaymentAlreadySettledError,
  SaleAlreadySettledError,
  SaleOverpaymentError,
} from './payments.errors';
import { PaymentsRepository } from './payments.repository';
import type { CounterSettlementOutcome, SaleSettlement } from './payments.types';
import { settlementMeanOf } from './payments.types';
import type { SaleLineRequest } from './pos.types';
import { SalesService } from './sales.service';
import { SettlementRepository } from './settlement.repository';
import type { SettlementRequest } from './settlement.rules';

/**
 * Le règlement au comptoir — #817, et ce qui reste de #62.
 *
 * ## Ce que ce service a remplacé
 *
 * `CashPaymentsService` inscrivait un encaissement **sans pièce** : régler un
 * rendez-vous ne créait aucune vente, si bien qu'il n'existait rien à imprimer
 * et que le reporting ne voyait jamais les ventes de produits. Encaisser
 * revient désormais à **composer la vente puis la régler**, dans une seule
 * transaction (deuxième critère), et une vente sans rendez-vous se règle par la
 * même porte.
 *
 * ## Le quatrième critère n'est pas tenu ici
 *
 * « Une vente réglée ne peut pas l'être une seconde fois » est un invariant de
 * base : `sales_settled_amount_minor_check` rend l'écriture de trop impossible,
 * et le verrou de ligne de `SettlementRepository` sérialise les concurrents. Ce
 * service ne fait que **traduire** ce que la transaction constate — 409 sur un
 * ticket soldé, 422 sur un dépassement. Il ne décide d'aucun de ces refus, et
 * c'est ce qui les rend vrais sous concurrence.
 *
 * ## Aucun appel Stripe sur ce chemin, par construction
 *
 * Ce fichier n'importe pas la passerelle, le constructeur ne la reçoit pas, et
 * `payments.boundaries.spec.ts` échoue si une porte de configuration Stripe
 * apparaissait ailleurs que dans `stripe/`. C'est le même raisonnement que
 * celui qui tient le total du POS : on ne contrôle pas qu'un appel n'a pas eu
 * lieu, on fait qu'il n'y ait nulle part où le passer.
 *
 * Depuis #834 (ADR 0015), le comptoir ne sait plus produire que deux moyens —
 * `CASH` et `CARD_TERMINAL` —, et c'est le **type** qui le tient :
 * `CounterSettlementMean` n'a pas de valeur pour une intention en ligne, donc
 * aucun corps de requête ne peut en demander une. La carte se règle sur le TPE
 * de la banque du salon ; rien de ce que le terminal manipule ne traverse notre
 * code, et le serveur n'en conserve que l'issue — le moyen, le montant,
 * l'opérateur, l'horodatage, et le numéro du ticket du terminal s'il a été
 * saisi (payments-stripe §4).
 *
 * ## Où se joue l'isolation
 *
 * Nulle part ici, et c'est le point. Le dépôt est scopé par le contexte de
 * requête, et son unique requête brute porte son propre prédicat
 * d'établissement : un rendez-vous ou un ticket d'un autre salon est
 * *introuvable*, et le règlement est refusé en 404 — jamais 403, qui
 * confirmerait son existence (tenant-isolation §4). Ce service ne compare aucun
 * `tenantId` parce qu'il n'en reçoit aucun.
 */

/**
 * Le seul statut de rendez-vous qui interdise un règlement au comptoir.
 *
 * `CANCELLED` : le créneau a été rendu, la prestation n'a pas été vendue.
 * Encaisser dessus créerait une recette sans contrepartie.
 *
 * ## Le rendez-vous non confirmé — huitième critère de #817
 *
 * `PENDING` **passe**, et c'est une décision, pas un oubli. L'issue laissait le
 * choix entre « l'acompte est autorisé » et « le règlement est refusé en 422 » ;
 * c'est la première qui est retenue, pour trois raisons :
 *
 * 1. le seul chemin automatique vers `CONFIRMED` est aujourd'hui le webhook
 *    Stripe (#800, encore ouvert). Refuser ici rendrait **impayable au
 *    comptoir** tout rendez-vous pris en ligne et réglé en espèces — le constat
 *    même que #800 décrit ;
 * 2. un acompte sur un rendez-vous à venir est un geste de comptoir courant, et
 *    le règlement partiel du quatrième critère lui donne enfin une forme :
 *    la vente reste ouverte, son reste dû se lit, et rien n'oblige à solder ;
 * 3. **régler ne confirme rien.** Ce service ne touche pas au statut du
 *    rendez-vous — c'est l'objet de #800, et l'usurper ici ferait avancer un
 *    cycle de vie depuis le module qui encaisse.
 *
 * Ce que le PO relevait — deux règlements sur des rendez-vous encore `PENDING`,
 * dont l'un prévu le lendemain — reste donc possible, et devient **lisible** :
 * la vente porte ce qui a été encaissé, le rendez-vous porte son statut, et les
 * deux ne se contredisent plus faute de pièce.
 */
const UNSETTLEABLE_APPOINTMENT_STATUS = 'CANCELLED';

@Injectable()
export class SettlementService {
  public constructor(
    private readonly payments: PaymentsRepository,
    private readonly settlements: SettlementRepository,
    private readonly sales: SalesService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Encaisse un rendez-vous : compose sa vente, puis la règle.
   *
   * @throws {NotFoundError} rendez-vous inconnu — ou appartenant à un autre
   * établissement, ce qui doit être indiscernable (tenant-isolation §4).
   * @throws {AppointmentNotSettleableError} rendez-vous annulé.
   * @throws {AppointmentTicketAlreadyOpenError} des lignes étaient à ajouter,
   * mais le rendez-vous porte déjà un ticket dont les totaux sont figés.
   * @throws {SaleAlreadySettledError} la vente du rendez-vous est déjà soldée.
   * @throws {SaleOverpaymentError} le montant demandé dépasse le reste dû.
   * @throws {PaymentAlreadySettledError} une intention carte est encore en vol.
   */
  public async settleAppointment(
    appointmentId: string,
    operatorUserId: string,
    request: SettlementRequest,
    extraLines: readonly SaleLineRequest[] = [],
  ): Promise<SaleSettlement> {
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

    const draft = await this.sales.composeForAppointment(appointment, extraLines, operatorUserId);

    return this.record(
      await this.settlements.settleAppointment(
        appointmentId,
        draft,
        request,
        // Des lignes ajoutées exigent que ce soit **cet appel** qui compose le
        // ticket : un ticket préexistant a ses totaux figés, et les y perdre en
        // silence ferait sortir la marchandise sans la facturer.
        extraLines.length > 0,
      ),
      operatorUserId,
    );
  }

  /**
   * Règle une vente déjà composée — avec ou sans rendez-vous derrière elle.
   *
   * C'est la porte du **règlement mixte** : appelée plusieurs fois sur le même
   * ticket, elle y inscrit autant d'encaissements, et le ticket est soldé quand
   * leur somme égale son total.
   *
   * @param idempotencyKey la clé de la soumission — #834, quatrième critère.
   * Rejouée sur le même ticket, elle rend le règlement déjà inscrit **sans rien
   * écrire**, et le `replayed` de l'enveloppe le dit. C'est la seule protection
   * possible ici : deux règlements de 25,00 € sur le même ticket sont deux
   * gestes légitimes, et rien d'autre que l'appelant ne sait s'il en a voulu un
   * ou deux.
   *
   * @throws {NotFoundError} ticket inconnu, ou d'un autre établissement.
   * @throws {SaleAlreadySettledError} ticket déjà soldé.
   * @throws {SaleOverpaymentError} le montant demandé dépasse le reste dû.
   * @throws {PaymentAlreadySettledError} une intention carte est encore en vol.
   */
  public async settleSale(
    saleId: string,
    operatorUserId: string,
    request: SettlementRequest,
    idempotencyKey: string,
  ): Promise<SaleSettlement> {
    return this.record(
      await this.settlements.settleSale(saleId, request, idempotencyKey),
      operatorUserId,
    );
  }

  /**
   * Traduit l'issue de la transaction, et trace l'opérateur.
   *
   * La trace part au journal structuré parce que `payments` n'a pas de colonne
   * d'opérateur — c'est le **ticket** qui porte `cashier_user_id`, et un
   * règlement sans vente n'existe plus depuis ce ticket. Aucune donnée
   * personnelle n'y entre : des identifiants opaques, un montant et une devise
   * (CDC §5.1).
   */
  private record(outcome: CounterSettlementOutcome, operatorUserId: string): SaleSettlement {
    switch (outcome.outcome) {
      case 'sale-not-found':
        throw new NotFoundError('Ticket introuvable.');

      case 'already-settled':
        throw new SaleAlreadySettledError(outcome.settledAt);

      case 'overpayment':
        throw new SaleOverpaymentError(outcome.remainingAmountMinor);

      case 'ticket-already-open':
        // 409, et le comptoir tranche : régler le ticket existant, et ouvrir
        // une vente à part pour ce qui devait s'y ajouter. Les lignes demandées
        // n'ont **rien** écrit.
        throw new AppointmentTicketAlreadyOpenError(outcome.saleId);

      case 'card-intent-in-flight':
        // 409, et le comptoir tranche : la cliente est peut-être en train de
        // payer en ligne. Écraser l'intention ferait disparaître une pièce.
        throw new PaymentAlreadySettledError('PENDING');

      case 'replayed':
      case 'settled': {
        const { settlement } = outcome;

        this.logger.log(
          // Le rejeu se distingue dans le journal, et il faut qu'il s'y
          // distingue : deux lignes « règlement au comptoir » identiques
          // laisseraient croire, à la relève, que la caisse a encaissé deux fois
          // (#834).
          settlement.replayed ? 'règlement au comptoir rejoué' : 'règlement au comptoir',
          {
            paymentId: settlement.payment.id,
            saleId: settlement.saleId,
            operatorUserId,
            // Le **moyen**, recomposé des deux colonnes : `CARD` seul ne dirait
            // pas si l'argent est passé par le terminal du salon ou par une
            // intention Stripe, et c'est précisément ce que la relève compare au
            // relevé de fin de journée du TPE.
            mean: settlementMeanOf(settlement.payment.method, settlement.payment.cardChannel),
            amountMinor: settlement.payment.amount.amountMinor,
            changeMinor: settlement.change.amountMinor,
            currency: settlement.payment.amount.currency,
            settled: settlement.settledAt !== null,
            replayed: settlement.replayed,
          },
          SettlementService.name,
        );

        return settlement;
      }
    }
  }
}
