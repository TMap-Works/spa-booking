import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import { RESERVING_REFUND_STATUSES } from './payments.types';
import type { RefundDraft, RefundRecord, RefundablePayment } from './payments.types';

/**
 * Accès Prisma des remboursements — #63.
 *
 * Un dépôt à part de `PaymentsRepository`, et ce n'est pas un découpage
 * décoratif : ce fichier porte **une** opération, et c'est une opération
 * atomique. Lire le montant capturé, sommer ce qui a déjà été engagé, et
 * inscrire la réservation ne sont pas trois gestes qu'un service enchaîne — ce
 * sont trois lectures-écritures qui doivent se sérialiser entre elles, sans
 * quoi le deuxième critère du ticket ne tient plus.
 *
 * Il injecte le client **scopé**, et rien d'autre : aucune lecture de ce module
 * n'est légitimement inter-tenant, donc `prismaUnscoped` n'y est pas injecté du
 * tout. Un encaissement du salon voisin est *introuvable* — le service lève
 * `NotFoundError`, la route répond 404 et jamais 403 (tenant-isolation §4).
 *
 * ## Pourquoi `Serializable` et non le défaut
 *
 * Le contrôle du cumul est un « lire, décider, écrire » : deux comptoirs qui
 * remboursent le même encaissement au même instant lisent tous deux un cumul de
 * zéro, concluent tous deux que le geste est possible, et rendent deux fois
 * l'argent. Un `CHECK` ne peut pas les arrêter — la borne porte sur une
 * **somme de lignes**, pas sur une colonne.
 *
 * `READ COMMITTED`, le défaut de PostgreSQL, ne suffit pas non plus : il prend
 * un instantané par instruction, et les deux transactions ne se voient jamais.
 * `Serializable` fait échouer l'une des deux (`40001`) parce que son résultat
 * dépend d'un ensemble de lignes que l'autre a modifié. C'est la même conduite
 * qu'ADR 0002 impose au moteur de réservation, et pour la même raison : ce
 * n'est pas la vigilance du service qui tranche une course, c'est la base.
 *
 * ## Pourquoi la réservation précède l'appel au prestataire
 *
 * Parce que l'ordre inverse ne se rattrape pas. Si l'ordre partait d'abord, un
 * arrêt du processus entre la sortie d'argent et son inscription laisserait un
 * remboursement invisible de notre cumul — donc remboursable une seconde fois.
 * Inscrite d'abord, la ligne `PENDING` engage le montant avant qu'un centime ne
 * bouge : le pire qui puisse arriver est une réservation qu'aucun ordre ne
 * suit, c'est-à-dire une somme momentanément non remboursable — l'erreur du bon
 * côté.
 */

/**
 * L'encaissement, réduit à ce que le remboursement a besoin d'en savoir.
 *
 * Projection explicite, jamais la ligne entière : `payments` n'a rien de
 * personnel, mais ce qu'on ne lit pas ne peut pas fuiter, et cette table est
 * celle qui parle au prestataire.
 */
const REFUNDABLE_PAYMENT_SELECT = {
  id: true,
  amountMinor: true,
  refundedAmountMinor: true,
  currency: true,
  method: true,
  status: true,
  providerPaymentIntentId: true,
} as const;

const REFUND_SELECT = {
  id: true,
  paymentId: true,
  amountMinor: true,
  currency: true,
  reason: true,
  requestedByUserId: true,
  status: true,
  providerRefundId: true,
  createdAt: true,
} as const;

type RefundRow = {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  requestedByUserId: string;
  status: string;
  providerRefundId: string | null;
  createdAt: Date;
};

/**
 * Nombre de tentatives de réservation avant d'abandonner.
 *
 * Même borne que `MAX_INSERT_ATTEMPTS` du moteur de réservation, et pour la même
 * raison : au-delà, ce n'est plus une course, c'est une charge — et réessayer
 * indéfiniment transformerait une contention en immobilisation.
 */
const MAX_RESERVE_ATTEMPTS = 3;

/**
 * Les SQLSTATE d'un échec **transitoire** d'écriture concurrente.
 *
 * `40001` est celui que `SERIALIZABLE` produit quand deux transactions ne
 * peuvent pas être ordonnées ; `40P01` est l'interblocage. Les deux se résolvent
 * en recommençant.
 */
const TRANSIENT_SQLSTATES: readonly string[] = ['40001', '40P01'];

/** Code Prisma de l'écriture concurrente. */
const WRITE_CONFLICT_CODE = 'P2034';

/**
 * `true` si l'erreur est un échec de sérialisation que réessayer résout.
 *
 * Jumeau d'`isTransientWriteConflict` d'`appointments.conflicts.ts`, **dupliqué
 * plutôt qu'importé** : un module n'atteint pas un fichier profond d'un autre
 * (api-module §3), et c'est la même raison qui fait vivre `dto/validation.ts` en
 * double dans ce module. Le nom est celui du voisin, pour que la parenté se voie.
 */
