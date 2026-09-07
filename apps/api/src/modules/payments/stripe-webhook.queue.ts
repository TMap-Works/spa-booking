import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import {
  describeFailure,
  StripeWebhookRepository,
  type SpooledDelivery,
} from './stripe-webhook.repository';
import { StripeWebhookService } from './stripe-webhook.service';
import { serializationKeyOf, type StripeWebhookEvent } from './stripe-webhook.types';
import {
  hasAttemptsLeft,
  retryDelayMs,
  WEBHOOK_RETRY_SCHEDULE,
  WEBHOOK_SWEEP_SCHEDULE,
  type RetrySchedule,
  type SweepSchedule,
} from './webhook-retry.policy';

/**
 * La file des événements de webhook — ce qui permet de répondre 200 **avant**
 * d'avoir traité, et ce qui garantit que l'avoir dit engage à le faire.
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
 * ## Ce que #409 a changé, et à quel instant précis
 *
 * La version précédente tenait la file **en mémoire**, et le disait sans
 * détour : « un événement perdu ici est perdu pour de bon ». C'était vrai, et
 * c'était le trou. Le 200 était déjà parti quand le traitement commençait, et
 * Stripe ne rejoue que ce qu'il a vu échouer : un arrêt brutal du processus, ou
 * un traitement qui échoue en base, ne produisait **aucune** nouvelle
 * livraison. L'encaissement restait `PENDING`, le rendez-vous n'était jamais
 * confirmé, et la cliente avait été débitée.
 *
 * Le déplacement tient en une ligne : **la livraison est inscrite en base avant
 * que le 200 ne parte** (`StripeWebhookRepository.spool`). Tout le reste en
 * découle.
 *
 * | Instant | Avant #409 | Maintenant |
 * |---|---|---|
 * | l'inscription échoue | 200 rendu, événement perdu | `enqueue` **rejette**, pas de 2xx, Stripe redélivre |
 * | 200 rendu | événement en mémoire | événement sur disque |
 * | processus tué | événement perdu | ligne `PENDING`, reprise par le balayage |
 * | traitement en échec | journal `error`, reprise manuelle | réessai borné, puis `DEAD` + alerte |
 *
 * ## Les quatre propriétés, et où chacune est écrite
 *
 * | Critère de #409 | Ce qui le tient |
 * |---|---|
 * | réessai automatique borné | `deliver`, sur `hasAttemptsLeft` / `retryDelayMs` |
 * | file d'attente morte avec alerte | `bury` — statut `DEAD` et journal `error` |
 * | aucun événement perdu à l'arrêt brutal | `enqueue` inscrit avant d'acquitter ; `sweepOnce` reprend |
 * | sérialisation par encaissement | `chain`, sur la clé persistée de la livraison |
 *
 * ## Ce que cette implémentation n'est toujours pas
 *
 * La chaîne visée par le CDC §2.2 est EventBridge → SQS → Lambda, et elle
 * demande du Terraform que ce ticket ne touche pas. Ce qui est posé ici est la
 * **durabilité** et la **reprise**, en base, derrière le jeton `WEBHOOK_QUEUE`
 * — le contrôleur ne sait toujours rien de ce qu'il y a derrière, et le jour où
 * SQS arrivera, la clé de sérialisation persistée deviendra son `MessageGroupId`
 * sans qu'une ligne du contrôleur ni du service ne bouge.
 *
 * Ce qui reste, dit sans se raconter d'histoire : la sérialisation par
 * encaissement est tenue **dans le processus**. Deux instances ECS qui
 * traiteraient deux livraisons du même encaissement au même instant ne
 * s'ordonneraient pas entre elles — le bail empêche seulement qu'elles
 * traitent la *même* livraison. Aucun état incohérent n'en découle, pour la
 * raison que l'issue donne : les transitions sont des `updateMany` filtrés par
 * statut, dans une transaction. C'est l'ordre qui n'est pas garanti, et c'est
 * la file FIFO qui le garantira.
 */

/** Jeton d'injection de la file — l'implémentation est un détail du module. */
export const WEBHOOK_QUEUE = Symbol('WEBHOOK_QUEUE');

