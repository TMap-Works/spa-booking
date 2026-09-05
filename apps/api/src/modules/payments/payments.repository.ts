import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import { createdAtWithin } from './history';
import type {
  CardPaymentDraft,
  CashPaymentDraft,
  PayableAppointment,
  PaymentHistoryFilter,
  PaymentRecord,
  PaymentTransaction,
} from './payments.types';

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

/**
 * Ce que l'historique de rapprochement lit d'un encaissement (#62).
 *
 * Quatre colonnes de plus que `PAYMENT_SELECT`, et chacune sert le rapprochement
 * plutôt que le tunnel : la référence de charge, qui est ce qui figure sur un
 * relevé Stripe ; l'instant de capture, qui décide du jour de caisse ; le cumul
 * remboursé, sans lequel aucun total ne tombe juste ; et l'instant d'ouverture,
 * qui est la clé de tri.
 *
 * Toujours une projection explicite, jamais la ligne entière : ce qu'on ne lit
 * pas ne peut pas fuiter.
 */
const PAYMENT_TRANSACTION_SELECT = {
  ...PAYMENT_SELECT,
  refundedAmountMinor: true,
  providerChargeId: true,
  capturedAt: true,
  createdAt: true,
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

type PaymentTransactionRow = PaymentRow & {
  refundedAmountMinor: number;
  providerChargeId: string | null;
  capturedAt: Date | null;
  createdAt: Date;
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

function toPaymentTransaction(row: PaymentTransactionRow): PaymentTransaction {
  return {
    ...toPaymentRecord(row),
    // Le remboursement porte **la devise de l'encaissement** : il n'y en a
    // qu'une par ligne, et en inventer une seconde ouvrirait la porte à un total
    // qui additionne deux monnaies.
    refunded: { amountMinor: row.refundedAmountMinor, currency: row.currency },
    providerChargeId: row.providerChargeId,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
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

  /**
   * L'encaissement de ce rendez-vous, sous sa forme de rapprochement.
   *
   * Le pendant de `findPaymentByAppointment` pour le comptoir : c'est cette
   * forme-là que la caisse rend, et la relire ainsi évite qu'un deuxième clic
   * reçoive une réponse de forme différente du premier.
   */
  public async findTransactionByAppointment(
    appointmentId: string,
  ): Promise<PaymentTransaction | null> {
    const row = await this.prisma.payment.findFirst({
      where: { appointmentId },
      select: PAYMENT_TRANSACTION_SELECT,
    });

    return row === null ? null : toPaymentTransaction(row);
  }

  /**
   * Inscrit un règlement en espèces au comptoir (#62).
   *
   * **Aucun appel Stripe n'a précédé cette écriture, et aucun ne la suivra** :
   * il n'y a pas de paramètre pour une référence de prestataire, et
   * `provider_payment_intent_id` reste donc `null` — ce `null` est exactement ce
   * qui distingue, à la reprise comme au rapprochement, un billet d'une carte.
   *
   * `method` et `status` ne sont pas des paramètres, pour la même raison que
   * dans `recordCardIntent` : cette écriture n'a qu'un sens. Mais le statut y est
   * l'inverse — `SUCCEEDED` **dès l'écriture**, là où la carte naît `PENDING`.
   * Il n'y a aucun tiers dont on attendrait la confirmation : l'argent est sur
   * le comptoir au moment où la requête part, et c'est la caisse qui fait foi
   * (payments-stripe §4). `captured_at` est posé du même geste, parce qu'un
   * encaissement abouti sans instant de capture serait irréconciliable.
   *
   * Rend `null` — et non une erreur — quand la ligne existe déjà, comme
   * `recordCardIntent` : `@@unique([tenantId, appointmentId])` tranche la course
   * de deux comptoirs, ou le double clic d'un seul, et le service relit alors la
   * ligne gagnante. Un rendez-vous n'a qu'un encaissement, et ce n'est pas la
   * vigilance de ce fichier qui le garantit.
   */
  public async recordCashPayment(draft: CashPaymentDraft): Promise<PaymentTransaction | null> {
    try {
      const row = await this.prisma.payment.create({
        data: withScopedTenant<Prisma.PaymentUncheckedCreateInput>({
          appointmentId: draft.appointmentId,
          amountMinor: draft.amount.amountMinor,
          currency: draft.amount.currency,
          method: 'CASH',
          status: 'SUCCEEDED',
          capturedAt: new Date(),
        }),
        select: PAYMENT_TRANSACTION_SELECT,
      });

      return toPaymentTransaction(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Une page de l'historique des transactions de l'établissement courant (#62).
   *
   * ## Ce que l'index sert, et ce qu'il ne sert pas
   *
   * `@@index([tenantId, status, createdAt])` et `@@index([tenantId, createdAt])`
   * existent tous deux sur `payments`. Le tri par `created_at` décroissant, dans
   * un établissement, avec ou sans filtre de statut, tombe donc sur un B-tree —
   * ce qui est le cas dominant : l'écran de caisse ouvre sur les dernières
   * transactions. Un filtre par **moyen** seul, lui, n'a pas d'index dédié ; il
   * filtre à l'intérieur de l'ensemble déjà borné à l'établissement et à sa
   * fenêtre, et non de la table.
   *
   * ## Pourquoi `$transaction` autour des deux requêtes
   *
   * La page et son total sont lus dans la même transaction, **en lecture
   * répétable** — même raison que dans `crm.repository.ts` : sans elle, un
   * encaissement concurrent entre les deux donnerait un `totalItems` qui ne
   * correspond à aucune des pages rendues, et une caisse qui ne se referme
   * jamais tout à fait. Le défaut de PostgreSQL, `READ COMMITTED`, prend un
   * instantané **par instruction** : la transaction seule ne suffirait pas.
   *
   * L'identifiant départage deux encaissements du même instant. Sans ce second
   * critère, deux lignes créées dans la même milliseconde peuvent changer de
   * page d'un appel à l'autre — l'une disparaît de la pagination pendant que
   * l'autre s'y répète.
   */
  public async listTransactions(
    filter: PaymentHistoryFilter,
  ): Promise<{ items: PaymentTransaction[]; totalItems: number }> {
    const where = transactionWhere(filter);

    const [rows, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.payment.findMany({
          where,
          select: PAYMENT_TRANSACTION_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (filter.page - 1) * filter.pageSize,
          take: filter.pageSize,
        }),
        this.prisma.payment.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { items: rows.map((row) => toPaymentTransaction(row)), totalItems };
  }
}

/**
 * Le `where` de l'historique — **sans `tenantId`**, que l'extension ajoute.
 *
 * La fenêtre vient de `createdAtWithin`, partagée avec `saleWhere` : la borne
 * haute y est exclue, ce qui permet de poser deux journées de caisse bout à bout
 * sans compter deux fois l'encaissement de minuit — et les deux historiques du
 * même ticket ne peuvent pas avoir deux idées d'un jour de caisse.
 *
 * Chaque critère absent n'ajoute **rien** au `where` plutôt qu'un `undefined` :
 * Prisma traite les deux pareil, mais un objet qui ne porte que ce qui filtre
 * réellement se lit — et se journalise — sans avoir à déduire ce qui est actif.
 */
function transactionWhere(filter: PaymentHistoryFilter): Prisma.PaymentWhereInput {
  const createdAt = createdAtWithin(filter);

  return {
    ...(filter.method === undefined ? {} : { method: filter.method }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}