function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === WRITE_CONFLICT_CODE) {
    return true;
  }

  // Le SQLSTATE ne vit que dans le texte du message, sous la forme
  // `code: "40001"` que rend le connecteur.
  return TRANSIENT_SQLSTATES.some((sqlstate) => error.message.includes(`code: "${sqlstate}"`));
}

/** Attente croissante et dispersée, pour ne pas resynchroniser deux perdantes. */
async function backOff(attempt: number): Promise<void> {
  const base = 20 * attempt;
  await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
}

/**
 * Charge utile de création **sans** le tenant — même conversion, et même
 * raison, que dans `payments.repository.ts` : la colonne est `NOT NULL`, et
 * c'est l'extension de scoping qui la pose depuis le contexte.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

function toRefundRecord(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    paymentId: row.paymentId,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    reason: row.reason,
    requestedByUserId: row.requestedByUserId,
    // Le témoin de `payments.types.ts` garantit que les libellés coïncident
    // avec l'énumération générée.
    status: row.status as RefundRecord['status'],
    providerRefundId: row.providerRefundId,
    createdAt: row.createdAt,
  };
}

/** Ce qu'une tentative de réservation a donné. */
export type RefundReservation =
  /** L'encaissement est inconnu de cet établissement. */
  | { readonly outcome: 'payment-not-found' }
  /**
   * L'encaissement existe, mais le montant demandé ferait dépasser le cumul —
   * ou l'appelant a demandé un remboursement total sur un solde déjà nul.
   */
  | { readonly outcome: 'exceeds-captured'; readonly payment: RefundablePayment }
  /** La ligne est inscrite et le montant engagé ; l'ordre peut partir. */
  | {
      readonly outcome: 'reserved';
      readonly payment: RefundablePayment;
      readonly refund: RefundRecord;
    };

/** Ce que l'appelant demande : tout le solde, ou un montant précis. */
export type RefundAmountRequest =
  | { readonly kind: 'remaining' }
  | { readonly kind: 'exact'; readonly amountMinor: number };

