import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { WebhookApplication, StripeWebhookRepository } from '../stripe-webhook.repository';
import type { StripeWebhookEvent, WebhookFact } from '../stripe-webhook.types';

/**
 * Doubles du point d'entrée des webhooks — écrits une fois, partagés par les
 * suites unitaires et par le harnais d'intégration.
 *
 * Le repository est le seul composant réellement doublé : c'est lui qui parle à
 * Prisma. Tout le reste — signature, lecture d'événement, file, contrôleur — est
 * exercé pour de vrai, y compris dans les tests unitaires : ce sont des
 * fonctions pures ou des objets sans dépendance externe, et les doubler
 * reviendrait à tester les doubles.
 */

/** Journal muet qui retient ce qu'on lui a dit — les alertes se vérifient. */
export interface RecordingLogger {
  readonly logger: StructuredLogger;
  readonly warnings: string[];
  readonly errors: string[];
  readonly entries: { level: string; message: string; meta: unknown }[];
}

export function recordingLogger(): RecordingLogger {
  const warnings: string[] = [];
  const errors: string[] = [];
  const entries: { level: string; message: string; meta: unknown }[] = [];

  const record =
    (level: string, sink?: string[]) =>
    (message: unknown, meta?: unknown): void => {
      entries.push({ level, message: String(message), meta });
      sink?.push(String(message));
    };

  const logger = {
    log: record('log'),
    debug: record('debug'),
    verbose: record('verbose'),
    warn: record('warn', warnings),
    error: record('error', errors),
    fatal: record('fatal', errors),
  } as unknown as StructuredLogger;

  return { logger, warnings, errors, entries };
}

/** Une ligne d'encaissement, réduite à ce que le double a besoin de tenir. */
export interface FakePayment {
  readonly tenantId: string;
  readonly paymentIntentId: string;
  chargeId: string | null;
  status: string;
  refundedAmountMinor: number;
  appointmentStatus: string | null;
}

/**
 * Les seuls états depuis lesquels un encaissement devient `SUCCEEDED` — la copie
 * du `status: { in: [...] }` de `StripeWebhookRepository.settle`.
 */
const SETTLEABLE: ReadonlySet<string> = new Set(['PENDING', 'FAILED']);

/**
 * L'effet d'un fait dont le garde de statut a décliné : **la ligne existe**,
 * rien n'a été écrit, et l'appelant marquera tout de même l'événement traité.
 *
 * À ne pas confondre avec `null`, qui dit « aucune ligne ne porte cette
 * référence » et annule jusqu'à la marque (#410).
 */
