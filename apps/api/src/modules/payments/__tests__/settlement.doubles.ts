import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { SettlementRepository } from '../settlement.repository';
import type { CounterSettlementOutcome, PaymentTransaction, SaleSettlement } from '../payments.types';
import { counterSettlementOf, settlementMeanOf } from '../payments.types';
import { planSettlement } from '../settlement.rules';
import type { SettlementRequest } from '../settlement.rules';

/**
 * `SettlementRepository` en mémoire — le règlement d'un ticket sans base (#834).
 *
 * ## Les trois propriétés du vrai qu'il reproduit
 *
 * 1. **le scoping par l'extension Prisma** : un ticket d'un autre établissement
 *    est *introuvable*, jamais interdit. C'est ce qui fait que le service
 *    répond 404 et non 403 (tenant-isolation §4), et c'est la seule façon de
 *    l'exercer sans Docker ;
 * 2. **l'arithmétique réelle** : il appelle `planSettlement`, la fonction que le
 *    vrai dépôt appelle. Un double qui recalculerait à sa façon mesurerait sa
 *    propre idée du reste dû ;
 * 3. **l'idempotence par clé, portée au ticket** : la même clé rejouée sur le
 *    même ticket rend le règlement déjà inscrit sans rien écrire, comme
 *    `@@unique([tenantId, saleId, idempotencyKey])` et la relecture sous verrou
 *    le font en base.
 *
 * ## Ce qu'il ne reproduit pas, et pourquoi c'est sans conséquence ici
 *
 * Ni le verrou `FOR UPDATE`, ni la contrainte `sales_settled_amount_minor_check`
 * — ils ne s'observent que sous concurrence réelle, et c'est l'objet de
 * `apps/api/test/pos-settlement.concurrency-spec.ts`, qui tourne contre un vrai
 * PostgreSQL. Ce double sert les propriétés **séquentielles** : quel couple de
 * colonnes est écrit, quel refus tombe, et ce que le rejeu rend.
 *
 * ## Aucune passerelle Stripe
 *
 * Ce fichier n'importe rien de `stripe/`, et son constructeur ne reçoit rien.
 * C'est la même garantie de forme que celle du vrai dépôt : on ne vérifie pas
 * qu'un appel n'a pas eu lieu, on fait qu'il n'y ait nulle part où le passer.
 */

/** Un ticket, réduit à ce que le règlement lit et écrit. */
interface StoredSale {
  readonly tenantId: string;
  readonly id: string;
  readonly totalAmountMinor: number;
  settledAmountMinor: number;
  settledAt: Date | null;
  readonly currency: string;
}

/** Un encaissement inscrit par le comptoir. */
interface StoredSettlementPayment {
  readonly tenantId: string;
  readonly id: string;
  readonly saleId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly method: PaymentTransaction['method'];
  readonly cardChannel: PaymentTransaction['cardChannel'];
  readonly terminalReference: string | null;
  readonly tenderedAmountMinor: number | null;
  readonly idempotencyKey: string | null;
  readonly capturedAt: Date;
}

/** Sans portée résolue, rien ne passe — comme l'extension de scoping. */
function requireTenant(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error('FakeSettlementRepository : aucune portée de tenant résolue.');
  }

  return tenantId;
}

export class FakeSettlementRepository {
  private readonly sales: StoredSale[] = [];

  /** Les encaissements inscrits, dans l'ordre — la matière des assertions. */
  public readonly payments: StoredSettlementPayment[] = [];

  /** Pose un ticket composé, prêt à être réglé. */
  public seedSale(input: {
    tenantId: string;
    totalAmountMinor: number;
    id?: string;
    settledAmountMinor?: number;
    settledAt?: Date | null;
    currency?: string;
  }): StoredSale {
    const sale: StoredSale = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      totalAmountMinor: input.totalAmountMinor,
      settledAmountMinor: input.settledAmountMinor ?? 0,
      settledAt: input.settledAt ?? null,
      currency: input.currency ?? 'EUR',
    };

    this.sales.push(sale);

