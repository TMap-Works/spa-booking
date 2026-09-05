import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import type { PaymentsRepository } from '../payments.repository';
import type {
  CardPaymentDraft,
  CashPaymentDraft,
  PayableAppointment,
  PaymentHistoryFilter,
  PaymentMethod,
  PaymentRecord,
  PaymentStatus,
  PaymentTransaction,
} from '../payments.types';
import { StripeConfig } from '../stripe/stripe.config';
import type {
  CreatePaymentIntentCommand,
  CreateRefundCommand,
  StripeGateway,
  StripePaymentIntent,
  StripeRefund,
} from '../stripe/stripe.gateway';

/**
 * Doubles du module `payments`, partagés par ses suites unitaires et par ses
 * suites d'intégration et d'isolation.
 *
 * Le dépôt en mémoire reproduit **quatre propriétés précises** du vrai, et
 * chacune porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent, exactement comme l'extension
 *    Prisma le fait en vrai. Un double qui ignorerait le tenant ferait passer
 *    les tests d'isolation pour de mauvaises raisons, ce qui est pire que de ne
 *    pas les écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération. Le
 *    mode ouvert par défaut est ce qui produit les fuites ;
 * 3. l'**unicité `(tenantId, appointmentId)`**, rendue par un `null` de
 *    `recordCardIntent` comme le vrai traduit le code Prisma `P2002` — c'est ce
 *    qui rend la course de deux requêtes concurrentes exerçable ;
 * 4. la **projection** — `findPayableAppointment` ne rend que l'identifiant, le
 *    statut et le prix. Ce que le vrai ne lit pas, le double ne le connaît pas
 *    non plus, faute de quoi un test pourrait s'appuyer sur une donnée que le
 *    module n'a jamais eue.
 *
 * La passerelle Stripe, elle, ne parle **jamais** au réseau : aucun test de ce
 * dépôt n'atteint l'environnement Stripe, live ou test (payments-stripe §7).
 */

interface StoredAppointment {
  tenantId: string;
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
}

interface StoredPayment {
  tenantId: string;
  id: string;
  appointmentId: string | null;
  amountMinor: number;
  refundedAmountMinor: number;
  currency: string;
  method: PaymentMethod;
  status: PaymentStatus;
  providerPaymentIntentId: string | null;
  providerChargeId: string | null;
  capturedAt: Date | null;
  createdAt: Date;
}

/** Sans portée résolue, rien ne passe — c'est la propriété 2. */
function requireTenant(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error(
      'FakePaymentsRepository : aucune portée de tenant ouverte. Le vrai dépôt ' +
        'lèverait `MissingTenantContextError` — un double qui rendrait « toutes ' +
        'les lignes » ferait verdir la fuite qu’on cherche.',
    );
  }

  return tenantId;
}

/**
 * La surface publique du vrai dépôt, et rien d'autre.
 *
 * `Pick` plutôt qu'`implements PaymentsRepository` directement : le vrai porte
 * un champ privé (`prisma`), et TypeScript n'autorise à implémenter un type à
 * membres privés que par héritage. Le témoin qu'on veut ici n'est pas la
 * parenté, c'est la **substituabilité** — une méthode renommée dans le vrai
 * fait échouer la compilation de ce fichier, ce qui est exactement le moment où
 * il faut l'apprendre.
 */
type PaymentsRepositoryPort = Pick<
  PaymentsRepository,
  | 'findPayableAppointment'
  | 'findPaymentByAppointment'
  | 'findTransactionByAppointment'
  | 'recordCardIntent'
  | 'recordCashPayment'
  | 'listTransactions'
>;

export class FakePaymentsRepository implements PaymentsRepositoryPort {
  private readonly appointments: StoredAppointment[] = [];
  private readonly payments: StoredPayment[] = [];

