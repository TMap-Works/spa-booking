import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type {
  PaymentMethod,
  PaymentStatus,
  RefundRecord,
  RefundStatus,
  RefundablePayment,
} from '../payments.types';
import { RESERVING_REFUND_STATUSES } from '../payments.types';
import type {
  RefundAmountRequest,
  RefundReservation,
  RefundsRepository,
} from '../refunds.repository';

/**
 * Doubles des remboursements — #63.
 *
 * Le dépôt en mémoire reproduit **cinq propriétés** du vrai, et chacune porte un
 * test dans `refunds.service.spec.ts` :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent, comme l'extension Prisma le fait
 *    en vrai. Un double qui l'ignorerait ferait verdir la fuite qu'on cherche ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération ;
 * 3. l'**atomicité du contrôle et de la réservation** — `reserve` relit le
 *    cumul et inscrit la ligne d'un seul geste, là où le vrai s'appuie sur une
 *    transaction sérialisable. Le double ne peut pas prouver la sérialisation,
 *    mais il peut prouver que le service n'a **pas** posé son propre contrôle à
 *    côté : c'est le dépôt qui refuse le dépassement, pas lui ;
 * 4. le **cumul des deux comptes** — la somme des réservations actives et le
 *    `refunded_amount_minor` inscrit par le webhook, le plus grand des deux
 *    faisant foi ;
 * 5. le **test-et-pose de la conclusion** — `markAccepted` ne réécrit qu'une
 *    ligne encore `PENDING`, comme l'`updateMany` filtré du vrai.
 *
 * Le prestataire, lui, ne parle jamais au réseau : `FakeStripeGateway` de
 * `payments.doubles.ts` sert les deux suites (payments-stripe §7).
 */

interface StoredRefundablePayment {
  tenantId: string;
  id: string;
  amountMinor: number;
  refundedAmountMinor: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  providerPaymentIntentId: string | null;
}

interface StoredRefund {
  tenantId: string;
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  requestedByUserId: string;
  status: RefundStatus;
  providerRefundId: string | null;
  createdAt: Date;
}

/** Sans portée résolue, rien ne passe — c'est la propriété 2. */
function requireTenant(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error(
      'FakeRefundsRepository : aucune portée de tenant ouverte. Le vrai dépôt ' +
        'lèverait `MissingTenantContextError` — un double qui rendrait « toutes ' +
        'les lignes » ferait verdir la fuite qu’on cherche.',
    );
  }

  return tenantId;
}

/**
 * La surface publique du vrai dépôt, et rien d'autre — même raison que
 * `PaymentsRepositoryPort` : ce qu'on veut est la substituabilité, et une
 * méthode renommée dans le vrai doit faire échouer la compilation d'ici.
 */
type RefundsRepositoryPort = Pick<
  RefundsRepository,
  'findRefundable' | 'reserve' | 'markAccepted' | 'markFailed' | 'findById'
>;

export class FakeRefundsRepository implements RefundsRepositoryPort {
  private readonly payments: StoredRefundablePayment[] = [];
  private readonly refunds: StoredRefund[] = [];