export interface WebhookQueue {
  /**
   * Rend la livraison **durable**, puis la met en traitement.
   *
   * Contrat inversé par #409, et c'est le cœur du ticket : cette promesse
   * **rejette** quand la livraison n'a pas pu être inscrite. C'est la seule
   * conduite qui protège l'événement — un contrôleur qui acquitterait malgré
   * l'échec d'inscription rendrait 200 sur un événement que plus personne ne
   * détient, et Stripe ne redélivre que ce qu'il a vu échouer.
   *
   * Ce qu'elle n'attend **pas**, en revanche : le traitement lui-même. Il part
   * après, et son échec n'a aucune influence sur ce que le contrôleur rend.
   */
  enqueue(event: StripeWebhookEvent): Promise<void>;

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
export class DurableWebhookQueue
  implements WebhookQueue, OnApplicationBootstrap, OnApplicationShutdown
{
  /**
   * Les chaînes de sérialisation, une par encaissement.
   *
   * C'est le second constat de #409, tranché. Deux livraisons portant sur le
   * même `pi_…` se suivent au lieu de s'éventailler ; deux livraisons portant
   * sur des encaissements distincts restent parallèles, parce qu'il n'y a
   * aucune raison de faire attendre la seconde.
   *
   * L'entrée est retirée quand la dernière promesse de la chaîne se termine —
   * sans quoi la table grossirait d'une entrée par encaissement vu, pour la vie
   * du processus.
   */
  private readonly chains = new Map<string, Promise<void>>();

  /** Tout ce qui est en vol, quelle que soit sa chaîne — la matière de `whenIdle`. */
  private readonly inFlight = new Set<Promise<void>>();

  /**
   * L'arrêt a commencé.
   *
   * Il ne coupe rien en cours : il empêche d'**attendre** un réessai. Une
   * livraison qui vient d'échouer est déjà replanifiée en base au moment où ce
   * drapeau est lu ; rendre la main la laisse `PENDING` et le balayage — de
   * cette instance à son retour, ou d'une autre — la reprendra. Attendre trois
   * secondes de plus pendant que ECS compte le délai de grâce d'un `SIGTERM`
   * n'aurait rien sauvé de plus.
   */
  private stopping = false;

  private sweeper: NodeJS.Timeout | null = null;

  public constructor(
    private readonly webhooks: StripeWebhookService,
    private readonly repository: StripeWebhookRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
    @Inject(WEBHOOK_RETRY_SCHEDULE) private readonly retry: RetrySchedule,
    @Inject(WEBHOOK_SWEEP_SCHEDULE) private readonly sweep: SweepSchedule,
  ) {}

  public async enqueue(event: StripeWebhookEvent): Promise<void> {
    // La résolution passe par le service, qui en est la seule autorité : la
    // base d'abord, la métadonnée ensuite. La livraison doit être inscrite
    // **sous un établissement**, et il n'y en a pas d'autre à qui le demander.
    const tenantId = await this.webhooks.resolveTenant(event);

    if (tenantId === null) {
      // Aucun établissement ne revendique cet événement : ni une ligne
      // `payments`, ni une métadonnée. Il n'a rien à appliquer, et la règle
      // multi-tenant ne lui laisse aucune place où être conservé — toute table
      // métier porte `tenant_id`. On acquitte donc sans inscrire, exactement
      // comme avant #409 : rendre un non-2xx ferait redélivrer trois jours
      // durant un événement qui ne nous concerne pas, ce qu'une intention créée
      // depuis le tableau de bord Stripe suffit à produire.
      this.logger.warn(
        'stripe webhook: établissement non résolu, livraison non inscrite',
        { eventId: event.eventId, eventType: event.eventType },
        DurableWebhookQueue.name,
      );
      return;
    }

    const serializationKey = serializationKeyOf(event);

    // Ce `await` est ce que le contrôleur attend avant de rendre 200. S'il
    // rejette, la route rend 500 et Stripe redélivre : c'est voulu, c'est le
    // troisième critère du ticket.
    const delivery = await this.tenants.runWithTenant(tenantId, async () =>
      this.repository.spool({ event, serializationKey }),
    );

    if (delivery === null) {
      // L'unique `(tenant_id, event_id)` a tranché : Stripe a redélivré pendant
      // que la première attendait. Il n'y a pas de second travail à faire, et
      // la première chaîne aboutira pour les deux.
      this.logger.debug(
        'stripe webhook: livraison déjà en file, redélivrance acquittée sans second traitement',
        { eventId: event.eventId, eventType: event.eventType, tenantId },
        DurableWebhookQueue.name,
      );
      return;
    }

    this.chain(delivery);
  }

  public async whenIdle(): Promise<void> {
    // Une boucle plutôt qu'un seul `Promise.all` : un traitement peut en mettre
    // un autre en file, et attendre l'instantané initial laisserait le second
    // derrière soi.
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /**
   * Le balayage démarre avec l'application, et pas avant.
   *
   * Aucun balayage immédiat au démarrage, délibérément : le premier tour a lieu
   * une période plus tard. Ce n'est pas de la prudence excessive — un balayage
   * lancé pendant l'amorçage interrogerait la base au moment précis où le pool
   * de connexions n'est pas encore chaud, et la seule chose qu'il rattraperait
   * est un retard de quelques secondes sur une reprise qui, par nature, n'est
   * pas pressée.
   */
  public onApplicationBootstrap(): void {
    this.sweeper = setInterval(() => {
      void this.sweepOnce();
    }, this.sweep.intervalMs);

    // Le balayage ne doit pas, à lui seul, tenir le processus en vie : ni celui
    // d'un conteneur qu'on arrête, ni celui d'une suite de tests.
    this.sweeper.unref();
  }

  public async onApplicationShutdown(): Promise<void> {
    this.stopping = true;

    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }

    await this.whenIdle();
  }

  /**
   * Un tour de balayage — la reprise de ce qu'un processus mort a laissé.
   *
   * Publique parce qu'elle est **la** preuve du troisième critère : une suite
   * doit pouvoir la déclencher sans attendre un intervalle, et une reprise
   * simulée est le seul moyen d'observer qu'un arrêt brutal ne perd rien.
   *
   * Elle ne laisse jamais rien remonter. Elle s'exécute sur un minuteur, sans
   * appelant : une promesse rejetée sans gestionnaire abattrait le processus,
   * et une base momentanément injoignable au moment d'un tour n'est pas un
   * incident — le tour suivant reprendra ce que celui-ci n'a pas vu.
   */
  public async sweepOnce(): Promise<void> {
    if (this.stopping) {
      return;
    }

    try {
      const abandoned = await this.repository.claimAbandonedDeliveries({
        now: new Date(),
        leaseMs: this.sweep.leaseMs,
        batchSize: this.sweep.batchSize,
      });

      if (abandoned.length === 0) {
        return;
      }

      this.logger.warn(
        'stripe webhook: livraisons reprises après un arrêt brutal',
        { count: abandoned.length },
        DurableWebhookQueue.name,
      );

      for (const delivery of abandoned) {
        this.chain(delivery);
      }
    } catch (error: unknown) {
      this.logger.warn(
        'stripe webhook: balayage de reprise indisponible',
        { error: describeFailure(error) },
        DurableWebhookQueue.name,
      );
    }
  }

  /**
   * Met la livraison à la suite de celles qui portent le même encaissement.
   *
   * `deliver` ne rejette jamais — c'est sa post-condition, et c'est ce qui rend
   * ce chaînage sûr : une promesse rejetée en tête de chaîne emporterait toutes
   * celles qui s'y accrochent ensuite.
   */
  private chain(delivery: SpooledDelivery): void {
    const previous = this.chains.get(delivery.serializationKey) ?? Promise.resolve();
    const next = previous.then(() => this.deliver(delivery));

    this.chains.set(delivery.serializationKey, next);
    this.inFlight.add(next);

    void next.finally(() => {
      this.inFlight.delete(next);
      // Seulement si personne ne s'est accroché derrière : sinon on effacerait
      // la queue de la chaîne, et la livraison suivante repartirait en
      // parallèle de celle qui la précède.
      if (this.chains.get(delivery.serializationKey) === next) {
        this.chains.delete(delivery.serializationKey);
      }
    });
  }

  /**
   * Le consommateur — il traite, réessaie, et finit par enterrer.
   *
   * `setImmediate` rend d'abord la main à la boucle d'événements : la réponse
   * 200 part avant que la première requête SQL du traitement ne soit émise.
   * C'est ce qui distingue « mis en file » de « traité pendant que Stripe
   * attend ».
   *
   * **Cette méthode ne rejette jamais.** Ce n'est pas de la complaisance : elle
   * s'exécute sans appelant, et une promesse rejetée sans gestionnaire abattrait
   * le processus — ce qui perdrait, ironiquement, tout ce que la file est là
   * pour ne pas perdre.
   */
  private async deliver(delivery: SpooledDelivery): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    let attempt = delivery.attempts;

    for (;;) {
      attempt += 1;

      try {
        await this.webhooks.process(delivery.event);
        await this.complete(delivery);
        return;
      } catch (error: unknown) {
        const reason = describeFailure(error);

        if (!hasAttemptsLeft(attempt, this.retry)) {
          await this.bury(delivery, attempt, reason);
          return;
        }

        const delay = retryDelayMs(attempt, this.retry);

        if (!(await this.postpone(delivery, attempt, delay, reason))) {
          // La replanification elle-même a échoué : la base est probablement la
          // cause de la panne d'origine. La ligne garde son état, son bail
          // vieillit, et le balayage la reprendra — c'est très exactement le
          // filet que cette file existe pour tendre.
          return;
        }

        this.logger.warn(
          'stripe webhook: traitement en échec, réessai programmé',
          {
            eventId: delivery.event.eventId,
            eventType: delivery.event.eventType,
            tenantId: delivery.tenantId,
            attempt,
            maxAttempts: this.retry.maxAttempts,
            retryInMs: delay,
            error: reason,
          },
          DurableWebhookQueue.name,
        );

        if (this.stopping) {
          return;
        }

        await sleep(delay);

        if (this.stopping) {
          return;
        }
      }
    }
  }