  /**
   * Sème un rendez-vous payable dans un établissement.
   *
   * Le `tenantId` est **explicite** et non pris dans le contexte : une suite de
   * fuite sème chez A pour lire chez B, ce qu'un ensemencement scopé rendrait
   * impossible à écrire.
   */
  public seedAppointment(input: {
    tenantId: string;
    id?: string;
    status?: string;
    amountMinor?: number;
    currency?: string;
  }): StoredAppointment {
    const row: StoredAppointment = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      status: input.status ?? 'PENDING',
      amountMinor: input.amountMinor ?? 7000,
      currency: input.currency ?? 'EUR',
    };
    this.appointments.push(row);
    return row;
  }

  /** Sème un encaissement déjà inscrit — reprise, vente en espèces, remboursement. */
  public seedPayment(input: {
    tenantId: string;
    appointmentId: string | null;
    id?: string;
    amountMinor?: number;
    refundedAmountMinor?: number;
    currency?: string;
    method?: PaymentMethod;
    status?: PaymentStatus;
    providerPaymentIntentId?: string | null;
    providerChargeId?: string | null;
    capturedAt?: Date | null;
    createdAt?: Date;
  }): StoredPayment {
    const row: StoredPayment = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      appointmentId: input.appointmentId,
      amountMinor: input.amountMinor ?? 7000,
      refundedAmountMinor: input.refundedAmountMinor ?? 0,
      currency: input.currency ?? 'EUR',
      method: input.method ?? 'CARD',
      status: input.status ?? 'PENDING',
      providerPaymentIntentId:
        input.providerPaymentIntentId === undefined
          ? `pi_${randomUUID()}`
          : input.providerPaymentIntentId,
      providerChargeId: input.providerChargeId ?? null,
      capturedAt: input.capturedAt ?? null,
      createdAt: input.createdAt ?? new Date(),
    };
    this.payments.push(row);
    return row;
  }

  /** Toutes les lignes, tous établissements confondus — pour l'assertion « intact ». */
  public allPayments(): readonly StoredPayment[] {
    return this.payments;
  }

  public findPayableAppointment(appointmentId: string): Promise<PayableAppointment | null> {
    const tenantId = requireTenant();
    const row = this.appointments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === appointmentId,
    );

    return Promise.resolve(
      row === undefined
        ? null
        : {
            id: row.id,
            status: row.status,
            price: { amountMinor: row.amountMinor, currency: row.currency },
          },
    );
  }

  public findPaymentByAppointment(appointmentId: string): Promise<PaymentRecord | null> {
    const tenantId = requireTenant();
    const row = this.payments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.appointmentId === appointmentId,
    );

    return Promise.resolve(row === undefined ? null : toRecord(row));
  }

  public recordCardIntent(draft: CardPaymentDraft): Promise<PaymentRecord | null> {
    const tenantId = requireTenant();

    // Propriété 3 : l'unicité est tranchée ici, comme la base la tranche.
    if (this.isTaken(tenantId, draft.appointmentId)) {
      return Promise.resolve(null);
    }

    const row: StoredPayment = {
      tenantId,
      id: randomUUID(),
      appointmentId: draft.appointmentId,
      amountMinor: draft.amount.amountMinor,
      refundedAmountMinor: 0,
      currency: draft.amount.currency,
      method: 'CARD',
      status: 'PENDING',
      providerPaymentIntentId: draft.providerPaymentIntentId,
      providerChargeId: null,
      capturedAt: null,
      createdAt: new Date(),
    };
    this.payments.push(row);

    return Promise.resolve(toRecord(row));
  }

  public findTransactionByAppointment(appointmentId: string): Promise<PaymentTransaction | null> {
    const tenantId = requireTenant();
    const row = this.payments.find(
      (candidate) => candidate.tenantId === tenantId && candidate.appointmentId === appointmentId,
    );

    return Promise.resolve(row === undefined ? null : toTransaction(row));
  }

  /**
   * L'écriture du chemin espèces — `CASH`, `SUCCEEDED`, `captured_at` posé,
   * **aucune référence de prestataire**.
   *
   * Le double reproduit ces quatre faits parce qu'ils sont exactement ce qui
   * distingue ce chemin de celui de la carte : un double qui écrirait `PENDING`
   * ferait passer pour vraie une caisse qui attend une confirmation qui ne
   * viendra jamais.
   */
  public recordCashPayment(draft: CashPaymentDraft): Promise<PaymentTransaction | null> {
    const tenantId = requireTenant();

    if (this.isTaken(tenantId, draft.appointmentId)) {
      return Promise.resolve(null);
    }

    const row: StoredPayment = {
      tenantId,
      id: randomUUID(),
      appointmentId: draft.appointmentId,
      amountMinor: draft.amount.amountMinor,
      refundedAmountMinor: 0,
      currency: draft.amount.currency,
      method: 'CASH',
      status: 'SUCCEEDED',
      providerPaymentIntentId: null,
      providerChargeId: null,
      capturedAt: new Date(),
      createdAt: new Date(),
    };
    this.payments.push(row);

    return Promise.resolve(toTransaction(row));
  }

  /**
   * L'historique, trié et paginé comme le vrai le fait.
   *
   * Le tri décroissant sur `createdAt` puis sur l'identifiant reproduit
   * l'`orderBy` du dépôt : sans le second critère, deux encaissements du même
   * instant changeraient de page d'un appel à l'autre, et une suite qui
   * l'ignorerait rendrait le bogue invisible.
   */
  public listTransactions(
    filter: PaymentHistoryFilter,
  ): Promise<{ items: PaymentTransaction[]; totalItems: number }> {
    const tenantId = requireTenant();

    const matching = this.payments
      .filter((candidate) => candidate.tenantId === tenantId)
      .filter((candidate) => filter.method === undefined || candidate.method === filter.method)
      .filter((candidate) => filter.status === undefined || candidate.status === filter.status)
      .filter((candidate) => filter.from === undefined || candidate.createdAt >= filter.from)
      // Borne haute **exclue**, comme le `lt` du vrai.
      .filter((candidate) => filter.to === undefined || candidate.createdAt < filter.to)
      .sort((left, right) => compareDesc(left, right));

    const skip = (filter.page - 1) * filter.pageSize;

    return Promise.resolve({
      items: matching.slice(skip, skip + filter.pageSize).map((row) => toTransaction(row)),
      totalItems: matching.length,
    });
  }

  /** L'unicité `(tenantId, appointmentId)` — `null` ne se gêne pas lui-même. */
  private isTaken(tenantId: string, appointmentId: string): boolean {
    return this.payments.some(
      (candidate) => candidate.tenantId === tenantId && candidate.appointmentId === appointmentId,
    );
  }
}

