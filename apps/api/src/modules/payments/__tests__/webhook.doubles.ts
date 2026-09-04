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
 * Repository en mémoire.
 *
 * Il reproduit les deux propriétés dont les suites ont besoin, et rien d'autre :
 * l'idempotence par `(tenant, event)`, et le fait qu'un événement ne touche que
 * les lignes de l'établissement résolu. Ce qu'il **ne** prouve pas — que
 * l'extension Prisma tient réellement la frontière, que la transaction annule
 * bien la marque quand l'effet échoue — se prouve contre un vrai moteur, dans
 * `test/payments-webhook.isolation-spec.ts`. Un double ne peut pas témoigner
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
      return { applied: false, paymentsTouched: 0, appointmentsConfirmed: 0 };
    }
    this.processed.add(key);

    return { applied: true, ...this.mutate(event.fact) };
  }

  private mutate(fact: WebhookFact): Omit<WebhookApplication, 'applied'> {
    if (fact.kind === 'dispute-opened') {
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    const payment = this.payments.get(fact.paymentIntentId);
    if (payment === undefined) {
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    switch (fact.kind) {
      case 'payment-succeeded': {
        payment.status = 'SUCCEEDED';
        payment.chargeId = fact.chargeId ?? payment.chargeId;
        const confirmed = payment.appointmentStatus === 'PENDING' ? 1 : 0;
        if (confirmed === 1) {
          payment.appointmentStatus = 'CONFIRMED';
        }
        return { paymentsTouched: 1, appointmentsConfirmed: confirmed };
      }
      case 'payment-failed':
        payment.status = 'FAILED';
        return { paymentsTouched: 1, appointmentsConfirmed: 0 };
      case 'charge-refunded':
        payment.status = fact.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        payment.refundedAmountMinor = fact.refundedAmountMinor;
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
