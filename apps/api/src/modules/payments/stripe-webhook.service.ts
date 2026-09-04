import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { StripeWebhookRepository } from './stripe-webhook.repository';
import type { StripeWebhookEvent, WebhookFact } from './stripe-webhook.types';

/**
 * Le traitement d'un événement Stripe déjà vérifié — la règle métier des
 * webhooks, et le seul endroit qui la décide (api-module §2).
 *
 * Il ne connaît ni `Request`, ni `Response`, ni Prisma. Il reçoit un événement
 * réduit, résout l'établissement, ouvre la portée de tenant et confie l'écriture
 * au repository. C'est ce qui le rend exerçable sans HTTP et sans base.
 *
 * ## Pourquoi il ouvre lui-même la portée de tenant
 *
 * Les deux entrées habituelles n'existent pas ici : un webhook n'apporte ni
 * jeton — donc rien pour `JwtAuthGuard` — ni slug d'URL — donc rien pour
 * `TenantScopeMiddleware`. Et le traitement n'a de toute façon plus lieu pendant
 * la requête : il a été remis à une file, et s'exécute après la réponse.
 *
 * `runWithTenant` est exactement la fonction que `tenant-context.ts` prévoit
 * pour ce cas — « un traitement hors requête HTTP : consommateur SQS, tâche
 * planifiée, script de reprise ». L'établissement y est nommé explicitement, il
 * vient d'une lecture en base, et tout ce qui s'exécute dedans est scopé par
 * l'extension Prisma comme n'importe quelle requête authentifiée.
 */
@Injectable()
export class StripeWebhookService {
  public constructor(
    private readonly repository: StripeWebhookRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Traite un événement. **Ne lève que sur une panne** — base injoignable,
   * contrainte violée : ce sont les cas où l'on veut précisément que la
   * transaction soit annulée et que Stripe rejoue.
   *
   * Tout le reste — établissement introuvable, encaissement inconnu — se
   * journalise et s'arrête là. Rejouer ne ferait pas apparaître une ligne qui
   * n'existe pas.
   */
  public async process(event: StripeWebhookEvent): Promise<void> {
    const tenantId = await this.resolveTenant(event);

    if (tenantId === null) {
      this.logger.warn(
        'stripe webhook: établissement non résolu, événement ignoré',
        { eventId: event.eventId, eventType: event.eventType },
        StripeWebhookService.name,
      );
      return;
    }

    const outcome = await this.tenants.runWithTenant(tenantId, async () =>
      this.repository.apply(event),
    );

    this.logger.log(
      outcome.applied ? 'stripe webhook: événement appliqué' : 'stripe webhook: rejeu ignoré',
      {
        eventId: event.eventId,
        eventType: event.eventType,
        tenantId,
        paymentsTouched: outcome.paymentsTouched,
        appointmentsConfirmed: outcome.appointmentsConfirmed,
      },
      StripeWebhookService.name,
    );

    if (outcome.applied && event.fact.kind === 'dispute-opened') {
      this.alertOnDispute(tenantId, event.fact);
    }
  }

  /**
   * L'établissement concerné : la base d'abord, la métadonnée ensuite.
   *
   * La base fait autorité sur nos propres lignes — c'est elle qui dit à qui
   * appartient l'encaissement que Stripe désigne. La métadonnée de l'intention
   * n'est consultée que lorsque aucune ligne ne porte la référence : un litige
   * ouvert sur une intention dont nous n'avons jamais écrit l'encaissement, par
   * exemple. Elle a été écrite par nous à la création de l'intention et la
   * signature du corps l'authentifie, mais elle reste ce que Stripe nous renvoie
   * — c'est pourquoi elle ne prime jamais sur une ligne réelle.
   */
  private async resolveTenant(event: StripeWebhookEvent): Promise<string | null> {
    const reference = referenceOf(event.fact);
    const owner = await this.repository.findTenantIdByProviderReference(reference);
    return owner ?? event.tenantHint;
  }

  /**
   * Un litige est ouvert.
   *
   * « Un litige déclenche une alerte vers l'équipe ; il n'est pas traité
   * automatiquement au MVP » (payments-stripe §6). L'alerte est un journal de
   * niveau `error` — c'est ce que CloudWatch sait déclencher, et c'est la seule
   * chaîne d'alerte que le MVP possède. Aucune donnée personnelle n'y figure :
   * des identifiants opaques et un établissement, rien d'autre (CDC §5.1).
   */
  private alertOnDispute(
    tenantId: string,
    fact: Extract<WebhookFact, { kind: 'dispute-opened' }>,
  ): void {
    this.logger.error(
      'stripe webhook: litige ouvert — intervention humaine requise',
      {
        tenantId,
        disputeId: fact.disputeId,
        chargeId: fact.chargeId,
        paymentIntentId: fact.paymentIntentId,
      },
      StripeWebhookService.name,
    );
  }
}

/** Les références Stripe que porte un fait, quelle que soit sa nature. */
function referenceOf(fact: WebhookFact): {
  readonly paymentIntentId: string | null;
  readonly chargeId: string | null;
} {
  switch (fact.kind) {
    case 'payment-succeeded':
      return { paymentIntentId: fact.paymentIntentId, chargeId: fact.chargeId };
    case 'payment-failed':
      return { paymentIntentId: fact.paymentIntentId, chargeId: null };
    case 'charge-refunded':
      return { paymentIntentId: fact.paymentIntentId, chargeId: fact.chargeId };
    case 'dispute-opened':
      return { paymentIntentId: fact.paymentIntentId, chargeId: fact.chargeId };
  }
}
