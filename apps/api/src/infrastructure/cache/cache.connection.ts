import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { AppConfigService } from '../../config/app-config.service';
import { StructuredLogger } from '../../common/logging/structured-logger';

/**
 * Client Redis unique, partagé par l'application : cache de lecture et verrous
 * courts du moteur de réservation (ARCHITECTURE.md — le verrou Redis améliore
 * l'UX, il ne garantit rien ; la garantie vient de la contrainte d'exclusion).
 *
 * `lazyConnect` est délibéré : le conteneur démarre même si ElastiCache n'est
 * pas encore joignable, et `/health` le rapporte. Le `retryStrategy` continue de
 * tenter en arrière-plan, avec un plafond, pour qu'un cache revenu soit repris
 * sans redémarrage.
 */
@Injectable()
export class CacheConnection implements OnModuleDestroy {
  private readonly client: Redis;

  public constructor(config: AppConfigService, logger: StructuredLogger) {
    this.client = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2_000,
      // Une commande de sonde ne doit pas s'éterniser en réessais internes :
      // c'est le rôle du délai de garde de `/health`, pas celui du client.
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt: number): number => Math.min(attempt * 200, 2_000),
    });

    // Idem PostgreSQL : un `error` non écouté sur un client ioredis termine le
    // processus. Le message est journalisé, jamais renvoyé au client HTTP.
    this.client.on('error', (error: Error) => {
      logger.debug(`Erreur du client Redis : ${error.message}`, CacheConnection.name);
    });
  }

  /** `PING` réel — déclenche la connexion si elle n'est pas encore établie. */
  public async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`réponse inattendue au PING Redis : ${reply}`);
    }
  }

  public async onModuleDestroy(): Promise<void> {
    // `quit()` sur un client jamais connecté (`wait`) ou déjà fermé (`end`)
    // reste en attente indéfiniment : on coupe alors sans négocier.
    if (this.client.status === 'end' || this.client.status === 'wait') {
      this.client.disconnect();
      return;
    }
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
