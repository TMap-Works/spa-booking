import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { requireTenantId } from '../../common/tenant/tenant-context';
import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import {
  PAYMENT_TRANSACTION_SELECT,
  toPaymentTransaction,
  type PaymentTransactionRow,
} from './payments.repository';
import type { CounterSettlementOutcome, Money, SaleSettlement } from './payments.types';
import type { SaleDraft } from './pos.types';
import { allocateReceiptNumber } from './receipt.numbering';
import { planSettlement, type SaleBalance, type SettlementRequest } from './settlement.rules';

/**
 * Le règlement d'un ticket — le seul endroit du module qui écrive à la fois
 * dans `payments` et dans `sales` (#817).
 *
 * ## Pourquoi un dépôt à part, et non une méthode de plus sur `PosRepository`
 *
 * Pour la raison qui a déjà valu à `RefundsRepository` d'exister : ce fichier
 * porte **une** opération, et c'est une opération atomique. Lire ce qui reste
 * dû, inscrire l'encaissement et avancer le compte du ticket ne sont pas trois
 * gestes qu'un service enchaîne — ce sont trois lectures-écritures qui doivent
 * se sérialiser entre elles, sans quoi le troisième critère de #817 ne tient
 * plus.
 *
 * ## Contrainte en base **et** verrou transactionnel — jamais l'un sans l'autre
 *
 * C'est la conduite que CLAUDE.md impose au double encaissement comme à la
 * double réservation, et elle se lit en deux endroits :
 *
 * - `sales_settled_amount_minor_check` rend l'écriture de trop **impossible**.
 *   Même si ce fichier se trompait, la base refuserait ;
 * - `SELECT … FOR UPDATE` sur la ligne `sales` sérialise les règlements
 *   concurrents. Le second attend, relit le compte que le premier vient de
 *   valider — `READ COMMITTED` relit la ligne après avoir pris le verrou — et
 *   conclut proprement « déjà soldé » plutôt que de se heurter au `CHECK`.
 *
 * `Serializable` aurait tenu l'invariant aussi, mais au prix d'un `40001` à
 * traduire : le comptoir aurait reçu une panne là où il doit recevoir un 409.
 * Le verrou de ligne donne le refus juste, et la contrainte reste le filet.
 *
 * ## Pourquoi du SQL brut pour ce verrou
 *
 * `FOR UPDATE` ne s'exprime pas dans l'API de Prisma. La requête porte donc son
 * propre prédicat d'établissement — `$queryRaw` ne traverse pas l'extension de
 * scoping (`tenant-scope.extension.ts`, ADR 0006) —, et sa valeur vient de
 * `requireTenantId()`, c'est-à-dire du contexte de requête et jamais d'un
 * paramètre que l'appelant choisirait (tenant-isolation §2). Une vente du salon
 * voisin est donc *introuvable*, et le service répond 404.
 *
 * Toutes les autres écritures passent par l'API de Prisma, donc par le client
 * **scopé** : `tenant_id` y est posé par l'extension, et aucune requête d'ici
 * ne peut l'oublier. **Aucun `prismaUnscoped`** n'est injecté : rien de ce
 * fichier n'est légitimement inter-tenant.
 *
 * ## Ce qui compte dans `settled_amount_minor`
 *
 * Ce qui a été **capturé**, et cela seul : un règlement de comptoir naît
 * `SUCCEEDED`, et c'est le webhook `payment_intent.succeeded` qui fait avancer
 * le compte pour une carte en ligne. Une intention en vol ne réserve donc rien,
 * et c'est délibéré : une carte refusée ne doit pas condamner le ticket. Ce que
 * cela laisse ouvert — un ticket réglé au comptoir pendant qu'une intention est
 * en vol — est fermé un cran plus haut, par le refus d'un règlement de comptoir
 * sur un ticket qui porte une intention vivante ({@link hasLiveCardIntent}).
 */

/** Ce que le verrou de ligne rapporte du ticket. */
interface LockedSaleRow {
  readonly id: string;
  readonly total: number;
  readonly settled: number;
  readonly settledAt: Date | null;
  readonly currency: string;
}