  /** La livraison a abouti : la ligne disparaît, sa preuve reste ailleurs. */
  private async complete(delivery: SpooledDelivery): Promise<void> {
    try {
      await this.tenants.runWithTenant(delivery.tenantId, async () =>
        this.repository.completeDelivery(delivery.id),
      );
    } catch (error: unknown) {
      // L'effet est appliqué et marqué dans `processed_webhook_events` : la
      // seule conséquence est que la ligne de file survit à son travail. Le
      // balayage la reprendra, le traitement rendra `replayed`, et la ligne
      // s'effacera au tour suivant. Rien à réparer, donc — mais il faut le
      // dire, sans quoi une ligne « qui traîne » passerait pour un incident.
      this.logger.warn(
        'stripe webhook: livraison appliquée mais non retirée de la file — sera rejouée sans effet',
        { eventId: delivery.event.eventId, error: describeFailure(error) },
        DurableWebhookQueue.name,
      );
    }
  }

  /** Replanifie, et dit si la base l'a bien enregistré. */
  private async postpone(
    delivery: SpooledDelivery,
    attempts: number,
    delayMs: number,
    reason: string,
  ): Promise<boolean> {
    try {
      await this.tenants.runWithTenant(delivery.tenantId, async () =>
        this.repository.rescheduleDelivery(delivery.id, {
          attempts,
          nextAttemptAt: new Date(Date.now() + delayMs),
          lastError: reason,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * La file d'attente morte, et son alerte.
   *
   * Le journal de niveau `error` **est** l'alerte : c'est ce que CloudWatch sait
   * déclencher, et c'est la seule chaîne d'alerte que le MVP possède — la même
   * que celle d'un litige ouvert (payments-stripe §6). Il nomme ce qu'il faut
   * pour agir sans ouvrir le code : l'événement, l'établissement, le nombre de
   * tentatives, et la panne. Aucune donnée personnelle, aucune donnée de carte
   * (CDC §5.1, payments-stripe §1).
   */
  private async bury(
    delivery: SpooledDelivery,
    attempts: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.tenants.runWithTenant(delivery.tenantId, async () =>
        this.repository.deadLetterDelivery(delivery.id, { attempts, lastError: reason }),
      );
    } catch (error: unknown) {
      // La ligne reste `PENDING` et sera reprise : elle consommera ses
      // tentatives une fois de plus, puis rebutera ici. Une boucle lente et
      // bornée par la disponibilité de la base, plutôt qu'un événement perdu.
      //
      // Et surtout : **pas d'alerte d'abandon**. Rien n'a été abandonné, la
      // livraison est encore prenable, et paginer un humain pour « intervention
      // requise » sur un événement que le balayage va reprendre tout seul
      // rendrait l'alerte fausse — puis, au tour suivant, la ferait sonner deux
      // fois pour la même livraison. Le `warn` dit l'état réel ; l'alerte
      // partira quand la ligne sera vraiment morte.
      this.logger.warn(
        'stripe webhook: mise en file d’attente morte impossible, livraison laissée reprenable',
        { eventId: delivery.event.eventId, error: describeFailure(error) },
        DurableWebhookQueue.name,
      );
      return;
    }

    this.logger.error(
      'stripe webhook: livraison abandonnée après épuisement des réessais — intervention humaine requise',
      {
        eventId: delivery.event.eventId,
        eventType: delivery.event.eventType,
        tenantId: delivery.tenantId,
        attempts,
        error: reason,
      },
      DurableWebhookQueue.name,
    );
  }
}

/**
 * L'attente d'un réessai.
 *
 * Le minuteur n'est **pas** `unref`é, contrairement à celui du balayage : ce
 * qu'il retient est un travail dont quelqu'un attend le résultat — `whenIdle`,
 * l'arrêt du conteneur, une suite d'intégration. Le rendre invisible à la
 * boucle d'événements ferait sortir le processus au milieu d'un réessai, ce qui
 * est précisément l'événement perdu que cette file existe pour empêcher.
 * L'attente est bornée par `RetrySchedule`, à quelques secondes.
 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
