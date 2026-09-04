import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { StripeWebhookService } from './stripe-webhook.service';
import type { StripeWebhookEvent } from './stripe-webhook.types';

/**
 * La file des événements de webhook — ce qui permet de répondre 200 **avant**
 * d'avoir traité.
 *
 * ## Pourquoi une file, et pas simplement un traitement synchrone
 *
 * « Répondre 200 rapidement. Le traitement long part en file SQS. Un webhook
 * qui dépasse le délai est rejoué et amplifie la charge » (payments-stripe §3).
 * Le délai de Stripe est de quelques secondes ; une transaction qui attend un
 * verrou de ligne peut les dépasser. Le rejeu qui s'ensuit ne corrige rien — il
 * ajoute une seconde livraison à traiter pendant que la première n'est pas
 * finie, et la charge se multiplie exactement quand le système est déjà lent.
 *
 * ## Pourquoi en mémoire aujourd'hui
 *
 * La chaîne visée par le CDC §2.2 est EventBridge → SQS → Lambda, et elle n'est
 * pas posée : l'API n'a aujourd'hui aucun client AWS, et en ajouter un toucherait
 * `apps/api/package.json` et `infra/terraform/`, tous deux hors de l'empreinte
 * de ce ticket. Ce qui compte est que la **frontière** soit là : `WEBHOOK_QUEUE`
 * est un jeton d'injection, `InProcessWebhookQueue` n'en est qu'une
 * implémentation, et le contrôleur ne sait rien de ce qui se trouve derrière.
 *
 * Ce que l'implémentation en mémoire **ne** garantit pas, et qu'il faut savoir
 * sans se raconter d'histoire : **un événement perdu ici est perdu pour de
 * bon.** Le 200 est déjà parti quand le traitement commence, et Stripe ne
 * rejoue que ce qu'il a vu échouer — un non-2xx ou un délai dépassé. Un arrêt
 * brutal du processus, ou un traitement qui échoue en base, ne produit donc
 * **aucune** nouvelle livraison : l'encaissement reste `PENDING` et le
 * rendez-vous n'est jamais confirmé, jusqu'à ce qu'un humain renvoie
 * l'événement depuis le tableau de bord Stripe.
 *
 * L'idempotence de `processed_webhook_events` rend ce renvoi manuel inoffensif
 * — c'est ce qui rend la reprise possible —, mais elle ne le déclenche pas. La
 * reprise automatique demande une file durable avec accusé de consommation et
 * file d'attente morte : la chaîne SQS du CDC §2.2, portée par une issue de
 * suivi. Jusque-là, le journal de niveau `error` ci-dessous est la seule alerte.
 *
 * ## L'arrêt attend les traitements en cours
 *
 * `onApplicationShutdown` — donc le `SIGTERM` d'ECS, via
 * `app.enableShutdownHooks()` — attend que la file se vide. C'est précisément
 * parce qu'un événement interrompu ne revient pas tout seul que cette attente
 * n'est pas un confort : sans elle, chaque déploiement perdrait les livraisons
 * en vol. Elle coûte quelques centaines de millisecondes.
 */

/** Jeton d'injection de la file — l'implémentation est un détail du module. */
export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');

export interface WebhookQueue {
  /**
   * Met un événement en file. **Ne rend jamais d'erreur** : l'échec du
   * traitement est l'affaire du consommateur, pas celle de la réponse HTTP à
   * Stripe.
   */
  enqueue(event: StripeWebhookEvent): void;

  /**
   * Attend que tout ce qui a été mis en file ait été consommé.
   *
   * Deux appelants, et pas un de plus : l'arrêt propre du conteneur, et les
   * suites d'intégration — sans quoi elles asserteraient sur la base avant que
   * le traitement n'ait eu lieu, et rougiraient par intermittence.
   */
  whenIdle(): Promise<void>;
}

@Injectable()
export class InProcessWebhookQueue implements WebhookQueue, OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  public constructor(
    private readonly webhooks: StripeWebhookService,
    private readonly logger: StructuredLogger,
  ) {}

  public enqueue(event: StripeWebhookEvent): void {
    const job = this.consume(event);
    this.inFlight.add(job);
    void job.finally(() => {
      this.inFlight.delete(job);
    });
  }

  public async whenIdle(): Promise<void> {
    // Une boucle plutôt qu'un seul `Promise.all` : un traitement peut en mettre
    // un autre en file, et attendre l'instantané initial laisserait le second
    // derrière soi.
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  public async onApplicationShutdown(): Promise<void> {
    await this.whenIdle();
  }

  /**
   * Le consommateur.
   *
   * `setImmediate` rend d'abord la main à la boucle d'événements : la réponse
   * 200 part avant que la première requête SQL ne soit émise. C'est ce qui
   * distingue « mis en file » de « traité pendant que Stripe attend ».
   *
   * Rien ne remonte de cette promesse. Un traitement qui échoue est journalisé
   * ici, jamais propagé : le contrôleur a déjà répondu, et une promesse rejetée
   * sans gestionnaire abattrait le processus.
   */
  private async consume(event: StripeWebhookEvent): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    try {
      await this.webhooks.process(event);
    } catch (error: unknown) {
      // La transaction a été annulée, donc l'événement n'est **pas** marqué
      // traité : il reste applicable. Mais rien ne le réappliquera tout seul —
      // le 200 est parti, et Stripe ne rejoue que ce qu'il a vu échouer. Ce
      // journal de niveau `error` est donc une **alerte**, pas une trace : il
      // signale un encaissement resté `PENDING` et un rendez-vous jamais
      // confirmé, à renvoyer depuis le tableau de bord Stripe en attendant la
      // file durable du CDC §2.2.
      this.logger.error(
        'stripe webhook: traitement en échec',
        {
          eventId: event.eventId,
          eventType: event.eventType,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        },
        InProcessWebhookQueue.name,
      );
    }
  }
}