/** Une transaction du client scopé — le type que Prisma donne au rappel. */
type ScopedTransaction = Parameters<Parameters<ScopedPrismaClient['$transaction']>[0]>[0];

/**
 * Charge utile de création **sans** le tenant — même conversion, et même
 * raison, que dans `pos.repository.ts` et `payments.repository.ts`.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

@Injectable()
export class SettlementRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * Règle un ticket existant — le quatrième critère de #817.
   *
   * @param saleId le ticket, désigné par l'URL et jamais par le corps.
   * @param request ce que le comptoir demande : un moyen, et au plus une part.
   */
  public async settleSale(
    saleId: string,
    request: SettlementRequest,
  ): Promise<CounterSettlementOutcome> {
    return this.prisma.$transaction(async (tx) => this.apply(tx, saleId, request));
  }

  /**
   * Compose la vente d'un rendez-vous si elle n'existe pas, puis la règle —
   * **dans une seule transaction**, comme le deuxième critère l'exige.
   *
   * L'atomicité n'est pas une élégance : une vente composée dont le règlement
   * échouerait laisserait au comptoir un ticket ouvert que personne n'a demandé,
   * et le geste suivant en composerait un second.
   *
   * ## Le verrou porte sur le rendez-vous, parce que la vente n'existe pas
   * encore
   *
   * On ne verrouille pas une ligne qu'on s'apprête à créer. Deux comptoirs qui
   * encaissent le même rendez-vous au même instant liraient tous deux « pas de
   * ticket » et en écriraient deux — puis en règleraient deux. Un verrou
   * consultatif de transaction, porté par le couple (établissement,
   * rendez-vous), les sérialise : c'est le même geste que
   * `appointments.repository.ts` fait sur l'agenda d'un praticien avant de
   * poser un rendez-vous, et pour exactement la même raison.
   *
   * Le second entrant trouve alors le ticket du premier, et le verrou de ligne
   * de {@link apply} lui oppose « déjà soldé ».
   *
   * @param composesTicket `true` lorsque le brouillon porte des lignes que
   * l'appelant a demandées en plus de la prestation. Le ticket doit alors être
   * **composé par cet appel** : s'il en existait déjà un, ses totaux sont figés
   * et les lignes ajoutées n'y entreraient pas — le refus vaut mieux que la
   * marchandise non facturée.
   */
  public async settleAppointment(
    appointmentId: string,
    draft: SaleDraft,
    request: SettlementRequest,
    composesTicket = false,
  ): Promise<CounterSettlementOutcome> {
    const tenantId = requireTenantId('Sale', 'settleAppointment');

    return this.prisma.$transaction(async (tx) => {
      await this.lockAppointmentTicket(tx, tenantId, appointmentId);

      const sale = await this.findOrCreateAppointmentSale(tx, appointmentId, draft);

      if (composesTicket && !sale.created) {
        return { outcome: 'ticket-already-open', saleId: sale.id };
      }

      return this.apply(tx, sale.id, request);
    });
  }

  /**
   * Le ticket d'un rendez-vous, composé au besoin — pour l'intention en ligne.
   *
   * Le tunnel public a besoin de la **vente**, pas de son règlement : c'est le
   * webhook qui conclura. Cette méthode lui donne donc l'identifiant du ticket
   * à inscrire sur l'intention, sous le même verrou consultatif que
   * {@link settleAppointment} — deux onglets ouverts sur le même rendez-vous ne
   * doivent pas produire deux tickets.
   */
  public async ticketForAppointment(appointmentId: string, draft: SaleDraft): Promise<string> {
    const tenantId = requireTenantId('Sale', 'ticketForAppointment');

    return this.prisma.$transaction(async (tx) => {
      await this.lockAppointmentTicket(tx, tenantId, appointmentId);

      const sale = await this.findOrCreateAppointmentSale(tx, appointmentId, draft);

      return sale.id;
    });
  }

  /**
   * Ce qui reste dû sur le ticket d'un rendez-vous — **une lecture, sans
   * verrou**, pour le refus que le tunnel en ligne oppose avant d'appeler le
   * prestataire.
   *
   * Elle existe parce qu'un règlement de comptoir n'écrit plus
   * `payments.appointment_id` : `findPaymentByAppointment` ne le voit donc pas,
   * et sans cette lecture un rendez-vous déjà réglé à la caisse pourrait
   * recevoir une seconde intention Stripe — la cliente paierait deux fois.
   *
   * `null` quand le rendez-vous n'a pas encore de ticket, ce qui est le cas
   * courant : il n'y a alors rien à refuser.
   */
  public async appointmentTicketBalance(
    appointmentId: string,
  ): Promise<{ readonly saleId: string; readonly remainingAmountMinor: number } | null> {
    const sale = await this.prisma.sale.findFirst({
      where: { appointmentId },
      select: { id: true, totalAmountMinor: true, settledAmountMinor: true },
      // Le plus récent, comme {@link findOrCreateAppointmentSale} : c'est celui
      // qui décrit ce que la cliente doit.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (sale === null) {
      return null;
    }

    return {
      saleId: sale.id,
      remainingAmountMinor: Math.max(0, sale.totalAmountMinor - sale.settledAmountMinor),
    };
  }

  /**
   * Le verrou consultatif du ticket d'un rendez-vous.
   *
   * `hashtextextended` plutôt que `hashtext` : le premier rend un `bigint`,
   * c'est-à-dire l'espace entier de la clé de verrou, là où le second se
   * replierait sur 32 bits et multiplierait les collisions. La clé nomme
   * l'établissement **et** le rendez-vous : deux salons qui encaissent en même
   * temps ne s'attendent pas l'un l'autre.
   *
   * Le préfixe `sale:` sépare cet espace de celui des agendas
   * (`appointments.repository.ts`) : deux familles de verrous qui partageraient
   * leur espace de hachage se bloqueraient pour rien.
   */
  private async lockAppointmentTicket(
    tx: ScopedTransaction,
    tenantId: string,
    appointmentId: string,
  ): Promise<void> {
    const key = `sales:tenant_id=${tenantId}:appointment_id=${appointmentId}`;

    // eslint-disable-next-line tenant/raw-sql-tenant-filter -- Ce SQL ne lit ni n'écrit aucune ligne : il prend un verrou consultatif dont la clé porte le tenant, transmis en paramètre lié (`key`). Il n'y a pas de `WHERE` à filtrer.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0::bigint))`;
  }

  /**
   * Le ticket du rendez-vous, ou celui qu'on vient d'écrire pour lui.
   *
   * La lecture prend le **plus récent** : un rendez-vous n'a qu'un ticket
   * depuis que le verrou ci-dessus existe, mais les bases d'avant #817 peuvent
   * en porter plusieurs, et c'est le dernier composé qui décrit ce que la
   * cliente doit.
   */
  private async findOrCreateAppointmentSale(
    tx: ScopedTransaction,
    appointmentId: string,
    draft: SaleDraft,
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    const existing = await tx.sale.findFirst({
      where: { appointmentId },
      select: { id: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    if (existing !== null) {
      // Le brouillon est **écarté** : une vente écrite ne se recompose pas. Dire
      // à l'appelant que le ticket préexistait est l'affaire de
      // {@link settleAppointment}, qui seul sait si le brouillon portait des
      // lignes qu'on vient de perdre.
      return { id: existing.id, created: false };
    }

    const sale = await tx.sale.create({
      data: withScopedTenant<Prisma.SaleUncheckedCreateInput>({
        appointmentId,
        cashierUserId: draft.cashierUserId,
        subtotalAmountMinor: draft.subtotalAmountMinor,
        taxAmountMinor: draft.taxAmountMinor,
        taxRateBps: draft.taxRateBps,
        tipAmountMinor: draft.tipAmountMinor,
        totalAmountMinor: draft.totalAmountMinor,
        currency: draft.currency,
      }),
      select: { id: true },
    });

    await tx.saleItem.createMany({
      data: draft.items.map((item) =>
        withScopedTenant<Prisma.SaleItemUncheckedCreateInput>({
          saleId: sale.id,
          kind: item.kind,
          serviceId: item.serviceId,
          productId: item.productId,
          label: item.label,
          quantity: item.quantity,
          unitAmountMinor: item.unitAmount.amountMinor,
          lineAmountMinor: item.lineAmount.amountMinor,
          currency: item.lineAmount.currency,
          position: item.position,
        }),
      ),
    });

    return { id: sale.id, created: true };
  }

  /**
   * Le règlement proprement dit, sous le verrou de la ligne `sales`.
   *
   * L'ordre des gestes est celui-ci et ne peut pas être autre :
   *
   * 1. **verrouiller** la ligne et relire ses montants — c'est ce qui fait que
   *    deux comptoirs ne lisent pas le même reste dû ;
   * 2. refuser si une intention carte est encore en vol ;
   * 3. **planifier** le geste sur l'état verrouillé (`settlement.rules.ts`) ;
   * 4. inscrire l'encaissement, puis avancer le compte du ticket. Si le plan
   *    est faux, `sales_settled_amount_minor_check` annule la transaction
   *    entière : rien de faux n'est écrit, même à moitié.
   */
  private async apply(
    tx: ScopedTransaction,
    saleId: string,
    request: SettlementRequest,
  ): Promise<CounterSettlementOutcome> {
    const sale = await this.lockSale(tx, saleId);

    if (sale === null) {
      return { outcome: 'sale-not-found' };
    }

    if (await this.hasLiveCardIntent(tx, saleId)) {
      return { outcome: 'card-intent-in-flight' };
    }

    const balance: SaleBalance = {
      totalAmountMinor: sale.total,
      settledAmountMinor: sale.settled,
      settledAt: sale.settledAt,
    };

    const plan = planSettlement(balance, request);

    if (plan.outcome !== 'apply') {
      return plan.outcome === 'already-settled'
        ? { outcome: 'already-settled', settledAt: plan.settledAt }
        : { outcome: 'overpayment', remainingAmountMinor: plan.remainingAmountMinor };
    }

    const capturedAt = new Date();

    // **Le numéro de pièce est pris ici, et seulement si ce geste solde le
    // ticket** — #818, premier critère. Dans cette transaction, donc sous le
    // verrou du compteur, et donc annulé avec elle si l'écriture qui suit se
    // heurte à `sales_settled_amount_minor_check` : un règlement refusé ne perce
    // pas la suite. Un versement partiel, lui, ne prend rien — un ticket réglé
    // en trois fois est **une** pièce, pas trois.
    const receiptNumber = plan.settlesSale ? await allocateReceiptNumber(tx) : null;

    const payment = await tx.payment.create({
      data: withScopedTenant<Prisma.PaymentUncheckedCreateInput>({
        // Aucun `appointmentId` : le rendez-vous est porté par le ticket, et
        // l'unique par rendez-vous refuserait le second règlement d'une même
        // vente (schéma, `Payment.appointmentId`).
        saleId,
        amountMinor: plan.appliedAmountMinor,
        // La devise du ticket, relue sous le verrou : jamais celle de
        // l'appelant, qui n'a pas de champ pour l'envoyer.
        currency: sale.currency,
        method: request.method,
        // `SUCCEEDED` dès l'écriture : il n'y a aucun tiers dont on attendrait
        // la confirmation au comptoir, et la caisse fait foi
        // (payments-stripe §4). `captured_at` du même geste — un encaissement
        // abouti sans instant de capture serait irréconciliable.
        status: 'SUCCEEDED',
        capturedAt,
        // Ce que la cliente a tendu, quand elle a tendu plus que le dû — #818,
        // cinquième critère. La monnaie rendue n'est pas stockée : elle se
        // déduit de `tendered − amount`, et inscrire les deux aurait rendu
        // représentable une monnaie incohérente avec le billet. Rien n'est écrit
        // quand l'appoint est exact, ni sur un passage au terminal :
        // `payments_tendered_amount_minor_check` refuse d'ailleurs le second.
        ...(request.tenderedAmountMinor === undefined || plan.changeAmountMinor === 0
          ? {}
          : { tenderedAmountMinor: request.tenderedAmountMinor }),
      }),
      select: PAYMENT_TRANSACTION_SELECT,
    });

    const settled = sale.settled + plan.appliedAmountMinor;

    await tx.sale.updateMany({
      where: { id: saleId },
      data: {
        settledAmountMinor: settled,
        ...(plan.settlesSale ? { settledAt: capturedAt } : {}),
        ...(receiptNumber === null ? {} : { receiptNumber }),
      },
    });

    return {
      outcome: 'settled',
      settlement: this.toSettlement(sale, payment, settled, plan.changeAmountMinor, {
        settlesSale: plan.settlesSale,
        capturedAt,
      }),
    };
  }

  /**
   * `true` si une intention carte est encore en vol sur ce ticket.
   *
   * Ce n'est **pas** l'invariant de double encaissement — celui-là est tenu par
   * `sales_settled_amount_minor_check` et par le verrou de ligne. C'est une
   * garde d'un cran au-dessus, et elle existe parce qu'une intention `PENDING`
   * ne réserve rien : entre la création de l'intention et le webhook qui la
   * conclut, le compte du ticket n'a pas bougé, et le comptoir pourrait
   * encaisser un ticket que la cliente est en train de payer en ligne.
   *
   * L'inverse — réserver dès l'intention — a été écarté : une carte refusée
   * aurait alors condamné le ticket jusqu'à ce qu'un webhook relâche la somme,
   * et un refus de banque est un incident ordinaire qui ne doit pas coûter la
   * vente (`payments.service.ts`, `RESUMABLE_PAYMENT_STATUSES`).
   *
   * Le remède, quand cela arrive, est celui du comptoir : annuler l'intention,
   * ce qui relève de #63.
   */
  private async hasLiveCardIntent(tx: ScopedTransaction, saleId: string): Promise<boolean> {
    const live = await tx.payment.findFirst({
      where: { saleId, method: 'CARD', status: 'PENDING' },
      select: { id: true },
    });

    return live !== null;
  }

  /**
   * Verrouille la ligne du ticket et rend ses montants — ou `null` si aucune
   * ligne de cet établissement ne porte cet identifiant.
   *
   * Le prédicat d'établissement est écrit à la main : `$queryRaw` ne repasse
   * pas par l'extension de scoping, et la garde `tenant/raw-sql-tenant-filter`
   * vérifie mécaniquement sa présence.
   */
  private async lockSale(tx: ScopedTransaction, saleId: string): Promise<LockedSaleRow | null> {
    const tenantId = requireTenantId('Sale', 'settle');

    const rows = await tx.$queryRaw<readonly LockedSaleRow[]>`
      SELECT
        "id",
        "total_amount_minor" AS "total",
        "settled_amount_minor" AS "settled",
        "settled_at" AS "settledAt",
        "currency"
      FROM "sales"
      WHERE "tenant_id" = ${tenantId}::uuid
        AND "id" = ${saleId}::uuid
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  /**
   * Compose l'issue rendue au service — la ligne inscrite, l'état du ticket
   * après elle, et la monnaie à rendre.
   */
  private toSettlement(
    sale: LockedSaleRow,
    payment: PaymentTransactionRow,
    settledAmountMinor: number,
    changeAmountMinor: number,
    marks: { readonly settlesSale: boolean; readonly capturedAt: Date },
  ): SaleSettlement {
    return {
      payment: toPaymentTransaction(payment),
      saleId: sale.id,
      total: money(sale.total, sale.currency),
      settled: money(settledAmountMinor, sale.currency),
      remaining: money(sale.total - settledAmountMinor, sale.currency),
      change: money(changeAmountMinor, sale.currency),
      settledAt: marks.settlesSale ? marks.capturedAt : null,
    };
  }
}