@Injectable()
export class RefundsRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Relit un encaissement de l'établissement courant, cumul engagé compris.
   *
   * Hors transaction : sert les refus qui précèdent toute écriture — un
   * encaissement en espèces, un encaissement jamais capturé. Le contrôle du
   * cumul, lui, se refait **dans** la transaction de `reserve` : celui-ci n'est
   * qu'un message plus juste, jamais la garantie.
   */
  public async findRefundable(paymentId: string): Promise<RefundablePayment | null> {
    // `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
    // `where`, et `findUnique` exige que le `where` désigne exactement une clé
    // unique déclarée. Même raison que dans `payments.repository.ts`.
    const row = await this.prisma.payment.findFirst({
      where: { id: paymentId },
      select: REFUNDABLE_PAYMENT_SELECT,
    });

    if (row === null) {
      return null;
    }

    const reserved = await this.prisma.paymentRefund.aggregate({
      where: { paymentId, status: { in: [...RESERVING_REFUND_STATUSES] } },
      _sum: { amountMinor: true },
    });

    return toRefundablePayment(row, reserved._sum.amountMinor ?? 0);
  }

  /**
   * Vérifie le cumul et réserve le montant, en une seule transaction.
   *
   * Rend `exceeds-captured` plutôt que de lever : le dépassement est un refus
   * métier ordinaire — le comptoir a demandé plus que ce qui reste —, et le
   * service a besoin de l'encaissement relu pour composer un message qui dise
   * combien il restait.
   *
   * Un échec de sérialisation (`40001`) est **réessayé**, jusqu'à
   * `MAX_RESERVE_ATTEMPTS`. C'est la conduite que `SERIALIZABLE` appelle : la
   * perdante d'une course recommence, et relit alors la réservation que la
   * gagnante vient d'inscrire — donc le bon cumul. La laisser remonter aurait
   * rendu un 500 à un comptoir qui n'a rien fait de mal, là où le contrat
   * annonce soit le remboursement, soit un 422 qui dit ce qui reste.
   *
   * Réessayer est **sans danger ici**, et c'est ce qui distingue cette
   * transaction de l'appel au prestataire : elle n'écrit qu'en base et ne fait
   * bouger aucun argent. Une tentative avortée n'a, par définition d'un
   * `ROLLBACK`, rien laissé derrière elle.
   */
  public async reserve(
    paymentId: string,
    request: RefundAmountRequest,
    draft: Omit<RefundDraft, 'paymentId' | 'amount'>,
  ): Promise<RefundReservation> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.reserveOnce(paymentId, request, draft);
      } catch (error: unknown) {
        if (!isSerializationFailure(error) || attempt >= MAX_RESERVE_ATTEMPTS) {
          throw error;
        }
        await backOff(attempt);
      }
    }
  }

  /** Une tentative de réservation, sans interprétation de son échec. */
  private async reserveOnce(
    paymentId: string,
    request: RefundAmountRequest,
    draft: Omit<RefundDraft, 'paymentId' | 'amount'>,
  ): Promise<RefundReservation> {
    return this.prisma.$transaction(
      async (tx): Promise<RefundReservation> => {
        const row = await tx.payment.findFirst({
          where: { id: paymentId },
          select: REFUNDABLE_PAYMENT_SELECT,
        });

        if (row === null) {
          return { outcome: 'payment-not-found' };
        }

        const reserved = await tx.paymentRefund.aggregate({
          where: { paymentId, status: { in: [...RESERVING_REFUND_STATUSES] } },
          _sum: { amountMinor: true },
        });

        const payment = toRefundablePayment(row, reserved._sum.amountMinor ?? 0);
        const remaining = payment.amount.amountMinor - payment.alreadyRefundedMinor;
        const amountMinor = request.kind === 'remaining' ? remaining : request.amountMinor;

        // Le zéro est refusé au même titre que le dépassement : un
        // remboursement total sur un solde épuisé n'a rien à rendre, et
        // `payment_refunds_amount_minor_check` refuserait de toute façon la
        // ligne en base — mieux vaut un 422 qui dit ce qui reste qu'un 500 qui
        // cite une contrainte.
        if (amountMinor <= 0 || amountMinor > remaining) {
          return { outcome: 'exceeds-captured', payment };
        }

        const created = await tx.paymentRefund.create({
          data: withScopedTenant<Prisma.PaymentRefundUncheckedCreateInput>({
            paymentId,
            amountMinor,
            // La devise de l'encaissement, jamais une seconde : en inventer une
            // ouvrirait la porte à un cumul qui additionne deux monnaies.
            currency: payment.amount.currency,
            reason: draft.reason,
            requestedByUserId: draft.requestedByUserId,
            // `PENDING` : la ligne engage le montant, l'ordre n'est pas encore
            // parti. `status` n'est pas un paramètre — cette écriture n'a qu'un
            // sens.
            status: 'PENDING',
          }),
          select: REFUND_SELECT,
        });

        return { outcome: 'reserved', payment, refund: toRefundRecord(created) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Inscrit l'acceptation du prestataire sur une réservation.
   *
   * `status: 'PENDING'` dans le `where` est un test-et-pose atomique : une
   * réservation déjà conclue — par une reprise, par un second appel — n'est pas
   * réécrite. Rend `null` dans ce cas, et l'appelant relit la ligne plutôt que
   * de supposer.
   */
  public async markAccepted(refundId: string, providerRefundId: string): Promise<RefundRecord | null> {
    const { count } = await this.prisma.paymentRefund.updateMany({
      where: { id: refundId, status: 'PENDING' },
      data: { status: 'SUCCEEDED', providerRefundId },
    });

    return count === 0 ? null : this.findById(refundId);
  }

  /**
   * Relâche une réservation que le prestataire a refusée.
   *
   * Le montant redevient remboursable : `FAILED` est exclu de la somme
   * réservée. Sans cette écriture, un refus du prestataire immobiliserait la
   * somme pour toujours — le comptoir ne pourrait plus rendre l'argent par
   * aucun moyen.
   */
  public async markFailed(refundId: string): Promise<void> {
    await this.prisma.paymentRefund.updateMany({
      where: { id: refundId, status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  }

  /** Une ligne de remboursement de l'établissement courant, ou `null`. */
  public async findById(refundId: string): Promise<RefundRecord | null> {
    const row = await this.prisma.paymentRefund.findFirst({
      where: { id: refundId },
      select: REFUND_SELECT,
    });

    return row === null ? null : toRefundRecord(row);
  }
}

/** L'encaissement et son cumul engagé, dans la forme que le domaine lit. */
function toRefundablePayment(
  row: {
    id: string;
    amountMinor: number;
    refundedAmountMinor: number;
    currency: string;
    method: string;
    status: string;
    providerPaymentIntentId: string | null;
  },
  reservedMinor: number,
): RefundablePayment {
  return {
    id: row.id,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    method: row.method as RefundablePayment['method'],
    status: row.status as RefundablePayment['status'],
    providerPaymentIntentId: row.providerPaymentIntentId,
    // Le plus grand des deux comptes : nos réservations couvrent le webhook en
    // retard, le webhook couvre un remboursement fait à la main dans le tableau
    // de bord du prestataire. Voir `RefundablePayment`.
    alreadyRefundedMinor: Math.max(reservedMinor, row.refundedAmountMinor),
  };
}