    return sale;
  }

  /** Les moyens employés sur un ticket, dans l'ordre — pour lire une relève. */
  public meansOf(saleId: string): readonly string[] {
    return this.payments
      .filter((payment) => payment.saleId === saleId)
      .map((payment) => settlementMeanOf(payment.method, payment.cardChannel));
  }

  public settleSale(
    saleId: string,
    request: SettlementRequest,
    idempotencyKey: string | null = null,
  ): Promise<CounterSettlementOutcome> {
    const tenantId = requireTenant();
    // Le prédicat porte le tenant, comme le `WHERE` du verrou de ligne du vrai
    // dépôt : le ticket du voisin n'est pas refusé, il n'existe pas.
    const sale = this.sales.find((row) => row.tenantId === tenantId && row.id === saleId);

    if (sale === undefined) {
      return Promise.resolve({ outcome: 'sale-not-found' });
    }

    if (idempotencyKey !== null) {
      const replay = this.payments.find(
        (payment) =>
          payment.tenantId === tenantId &&
          payment.saleId === saleId &&
          payment.idempotencyKey === idempotencyKey,
      );

      if (replay !== undefined) {
        return Promise.resolve({
          outcome: 'replayed',
          settlement: this.envelope(sale, replay, true),
        });
      }
    }

    const plan = planSettlement(
      {
        totalAmountMinor: sale.totalAmountMinor,
        settledAmountMinor: sale.settledAmountMinor,
        settledAt: sale.settledAt,
      },
      request,
    );

    if (plan.outcome === 'already-settled') {
      return Promise.resolve({ outcome: 'already-settled', settledAt: plan.settledAt });
    }

    if (plan.outcome === 'overpayment') {
      return Promise.resolve({
        outcome: 'overpayment',
        remainingAmountMinor: plan.remainingAmountMinor,
      });
    }

    const stored = counterSettlementOf(request.method);
    const capturedAt = new Date();
    const payment: StoredSettlementPayment = {
      tenantId,
      id: randomUUID(),
      saleId,
      amountMinor: plan.appliedAmountMinor,
      currency: sale.currency,
      method: stored.method,
      cardChannel: stored.cardChannel,
      terminalReference: request.terminalReference ?? null,
      tenderedAmountMinor:
        request.tenderedAmountMinor === undefined || plan.changeAmountMinor === 0
          ? null
          : request.tenderedAmountMinor,
      idempotencyKey,
      capturedAt,
    };

    this.payments.push(payment);
    sale.settledAmountMinor += plan.appliedAmountMinor;

    if (plan.settlesSale) {
      sale.settledAt = capturedAt;
    }

    return Promise.resolve({
      outcome: 'settled',
      settlement: this.envelope(sale, payment, false, plan.changeAmountMinor),
    });
  }

  /** L'enveloppe rendue au service — la ligne, l'état du ticket, la monnaie. */
  private envelope(
    sale: StoredSale,
    payment: StoredSettlementPayment,
    replayed: boolean,
    changeAmountMinor?: number,
  ): SaleSettlement {
    const money = (amountMinor: number) => ({ amountMinor, currency: sale.currency });
    // La monnaie se **déduit** du billet tendu, comme partout dans le module :
    // elle n'est stockée nulle part, et le rejeu la recalcule donc lui aussi.
    const change =
      changeAmountMinor ??
      (payment.tenderedAmountMinor === null ? 0 : payment.tenderedAmountMinor - payment.amountMinor);

    return {
      payment: {
        id: payment.id,
        appointmentId: null,
        saleId: payment.saleId,
        amount: money(payment.amountMinor),
        refunded: money(0),
        method: payment.method,
        cardChannel: payment.cardChannel,
        status: 'SUCCEEDED',
        providerPaymentIntentId: null,
        providerChargeId: null,
        terminalReference: payment.terminalReference,
        capturedAt: payment.capturedAt,
        createdAt: payment.capturedAt,
      },
      saleId: sale.id,
      total: money(sale.totalAmountMinor),
      settled: money(sale.settledAmountMinor),
      remaining: money(sale.totalAmountMinor - sale.settledAmountMinor),
      change: money(change),
      settledAt: sale.settledAt,
      replayed,
    };
  }
}

/** Le double, vu par le service — la conversion est faite une fois, ici. */
export function asSettlementRepository(fake: FakeSettlementRepository): SettlementRepository {
  return fake as unknown as SettlementRepository;
}