const DECLINED: Omit<WebhookApplication, 'outcome'> = {
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

/**
 * Repository en mémoire.
 *
 * Il reproduit les propriétés dont les suites ont besoin, et rien d'autre :
 * l'idempotence par `(tenant, event)`, le fait qu'un événement ne touche que les
 * lignes de l'établissement résolu, le fait qu'un événement sans encaissement
 * correspondant **ne retient aucune marque** (#410), et — depuis #447 — les
 * **gardes de statut** du vrai dépôt, branche par branche :
 *
 * | Fait | Filtre de `StripeWebhookRepository` | Ce que le double en fait |
 * |---|---|---|
 * | `payment-succeeded` | `status ∈ {PENDING, FAILED}` | n'écrit `SUCCEEDED` que depuis ces deux états, et ne confirme le rendez-vous que si l'encaissement a transité |
 * | `payment-failed` | `status = PENDING` | n'écrase jamais un succès ni un remboursement |
 * | `charge-refunded` | aucun — la borne est en base | écrit toujours, comme le vrai |
 *
 * C'est ce qui rend l'autre moitié de la règle de #410 — « la ligne existe, le
 * garde décline, **la marque reste** » — observable ici : un `paymentsTouched`
 * à zéro sur une issue `applied`, là où un événement sans destinataire rend
 * `unmatched` sans rien marquer. La distinction entre ces deux zéros est très
 * exactement ce que le ticket avait à trancher, et un double qui écrivait sans
 * garde ne pouvait pas la montrer.
 *
 * Ce qu'il **ne** modélise pas, et qu'il ne faut donc pas lui demander : la
 * transaction — donc l'annulation de la marque quand l'effet échoue —, la
 * contrainte d'unicité qui sérialise deux livraisons concurrentes, la frontière
 * tenue par l'extension Prisma, la borne
 * `payments_refunded_amount_minor_check`, et l'horodatage `capturedAt`. Tout
 * cela se prouve contre un vrai moteur, dans
 * `test/payments-webhook.isolation-spec.ts` : un double ne peut pas témoigner
 * pour la base.
 */
export class FakeStripeWebhookRepository {
  public readonly payments = new Map<string, FakePayment>();
  public readonly processed = new Set<string>();
  /** Levée à la prochaine application — pour exercer le chemin « la file journalise et n'échoue pas ». */
  public failNext: Error | null = null;

  public seed(payment: FakePayment): void {
    this.payments.set(payment.paymentIntentId, payment);
  }

  public async findTenantIdByProviderReference(reference: {
    readonly paymentIntentId: string | null;
    readonly chargeId: string | null;
  }): Promise<string | null> {
    for (const payment of this.payments.values()) {
      if (
        (reference.paymentIntentId !== null &&
          payment.paymentIntentId === reference.paymentIntentId) ||
        (reference.chargeId !== null && payment.chargeId === reference.chargeId)
      ) {
        return payment.tenantId;
      }
    }
    return null;
  }

  public async apply(event: StripeWebhookEvent): Promise<WebhookApplication> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    const tenantId = await this.findTenantIdByProviderReference(referenceOf(event.fact));
    const key = `${tenantId ?? event.tenantHint ?? '?'}:${event.eventId}`;
    if (this.processed.has(key)) {
      return { outcome: 'replayed', paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    const effect = this.mutate(event.fact);

    if (effect === null) {
      // Le double reproduit l'annulation du vrai (#410) : aucune ligne ne porte
      // la référence, donc **aucune marque n'est retenue**. Sans cela, une suite
      // en mémoire verrait un renvoi passer pour un rejeu là où la base, elle,
      // l'appliquerait — le double mentirait sur la seule propriété que ce
      // ticket a ajoutée.
      return { outcome: 'unmatched', paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    this.processed.add(key);

    return { outcome: 'applied', ...effect };
  }

  /** L'effet du fait, ou `null` quand aucune ligne ne porte sa référence. */
  private mutate(fact: WebhookFact): Omit<WebhookApplication, 'outcome'> | null {
    if (fact.kind === 'dispute-opened') {
      // L'alerte **est** l'effet : appliqué, et marqué, même sans ligne.
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    const payment = this.payments.get(fact.paymentIntentId);
    if (payment === undefined) {
      return null;
    }

    switch (fact.kind) {
      case 'payment-succeeded': {
        // `where: { id, status: { in: ['PENDING', 'FAILED'] } }`. Un
        // encaissement déjà remboursé ne redevient pas abouti parce qu'une
        // livraison arrive en retard — Stripe ne garantit pas l'ordre.
        if (!SETTLEABLE.has(payment.status)) {
          return DECLINED;
        }
        payment.status = 'SUCCEEDED';
        payment.chargeId = fact.chargeId ?? payment.chargeId;
        // Le filtre de statut vaut pour les **deux** écritures : un rendez-vous
        // ne se confirme pas sur un encaissement qui n'a pas transité.
        const confirmed = payment.appointmentStatus === 'PENDING' ? 1 : 0;
        if (confirmed === 1) {
          payment.appointmentStatus = 'CONFIRMED';
        }
        return { paymentsTouched: 1, appointmentsConfirmed: confirmed };
      }
      case 'payment-failed':
        // `where: { id, status: 'PENDING' }`. Une carte refusée livrée après le
        // succès n'annule pas un paiement abouti.
        if (payment.status !== 'PENDING') {
          return DECLINED;
        }
        payment.status = 'FAILED';
        return { paymentsTouched: 1, appointmentsConfirmed: 0 };
      case 'charge-refunded':
        // Aucun garde de statut dans le vrai dépôt : le montant vient de Stripe,
        // qui fait foi, et c'est la contrainte de base — pas une branche de code
        // — qui refuse un remboursement supérieur à l'encaissement.
        payment.status = fact.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        payment.refundedAmountMinor = fact.refundedAmountMinor;
        if (fact.chargeId !== null) {
          payment.chargeId = fact.chargeId;
        }
        return { paymentsTouched: 1, appointmentsConfirmed: 0 };
    }
  }

  /** Le double, tel que Nest le substitue au vrai fournisseur. */
  public asRepository(): StripeWebhookRepository {
    return this as unknown as StripeWebhookRepository;
  }
}

function referenceOf(fact: WebhookFact): {
  paymentIntentId: string | null;
  chargeId: string | null;
} {
  switch (fact.kind) {
    case 'payment-failed':
      return { paymentIntentId: fact.paymentIntentId, chargeId: null };
    case 'payment-succeeded':
    case 'charge-refunded':
    case 'dispute-opened':
      return { paymentIntentId: fact.paymentIntentId, chargeId: fact.chargeId };
  }
}