/** Du plus récent au plus ancien, l'identifiant départageant les ex æquo. */
function compareDesc(left: StoredPayment, right: StoredPayment): number {
  const byInstant = right.createdAt.getTime() - left.createdAt.getTime();

  return byInstant === 0 ? right.id.localeCompare(left.id) : byInstant;
}

function toRecord(row: StoredPayment): PaymentRecord {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    amount: { amountMinor: row.amountMinor, currency: row.currency },
    method: row.method,
    status: row.status,
    providerPaymentIntentId: row.providerPaymentIntentId,
  };
}

function toTransaction(row: StoredPayment): PaymentTransaction {
  return {
    ...toRecord(row),
    refunded: { amountMinor: row.refundedAmountMinor, currency: row.currency },
    providerChargeId: row.providerChargeId,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
  };
}

/**
 * Passerelle Stripe en mémoire — **aucun appel réseau**.
 *
 * Elle reproduit la seule propriété du vrai dont le service dépende :
 * l'**idempotence par clé**. Deux créations avec la même `idempotencyKey`
 * rendent la même intention, comme Stripe le fait pendant 24 heures. C'est ce
 * qui rend exerçable la course de deux requêtes concurrentes sans avoir à
 * simuler un verrou.
 */
export class FakeStripeGateway implements StripeGateway {
  private readonly byKey = new Map<string, StripePaymentIntent>();
  private readonly byId = new Map<string, StripePaymentIntent>();

  private readonly refundsByKey = new Map<string, StripeRefund>();

