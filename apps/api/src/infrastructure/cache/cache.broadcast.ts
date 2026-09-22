import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { AppConfigService } from '../../config/app-config.service';
import { StructuredLogger } from '../../common/logging/structured-logger';

/**
 * Diffusion entre instances de l'API — `PUBLISH` / `SUBSCRIBE` Redis.
 *
 * ## Pourquoi elle existe
 *
 * Le bus d'événements du module `appointments` est **en mémoire** : un
 * rendez-vous posé par l'instance A n'est connu que d'elle. Or la production
 * tourne sur deux tâches ECS au moins (`infra/terraform/envs/prod`), et le
 * navigateur de la gérante peut tenir son flux ouvert sur l'instance B pendant
 * que la cliente réserve sur l'instance A. Sans relais, le planning « temps
 * réel » ne le serait qu'une fois sur deux.
 *
 * Redis est déjà là — ElastiCache, les verrous du moteur de réservation —, et son
 * `PUBLISH` est exactement ce dont le relais a besoin : une diffusion à tous les
 * abonnés du moment, sans mémoire. Un abonné absent ne reçoit rien, et c'est
 * voulu : ce qui passe ici est un **signal** (« ce rendez-vous a changé »), pas
 * un fait à conserver — l'écran qui le rate se relit à sa reconnexion.
 *
 * ## Deux connexions à elle, et aucune partagée avec `CacheConnection`
 *
 * Une connexion Redis passée en `SUBSCRIBE` n'accepte plus aucune autre
 * commande : elle ne peut donc pas être celle des verrous. La publication a la
 * sienne aussi, pour une raison moins évidente : `CacheConnection` borne ses
 * commandes à 200 ms parce qu'elles sont sur le chemin d'une réservation, et une
 * publication lente qui se mettrait dans sa file retarderait le verrou suivant.
 *
 * Les deux sont créées **à la première utilisation** : une instance que personne
 * n'écoute et qui ne publie rien — une suite de tests, un script — n'ouvre
 * aucune connexion.
 *
 * ## Elle ne rejette jamais
 *
 * Même régime que les verrous : une panne du cache dégrade le temps réel, elle ne
 * casse rien d'autre. `publish` rend `false` et journalise ; l'appelant a déjà
 * servi ses abonnés locaux, et les écrans des autres instances se rattraperont à
 * leur prochaine relecture.
 */

/**
 * Délai de garde d'une publication, en millisecondes.
 *
 * Plus large que celui des verrous (200 ms) : la publication part **après** la
 * réponse HTTP, hors du chemin de la réservation, et personne ne l'attend. Il ne
 * sert qu'à ne pas laisser une promesse pendante pour toujours quand Redis est
 * tombé.
 */
const PUBLISH_TIMEOUT_MS = 1_000;

/** Ce qu'un abonné reçoit : le corps du message, tel qu'il a été publié. */
export type BroadcastHandler = (message: string) => void;

@Injectable()
export class CacheBroadcast implements OnModuleDestroy {
  private publisher: Redis | null = null;

  private subscriber: Redis | null = null;

  /** Les abonnés locaux, par canal — un seul `SUBSCRIBE` Redis par canal. */
  private readonly handlers = new Map<string, Set<BroadcastHandler>>();

  public constructor(
    private readonly config: AppConfigService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Publie un message sur un canal. Rend `true` si Redis l'a accepté.
   *
   * Ne rejette jamais : voir l'en-tête.
   */
  public async publish(channel: string, message: string): Promise<boolean> {
    try {
      await bounded(this.publisherClient().publish(channel, message), PUBLISH_TIMEOUT_MS);
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `Diffusion Redis indisponible (canal « ${channel} ») : ${describe(error)} — ` +
          'les autres instances ne recevront pas ce signal.',
        CacheBroadcast.name,
      );
      return false;
    }
  }

  /**
   * Abonne un gestionnaire à un canal, et rend de quoi le désabonner.
   *
   * Le `SUBSCRIBE` Redis ne part qu'au **premier** abonné du canal, et
   * l'`UNSUBSCRIBE` au départ du dernier : une instance sans écran ouvert ne reçoit
   * rien de ce que les autres publient.
   *
   * Un gestionnaire qui lève est journalisé, jamais propagé : il partage la
   * boucle de réception avec les autres, et un seul fautif priverait tous les
   * suivants du message.
   */
  public subscribe(channel: string, handler: BroadcastHandler): () => void {
    let registered = this.handlers.get(channel);

    if (registered === undefined) {
      registered = new Set();
      this.handlers.set(channel, registered);
      this.subscriberClient()
        .subscribe(channel)
        .catch((error: unknown) => {
          this.logger.warn(
            `Abonnement Redis impossible (canal « ${channel} ») : ${describe(error)}.`,
            CacheBroadcast.name,
          );
        });
    }

    const set = registered;
    set.add(handler);

    return () => {
      set.delete(handler);

      if (set.size === 0 && this.handlers.get(channel) === set) {
        this.handlers.delete(channel);
        this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  public async onModuleDestroy(): Promise<void> {
    await Promise.all([close(this.publisher), close(this.subscriber)]);
    this.publisher = null;
    this.subscriber = null;
    this.handlers.clear();
  }

  private publisherClient(): Redis {
    this.publisher ??= this.connect({ maxRetriesPerRequest: 1 });
    return this.publisher;
  }

  /**
   * La connexion d'écoute.
   *
   * `maxRetriesPerRequest: null` : un `SUBSCRIBE` envoyé pendant que Redis est
   * injoignable attend la reconnexion au lieu d'échouer. Sans cela, un abonnement
   * pris pendant une coupure serait perdu pour de bon — `autoResubscribe` ne
   * rejoue que les canaux effectivement souscrits.
   */
  private subscriberClient(): Redis {
    if (this.subscriber === null) {
      const client = this.connect({ maxRetriesPerRequest: null });

      client.on('message', (channel: string, message: string) => {
        this.deliver(channel, message);
      });

      this.subscriber = client;
    }

    return this.subscriber;
  }

  private connect(options: { readonly maxRetriesPerRequest: number | null }): Redis {
    const client = new Redis(this.config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      maxRetriesPerRequest: options.maxRetriesPerRequest,
      retryStrategy: (attempt: number): number => Math.min(attempt * 200, 2_000),
    });

    // Un `error` non écouté sur un client ioredis termine le processus.
    client.on('error', (error: Error) => {
      this.logger.debug(`Erreur du client Redis de diffusion : ${error.message}`, CacheBroadcast.name);
    });

    return client;
  }

  private deliver(channel: string, message: string): void {
    for (const handler of this.handlers.get(channel) ?? []) {
      try {
        handler(message);
      } catch (error: unknown) {
        this.logger.error(
          `Abonné de diffusion en échec (canal « ${channel} ») : ${describe(error)}.`,
          CacheBroadcast.name,
        );
      }
    }
  }
}

/**
 * La commande, ou un rejet au bout du délai. Le `catch` posé sur la commande lui
 * donne un auditeur quand le délai gagne — voir `CacheConnection.bounded`.
 */
function bounded<T>(command: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`commande Redis abandonnée après ${timeoutMs} ms`)),
      timeoutMs,
    );
  });

  command.catch(() => undefined);

  return Promise.race([command, guard]).finally(() => {
    clearTimeout(timer);
  });
}

/** Même prudence que `CacheConnection.onModuleDestroy`. */
async function close(client: Redis | null): Promise<void> {
  if (client === null) {
    return;
  }

  if (client.status === 'end' || client.status === 'wait') {
    client.disconnect();
    return;
  }

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
