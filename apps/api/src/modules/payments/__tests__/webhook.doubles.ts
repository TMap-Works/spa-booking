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
 * Il reproduit les trois propriétés dont les suites ont besoin, et rien d'autre :
 * l'idempotence par `(tenant, event)`, le fait qu'un événement ne touche que les
 * lignes de l'établissement résolu, et — depuis #410 — le fait qu'un événement
 * sans encaissement correspondant **ne retient aucune marque**.
 *
 * Ce qu'il **ne** modélise pas, et qu'il ne faut donc pas lui demander : les
 * gardes de statut du vrai dépôt. `payment-succeeded` y écrit `SUCCEEDED` même
 * sur une ligne déjà remboursée, et `payment-failed` écrit `FAILED` même sur un
 * succès. L'autre moitié de la règle de #410 — « la ligne existe, le garde
 * décline, la marque reste » — ne se prouve donc **pas** ici : elle se prouve
 * contre un vrai moteur, comme la frontière tenue par l'extension Prisma et
 * l'annulation de la marque quand l'effet échoue, dans
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
