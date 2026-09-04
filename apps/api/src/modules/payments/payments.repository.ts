import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import type { CardPaymentDraft, PayableAppointment, PaymentRecord } from './payments.types';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une requête d'ici
 * ait à le répéter — donc sans qu'aucune puisse l'oublier. Le module n'a
 * **aucune** dérogation : rien ici n'est légitimement inter-tenant, et
 * `prismaUnscoped` n'y est donc pas injecté du tout.
 *
 * C'est ce scoping, et lui seul, qui fait qu'un rendez-vous du salon voisin est
 * introuvable plutôt qu'interdit : `findPayableAppointment` rend `null`, le
 * service lève `NotFoundError`, la route répond 404 — jamais 403, qui
 * confirmerait l'existence de la ressource (tenant-isolation §4).
 *
 * ## Pourquoi ce repository lit la table `appointments`
 *
 * Le montant à encaisser est le prix **figé à la réservation**, et il n'existe
 * que là. Le chemin conforme serait un appel de service
 * (`AppointmentsService`, api-module §3), mais ce module n'expose aujourd'hui
 * que `book`, `reschedule`, `cancel` et `listForClient` : il n'y a pas de
 * lecture par identifiant à appeler. Cette lecture-ci est donc directe, bornée
 * à trois colonnes non personnelles, et **n'écrit rien** dans `appointments`.
 *
 * TODO(#57) : à remplacer par `AppointmentsService.findById` le jour où le
 * module voisin l'expose — une issue de suivi porte la dette.
 */

/** Violation de contrainte d'unicité — ici, `@@unique([tenantId, appointmentId])`. */
const UNIQUE_VIOLATION = 'P2002';

/** `true` si l'erreur est le refus d'unicité de PostgreSQL, traduit par Prisma. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

/**
 * Les trois colonnes du rendez-vous dont l'encaissement a besoin.
 *
 * Une projection explicite, et non la ligne entière : `appointments` porte les
 * notes de la cliente et celles du praticien, qui n'ont rien à faire dans le
 * module qui parle au prestataire de paiement. Ce qu'on ne lit pas ne peut pas
 * fuiter.
 */
const APPOINTMENT_SELECT = {
  id: true,
  status: true,
  priceAmountMinor: true,
  priceCurrency: true,
} as const;

const PAYMENT_SELECT = {
  id: true,
  appointmentId: true,
  amountMinor: true,
  currency: true,
  method: true,
  status: true,
  providerPaymentIntentId: true,
} as const;

type PaymentRow = {
  id: string;
  appointmentId: string | null;
  amountMinor: number;
  currency: string;
  method: string;
  status: string;
  providerPaymentIntentId: string | null;
};

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `catalog.repository.ts` et
 * `appointments.repository.ts` : le type généré exige `tenantId` — la colonne
 * est `NOT NULL` — alors que le repository ne doit justement pas le fournir.
 * C'est l'extension qui le pose depuis le contexte de requête, et qui
 * **écrase** ce qui s'y trouverait.
 *
 * Ce qui rend la conversion sûre n'est pas une promesse : l'extension refuse
 * toute opération sans contexte de tenant, et la colonne n'a pas de valeur par
 * défaut. Si l'extension venait à être contournée, l'insertion échouerait en
 * base — bruyamment, jamais en silence.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    // Les deux énumérations du schéma sont reprises telles quelles : le témoin
    // de `payments.types.ts` garantit que les libellés coïncident.
    method: row.method as PaymentRecord['method'],
    status: row.status as PaymentRecord['status'],
    providerPaymentIntentId: row.providerPaymentIntentId,
  };
}

@Injectable()
export class PaymentsRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Le rendez-vous de l'établissement courant, ou `null`.
   *
   * `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
   * `where`, et `findUnique` exige que le `where` désigne *exactement* une clé
   * unique déclarée. Même raison que dans `catalog.repository.ts`.
   */
  public async findPayableAppointment(appointmentId: string): Promise<PayableAppointment | null> {
    const row = await this.prisma.appointment.findFirst({
      where: { id: appointmentId },
      select: APPOINTMENT_SELECT,
    });

    if (row === null) {
      return null;
    }

    return {
      id: row.id,
      status: row.status,
      price: { amountMinor: row.priceAmountMinor, currency: row.priceCurrency },
    };
  }

  /** L'encaissement déjà rattaché à ce rendez-vous, ou `null`. */
  public async findPaymentByAppointment(appointmentId: string): Promise<PaymentRecord | null> {
    const row = await this.prisma.payment.findFirst({
      where: { appointmentId },
      select: PAYMENT_SELECT,
    });

    return row === null ? null : toPaymentRecord(row);
  }

  /**
   * Inscrit l'intention de paiement créée chez Stripe.
   *
   * Rend `null` — et non une erreur — quand la ligne existe déjà. Ce n'est pas
   * un cas exceptionnel : deux requêtes concurrentes pour le même rendez-vous
   * franchissent toutes deux le contrôle « pas encore d'encaissement », et
   * `@@unique([tenantId, appointmentId])` en refuse une. Le service relit alors
   * la ligne gagnante et rend la même intention aux deux appelants — c'est la
   * base qui tranche l'unicité, jamais une vérification applicative.
   *
   * `method` et `status` ne sont pas des paramètres : cette écriture n'a qu'un
   * sens — une intention carte, en attente. Le passage à `SUCCEEDED` est
   * l'affaire du webhook (#58), et de lui seul (payments-stripe §2).
   */
  public async recordCardIntent(draft: CardPaymentDraft): Promise<PaymentRecord | null> {
    try {
      const row = await this.prisma.payment.create({
        data: withScopedTenant<Prisma.PaymentUncheckedCreateInput>({
          appointmentId: draft.appointmentId,
          amountMinor: draft.amount.amountMinor,
          currency: draft.amount.currency,
          method: 'CARD',
          status: 'PENDING',
          providerPaymentIntentId: draft.providerPaymentIntentId,
        }),
        select: PAYMENT_SELECT,
      });

      return toPaymentRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }
}