  /** Les commandes reçues, dans l'ordre — pour vérifier montant et métadonnées. */
  public readonly commands: CreatePaymentIntentCommand[] = [];
  /** Les identifiants relus, dans l'ordre — pour prouver qu'une reprise ne crée rien. */
  public readonly retrieved: string[] = [];
  /** Les ordres de remboursement reçus, dans l'ordre — #63. */
  public readonly refundCommands: CreateRefundCommand[] = [];

  /**
   * Le statut que portera le remboursement créé (#63).
   *
   * Un 2xx de Stripe n'est pas une acceptation : le remboursement peut naître
   * `failed` ou `canceled`. Sans ce réglage, aucune suite ne pourrait exercer le
   * cas où le prestataire répond « créé » et « non abouti » du même geste.
   */
  public refundStatus = 'succeeded';

  /** Pose l'échec du prestataire sur le prochain appel, quel qu'il soit. */
  public failWith: Error | null = null;

  /**
   * Le statut que rendra la **relecture**, quand une suite veut simuler un
   * webhook en retard — Stripe dit « payé » pendant que la ligne dit encore
   * `PENDING`. Sans lui, aucune suite ne pourrait exercer le cas où la source
   * de vérité contredit notre copie.
   */
  public retrievedStatus: string | null = null;

  public createPaymentIntent(
    command: CreatePaymentIntentCommand,
  ): Promise<StripePaymentIntent> {
    this.commands.push(command);

    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }

    const known = this.byKey.get(command.idempotencyKey);

    if (known !== undefined) {
      return Promise.resolve(known);
    }

    const id = `pi_${randomUUID()}`;
    const intent: StripePaymentIntent = {
      id,
      clientSecret: `${id}_secret_${randomUUID()}`,
      status: 'requires_payment_method',
      amountMinor: command.amountMinor,
      currency: command.currency.toLowerCase(),
    };

    this.byKey.set(command.idempotencyKey, intent);
    this.byId.set(id, intent);

    return Promise.resolve(intent);
  }

  public retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
    this.retrieved.push(id);

    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }

    const known = this.byId.get(id);

    if (known !== undefined) {
      return Promise.resolve(
        this.retrievedStatus === null ? known : { ...known, status: this.retrievedStatus },
      );
    }

    // Une intention semée par une suite sans être passée par `create` : rendue
    // telle quelle plutôt qu'en erreur, le service n'ayant à en connaître que
    // le secret.
    const intent: StripePaymentIntent = {
      id,
      clientSecret: `${id}_secret_${randomUUID()}`,
      status: this.retrievedStatus ?? 'requires_payment_method',
      amountMinor: 0,
      currency: 'eur',
    };
    this.byId.set(id, intent);

    return Promise.resolve(intent);
  }

  /**
   * L'ordre de remboursement — #63.
   *
   * Même propriété que la création d'intention, et elle compte davantage ici :
   * rejoué avec la même clé, il rend le **même** remboursement au lieu d'en
   * émettre un second. Un remboursement en double sort de l'argent, là où une
   * intention en double n'en fait qu'entrer une fois de trop.
   */
  public createRefund(command: CreateRefundCommand): Promise<StripeRefund> {
    this.refundCommands.push(command);

    if (this.failWith !== null) {
      return Promise.reject(this.failWith);
    }

    const known = this.refundsByKey.get(command.idempotencyKey);

    if (known !== undefined) {
      return Promise.resolve(known);
    }

    const refund: StripeRefund = {
      id: `re_${randomUUID()}`,
      status: this.refundStatus,
      amountMinor: command.amountMinor,
      currency: 'eur',
    };

    this.refundsByKey.set(command.idempotencyKey, refund);

    return Promise.resolve(refund);
  }
}

/** Les deux clés de test — des chaînes de remplissage, jamais des secrets. */
export const TEST_STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_notasecret_0000000000',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_notasecret_0000000000',
} as const;

/** Une configuration Stripe complète, pour les suites qui n'en testent pas l'absence. */
export function testStripeConfig(): StripeConfig {
  return new StripeConfig({ NODE_ENV: 'test', ...TEST_STRIPE_ENV });
}