  /**
   * Sème un encaissement remboursable dans un établissement.
   *
   * Le `tenantId` est **explicite** et non pris dans le contexte : une suite de
   * fuite sème chez A pour rembourser depuis B, ce qu'un ensemencement scopé
   * rendrait impossible à écrire.
   */
  public seedPayment(input: {
    tenantId: string;
    id?: string;
    amountMinor?: number;
    refundedAmountMinor?: number;
    currency?: string;
    method?: PaymentMethod;
    status?: PaymentStatus;
    providerPaymentIntentId?: string | null;
  }): StoredRefundablePayment {
    const row: StoredRefundablePayment = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      amountMinor: input.amountMinor ?? 7000,
      refundedAmountMinor: input.refundedAmountMinor ?? 0,
      currency: input.currency ?? 'EUR',
      method: input.method ?? 'CARD',
      status: input.status ?? 'SUCCEEDED',
      providerPaymentIntentId:
        input.providerPaymentIntentId === undefined
          ? `pi_${randomUUID()}`
          : input.providerPaymentIntentId,
    };
    this.payments.push(row);
    return row;
  }

  /** Sème un remboursement déjà inscrit — cumul antérieur, réservation en vol. */
  public seedRefund(input: {
    tenantId: string;
    paymentId: string;
    amountMinor: number;
    status?: RefundStatus;
    reason?: string;
    requestedByUserId?: string;
  }): StoredRefund {
    const row: StoredRefund = {
      tenantId: input.tenantId,
      id: randomUUID(),
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      currency: 'EUR',
      reason: input.reason ?? 'geste commercial',
      requestedByUserId: input.requestedByUserId ?? randomUUID(),
      status: input.status ?? 'SUCCEEDED',
      providerRefundId: (input.status ?? 'SUCCEEDED') === 'SUCCEEDED' ? `re_${randomUUID()}` : null,
      createdAt: new Date(),
    };
    this.refunds.push(row);
    return row;
  }

  /** Toutes les lignes, tous établissements confondus — pour l'assertion « intact ». */
  public allRefunds(): readonly StoredRefund[] {
    return this.refunds;
  }

  public findRefundable(paymentId: string): Promise<RefundablePayment | null> {
    const tenantId = requireTenant();
    const row = this.find(tenantId, paymentId);

    return Promise.resolve(row === undefined ? null : this.toRefundable(row));
  }

  public reserve(
    paymentId: string,
    request: RefundAmountRequest,
    draft: { readonly reason: string; readonly requestedByUserId: string },
  ): Promise<RefundReservation> {
    const tenantId = requireTenant();
    const row = this.find(tenantId, paymentId);

    if (row === undefined) {
      return Promise.resolve({ outcome: 'payment-not-found' });
    }

    const payment = this.toRefundable(row);
    const remaining = payment.amount.amountMinor - payment.alreadyRefundedMinor;
    const amountMinor = request.kind === 'remaining' ? remaining : request.amountMinor;

    // Propriété 3 : c'est **ici** que le dépassement est refusé, pas dans le
    // service. Une suite qui verrait le service refuser de son côté saurait
    // qu'il a posé un contrôle hors transaction.
    if (amountMinor <= 0 || amountMinor > remaining) {
      return Promise.resolve({ outcome: 'exceeds-captured', payment });
    }

    const refund: StoredRefund = {
      tenantId,
      id: randomUUID(),
      paymentId,
      amountMinor,
      currency: payment.amount.currency,
      reason: draft.reason,
      requestedByUserId: draft.requestedByUserId,
      status: 'PENDING',
      providerRefundId: null,
      createdAt: new Date(),
    };
    this.refunds.push(refund);

    return Promise.resolve({ outcome: 'reserved', payment, refund: toRefundRecord(refund) });
  }

  public markAccepted(refundId: string, providerRefundId: string): Promise<RefundRecord | null> {
    const tenantId = requireTenant();
    const row = this.refunds.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === refundId,
    );

    // Propriété 5 : test-et-pose, comme l'`updateMany` filtré par statut du vrai.
    if (row === undefined || row.status !== 'PENDING') {
      return Promise.resolve(null);
    }

    row.status = 'SUCCEEDED';
    row.providerRefundId = providerRefundId;

    return Promise.resolve(toRefundRecord(row));
  }

  public markFailed(refundId: string): Promise<void> {
    const tenantId = requireTenant();
    const row = this.refunds.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === refundId,
    );

    if (row !== undefined && row.status === 'PENDING') {
      row.status = 'FAILED';
    }

    return Promise.resolve();
  }

  public findById(refundId: string): Promise<RefundRecord | null> {
    const tenantId = requireTenant();
    const row = this.refunds.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === refundId,
    );

    return Promise.resolve(row === undefined ? null : toRefundRecord(row));
  }

  private find(tenantId: string, paymentId: string): StoredRefundablePayment | undefined {
    return this.payments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === paymentId,
    );
  }

  /** Propriété 4 : le plus grand des deux comptes, comme le vrai. */
  private toRefundable(row: StoredRefundablePayment): RefundablePayment {
    const reserved = this.refunds
      .filter((candidate) => candidate.tenantId === row.tenantId && candidate.paymentId === row.id)
      .filter((candidate) =>
        (RESERVING_REFUND_STATUSES as readonly string[]).includes(candidate.status),
      )
      .reduce((total, candidate) => total + candidate.amountMinor, 0);

    return {
      id: row.id,
      amount: { amountMinor: row.amountMinor, currency: row.currency },
      method: row.method,
      status: row.status,
      providerPaymentIntentId: row.providerPaymentIntentId,
      alreadyRefundedMinor: Math.max(reserved, row.refundedAmountMinor),
    };
  }
}

function toRefundRecord(row: StoredRefund): RefundRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    reason: row.reason,
    requestedByUserId: row.requestedByUserId,
    status: row.status,
    providerRefundId: row.providerRefundId,
    createdAt: row.createdAt,
  };
}
