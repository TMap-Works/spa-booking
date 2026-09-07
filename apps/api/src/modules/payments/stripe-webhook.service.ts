import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { StripeWebhookRepository } from './stripe-webhook.repository';
import { referenceOf, type StripeWebhookEvent, type WebhookFact } from './stripe-webhook.types';

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
   * transaction soit annulée, pour que rien de faux ne s'écrive.
   *
   * Laisser la panne remonter est la conduite utile, et non un abandon : Stripe,
   * lui, ne rejoue pas — le 200 est parti avant le traitement —, mais depuis
   * #409 c'est la **file durable** qui rejoue. Elle réessaie un nombre borné de
   * fois, puis enterre la livraison en file d'attente morte avec une alerte de
   * niveau `error`. Une panne avalée ici priverait cette mécanique de ce sur
   * quoi elle s'appuie.
   *
   * Tout le reste — établissement introuvable, encaissement inconnu — se
   * journalise et s'arrête là, en `warn` : ce sont des issues, pas des pannes,
   * et les réessayer ne changerait rien. Depuis #410, un encaissement inconnu
   * laisse la base **rigoureusement intacte**, marque d'idempotence comprise, si
   * bien qu'un renvoi de l'événement depuis le tableau de bord Stripe
   * l'appliquera une fois la ligne présente. Le journal est ce qui déclenche ce
   * renvoi.
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

    const application = await this.tenants.runWithTenant(tenantId, async () =>
      this.repository.apply(event),
    );

    const meta = {
      eventId: event.eventId,
      eventType: event.eventType,
      tenantId,
      paymentsTouched: application.paymentsTouched,
      appointmentsConfirmed: application.appointmentsConfirmed,
    };

    if (application.outcome === 'unmatched') {
      // `warn` et non `log` : rien n'a été écrit, marque comprise (#410), et
      // c'est **l'unique signal** qu'un encaissement attendu n'est jamais
      // arrivé jusqu'à nous. La conduite à tenir est écrite dans le message,
      // parce que celui qui lira ce journal ne lira pas ce fichier : renvoyer
      // l'événement depuis le tableau de bord Stripe une fois la ligne
      // présente, ce qui l'appliquera pour de bon.
      this.logger.warn(
        'stripe webhook: aucun encaissement ne porte cette référence — rien écrit, renvoi possible',
        meta,
        StripeWebhookService.name,
      );
      return;
    }

    this.logger.log(
      application.outcome === 'applied'
        ? 'stripe webhook: événement appliqué'
        : 'stripe webhook: rejeu ignoré',
      meta,
      StripeWebhookService.name,
    );

    if (application.outcome === 'applied' && event.fact.kind === 'dispute-opened') {
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
   *
   * **Publique depuis #409**, et pas par commodité : la file durable doit
   * inscrire la livraison sous un établissement **avant** d'acquitter à Stripe,
   * et il n'existe pas d'autre autorité que celle-ci pour dire lequel. Une
   * seconde règle de résolution, écrite dans la file, aurait fini par diverger
   * de celle-ci — et un désaccord entre les deux inscrirait la livraison sous un
   * établissement pour l'appliquer sous un autre.
   *
   * C'est aussi ce qui a rendu la **confrontation** de l'indication à la base
   * nécessaire, alors qu'elle ne l'était pas avant. Tant que le tenant résolu ne
   * servait qu'à ouvrir une portée de lecture, une indication qui ne désignait
   * rien ne trouvait simplement aucune ligne. Depuis #409 elle sert à écrire, et
   * un établissement inexistant ferait violer la clé étrangère pendant la
   * requête HTTP : la route rendrait 500 et Stripe redélivrerait trois jours
   * durant un événement que rien ne rendra jamais inscriptible. Le contrat que
   * `tenantHint` annonce depuis le premier jour — « le résolveur la confronte à
   * la base avant d'ouvrir quoi que ce soit » — est donc tenu ici.
   */
  public async resolveTenant(event: StripeWebhookEvent): Promise<string | null> {
    const reference = referenceOf(event.fact);
    const owner = await this.repository.findTenantIdByProviderReference(reference);

    if (owner !== null) {
      return owner;
    }

    return event.tenantHint === null
      ? null
      : this.repository.findTenantIdByHint(event.tenantHint);
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
