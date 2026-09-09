import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '../../../common/logging/structured-logger';
import { requireTenantId } from '../../../common/tenant/tenant-context';
import type {
  ClaimRequest,
  SpooledDelivery,
  SpoolRequest,
  WebhookApplication,
  StripeWebhookRepository,
} from '../stripe-webhook.repository';
import type { StripeWebhookEvent, WebhookFact } from '../stripe-webhook.types';
import { SYSTEM_CLOCK, type WebhookClock } from '../webhook-clock';

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

/** Une ligne de `stripe_webhook_deliveries`, réduite à ce que la file manipule (#409). */
export interface FakeDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly serializationKey: string;
  readonly event: StripeWebhookEvent;
  attempts: number;
  status: 'PENDING' | 'DEAD';
  claimedAt: Date | null;
  nextAttemptAt: Date;
  lastError: string | null;
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
 * Depuis #409 il porte aussi la **file durable** — inscrire, aboutir,
 * replanifier, enterrer, reprendre. Ces cinq opérations sont ce que
 * `DurableWebhookQueue` appelle, et un double qui ne les aurait pas ferait
 * échouer toute suite qui monte le module réel. Elles reproduisent les deux
 * propriétés dont les suites ont besoin : l'unique `(tenant, event)` qui rend
 * `null` sur une redélivrance, et le bail qui rend une livraison reprenable.
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
  /** Les lignes de `stripe_webhook_deliveries`, par identifiant (#409). */
  public readonly deliveries = new Map<string, FakeDelivery>();
  /** Levée à la prochaine application — pour exercer le chemin « la file journalise et n'échoue pas ». */
  public failNext: Error | null = null;

  /**
   * L'horloge du bail, comme le vrai dépôt la reçoit (#523).
   *
   * Elle a un défaut parce qu'aucune suite unitaire n'a besoin de la piloter
   * aujourd'hui — mais laisser le double appeler `new Date()` aurait rétabli, à
   * l'endroit même où l'on croit lire le comportement du dépôt, l'instant
   * ambiant que ce ticket retire.
   */
  public constructor(private readonly clock: WebhookClock = SYSTEM_CLOCK) {}

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

  /**
   * L'établissement d'une indication de métadonnée.
   *
   * Le double ne tient pas de table `tenants` : il accepte toute indication et
   * la rend telle quelle. Ce n'est pas une simplification gratuite — la
   * propriété que le vrai dépôt ajoute ici est « cet identifiant existe-t-il en
   * base », et c'est très exactement ce qu'un double ne peut pas dire. Elle se
   * prouve contre un vrai moteur, dans `test/payments-webhook.isolation-spec.ts`.
   *
   * `inconnus` permet néanmoins à une suite de désigner une indication qui ne
   * doit rien résoudre, sans avoir à doubler la classe entière.
   */
  public readonly inconnus = new Set<string>();

  public async findTenantIdByHint(hint: string): Promise<string | null> {
    return this.inconnus.has(hint) ? null : hint;
  }

  /**
   * L'inscription en file, avant l'accusé (#409).
   *
   * Le tenant vient du **contexte**, exactement comme l'extension Prisma le
   * pose sur le vrai dépôt : la file ouvre la portée avec `runWithTenant` avant
   * d'appeler, et un double qui recopierait un tenant passé en argument ne
   * dirait rien de cette mécanique.
   *
   * Une redélivrance qui retombe sur une ligne **morte** la ressuscite, comme
   * le vrai dépôt : c'est ce qui rend effectif le renvoi depuis le tableau de
   * bord Stripe, seul geste que l'alerte de file d'attente morte appelle.
   */
  public async spool(request: SpoolRequest): Promise<SpooledDelivery | null> {
    const tenantId = requireTenantId();
    const key = `${tenantId}:${request.event.eventId}`;

    for (const delivery of this.deliveries.values()) {
      if (`${delivery.tenantId}:${delivery.event.eventId}` !== key) {
        continue;
      }

      if (delivery.status !== 'DEAD') {
        // L'unique `(tenant_id, event_id)` : Stripe a redélivré pendant que la
        // première livraison attendait.
        return null;
      }

      const revivedAt = this.clock();
      delivery.status = 'PENDING';
      delivery.attempts = 0;
      delivery.claimedAt = revivedAt;
      delivery.nextAttemptAt = revivedAt;
      delivery.lastError = null;

      return {
        id: delivery.id,
        tenantId: delivery.tenantId,
        attempts: 0,
        serializationKey: delivery.serializationKey,
        event: request.event,
      };
    }

    // Un seul instant pour les deux colonnes, comme le vrai dépôt (#555, #523).
    const spooledAt = this.clock();
    const spooled: FakeDelivery = {
      id: randomUUID(),
      tenantId,
      attempts: 0,
      serializationKey: request.serializationKey,
      event: request.event,
      status: 'PENDING',
      claimedAt: spooledAt,
      nextAttemptAt: spooledAt,
      lastError: null,
    };
    this.deliveries.set(spooled.id, spooled);

    return {
      id: spooled.id,
      tenantId,
      attempts: 0,
      serializationKey: request.serializationKey,
      event: request.event,
    };
  }

  /** La livraison a abouti : la ligne disparaît. */
  public async completeDelivery(deliveryId: string): Promise<void> {
    this.deliveries.delete(deliveryId);
  }

  /** Réessai programmé : le bail est repoussé, pas relâché. */
  public async rescheduleDelivery(
    deliveryId: string,
    next: { readonly attempts: number; readonly nextAttemptAt: Date; readonly lastError: string },
  ): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) {
      return;
    }
    delivery.attempts = next.attempts;
    delivery.nextAttemptAt = next.nextAttemptAt;
    delivery.lastError = next.lastError;
    delivery.claimedAt = this.clock();
  }

  /** File d'attente morte : le bail est relâché, le statut exclut du balayage. */
  public async deadLetterDelivery(
    deliveryId: string,
    outcome: { readonly attempts: number; readonly lastError: string },
  ): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) {
      return;
    }
    delivery.status = 'DEAD';
    delivery.attempts = outcome.attempts;
    delivery.lastError = outcome.lastError;
    delivery.claimedAt = null;
  }

  /**
   * La reprise : ce que plus personne ne tient.
   *
   * Même prédicat que le vrai dépôt — `PENDING`, échéance passée, bail absent
   * ou périmé —, et la prise repose le bail pour que deux tours consécutifs ne
   * rendent pas deux fois la même livraison.
   */
  public async claimAbandonedDeliveries(claim: ClaimRequest): Promise<SpooledDelivery[]> {
    const staleBefore = claim.now.getTime() - claim.leaseMs;
    const claimed: SpooledDelivery[] = [];

    for (const delivery of this.deliveries.values()) {
      if (claimed.length >= claim.batchSize) {
        break;
      }
      if (delivery.status !== 'PENDING' || delivery.nextAttemptAt.getTime() > claim.now.getTime()) {
        continue;
      }
      if (delivery.claimedAt !== null && delivery.claimedAt.getTime() >= staleBefore) {
        continue;
      }

      delivery.claimedAt = claim.now;
      claimed.push({
        id: delivery.id,
        tenantId: delivery.tenantId,
        attempts: delivery.attempts,
        serializationKey: delivery.serializationKey,
        event: delivery.event,
      });
    }

    return claimed;
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
