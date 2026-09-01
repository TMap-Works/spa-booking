import { randomUUID } from 'node:crypto';

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
 *
 * ## Les verrous courts, ajoutés par #38
 *
 * `acquireLock` / `releaseLock` sont la primitive `SET NX EX` que l'ADR 0002
 * appelle « confort d'interface », et que l'en-tête ci-dessus annonçait sans
 * qu'aucune méthode ne la porte. Elles n'appartiennent à aucun module métier :
 * la clé est décidée par l'appelant, cette classe ne connaît que la commande.
 *
 * Trois propriétés les gouvernent, et ce sont elles que
 * `__tests__/cache.connection.lock.spec.ts` verrouille :
 *
 * 1. **elles ne rejettent jamais.** Une panne du cache rend `unavailable`, que
 *    l'appelant traite comme « pas de verrou » — jamais comme « créneau pris ».
 *    C'est le troisième critère de #38 : une panne Redis dégrade l'expérience,
 *    elle ne casse pas une réservation ;
 * 2. **elles distinguent « pris » de « injoignable ».** Un booléen les
 *    confondrait, et une panne de Redis refuserait alors toutes les
 *    réservations — exactement l'inverse de ce que ce verrou existe pour faire ;
 * 3. **la libération est conditionnée à un jeton.** Un `DEL` nu supprimerait le
 *    verrou d'un autre appelant dès que le nôtre a expiré entre-temps ;
 * 4. **une prise abandonnée ne laisse pas de verrou derrière elle.** Le délai de
 *    garde arrête l'attente, pas la commande : un Redis lent la joue quand même,
 *    et la clé serait tenue pour tout le TTL par un jeton que personne ne
 *    détient. Voir `forfeit`.
 */

/**
 * Délai de garde d'une commande de verrou, en millisecondes.
 *
 * Même chiffre, et même raison, que le `commandTimeout` de
 * `availability-cache.redis.ts` : le verrou est posé sur le chemin d'une
 * réservation, et un cache qui met cinq secondes à répondre « c'est pris » a
 * déjà coûté plus cher que son absence. Au-delà, la commande est abandonnée et
 * l'état rendu est `unavailable` — donc le chemin dégradé, qui réserve.
 *
 * Le délai est posé ici plutôt qu'en `commandTimeout` sur le client parce que ce
 * client est **partagé** : `/health` a son propre délai de garde, plus large, et
 * une option globale le lui retirerait.
 */
const LOCK_COMMAND_TIMEOUT_MS = 200;

/**
 * Libération conditionnelle : on ne supprime que **son propre** verrou.
 *
 * Sans la comparaison, la séquence suivante supprime le verrou d'autrui : A pose
 * le verrou, met plus longtemps que le TTL, le verrou expire, B le repose, A
 * termine et fait `DEL`. B se retrouve alors sans verrou alors qu'il croit le
 * tenir. Le script est atomique côté serveur, ce qu'un `GET` suivi d'un `DEL`
 * depuis Node ne serait pas.
 */
const RELEASE_IF_MINE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

/**
 * Ce qu'une demande de verrou a produit — trois états, jamais une exception.
 *
 * `taken` et `unavailable` sont **deux choses différentes**, et les confondre
 * est le défaut que ce type existe pour rendre impossible : le premier dit
 * qu'un autre appelant tient le créneau, le second que le cache n'a rien pu
 * dire. Un appelant qui refuserait sur `unavailable` ferait d'une panne Redis
 * une panne de la réservation.
 */
export type CacheLockOutcome =
  | { readonly state: 'acquired'; readonly token: string }
  | { readonly state: 'taken' }
  | { readonly state: 'unavailable' };

@Injectable()
export class CacheConnection implements OnModuleDestroy {
  private readonly client: Redis;

  public constructor(
    config: AppConfigService,
    private readonly logger: StructuredLogger,
  ) {
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
      this.logger.debug(`Erreur du client Redis : ${error.message}`, CacheConnection.name);
    });
  }

  /** `PING` réel — déclenche la connexion si elle n'est pas encore établie. */
  public async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`réponse inattendue au PING Redis : ${reply}`);
    }
  }

  /**
   * `SET <clé> <jeton> EX <ttl> NX` — pose le verrou s'il est libre.
   *
   * Le jeton rendu n'a qu'un usage : le repasser à `releaseLock`. Il n'est
   * dérivé de rien — surtout pas de la clé —, si bien qu'un appelant ne peut pas
   * fabriquer celui d'un autre.
   *
   * Le TTL n'est pas facultatif, et c'est structurel : un verrou sans expiration
   * qu'un processus abattu laisserait derrière lui bloquerait son créneau pour
   * toujours. C'est l'appelant qui le choisit, parce que lui seul sait combien de
   * temps dure ce qu'il protège.
   */
  public async acquireLock(key: string, ttlSeconds: number): Promise<CacheLockOutcome> {
    const token = randomUUID();
    // La commande est retenue dans une variable plutôt qu'attendue sur place :
    // quand le délai de garde gagne, il reste à savoir ce qu'elle a fini par
    // faire. Voir `forfeit`.
    const command = this.client.set(key, token, 'EX', ttlSeconds, 'NX');

    try {
      const reply = await this.bounded(command);

      // `null` est la réponse de Redis quand `NX` n'a pas mordu : la clé existe
      // déjà, donc quelqu'un d'autre tient le verrou.
      return reply === 'OK' ? { state: 'acquired', token } : { state: 'taken' };
    } catch (error: unknown) {
      this.degrade('prise de verrou', key, error);
      this.forfeit(command, key, token);

      return { state: 'unavailable' };
    }
  }

  /**
   * Libère le verrou **si le jeton est le nôtre** — sinon ne fait rien.
   *
   * Ne rejette pas davantage qu'`acquireLock` : l'échec de la libération n'a
   * aucune conséquence sur l'écriture qui vient d'avoir lieu, et le TTL rattrape
   * de lui-même un verrou resté posé.
   */
  public async releaseLock(key: string, token: string): Promise<void> {
    try {
      await this.bounded(this.client.eval(RELEASE_IF_MINE, 1, key, token));
    } catch (error: unknown) {
      this.degrade('libération de verrou', key, error);
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

  /**
   * La commande, ou un rejet au bout de `LOCK_COMMAND_TIMEOUT_MS`.
   *
   * Le `catch` posé sur `command` n'est pas redondant avec la course : quand le
   * délai de garde gagne, la commande d'origine n'a plus d'auditeur, et son rejet
   * tardif — une socket qui se ferme une seconde plus tard — terminerait le
   * processus Node en rejet non traité. Ce puits lui donne un auditeur qui ne
   * fait rien, sans rien changer à ce que la course a déjà rendu.
   */
  private bounded<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`commande Redis abandonnée après ${LOCK_COMMAND_TIMEOUT_MS} ms`)),
        LOCK_COMMAND_TIMEOUT_MS,
      );
    });

    command.catch(() => undefined);

    return Promise.race([command, guard]).finally(() => {
      clearTimeout(timer);
    });
  }

  /**
   * Le verrou qu'on a cessé d'attendre, relâché s'il finit par se poser.
   *
   * Abandonner la commande ne l'annule pas : elle est déjà partie sur la socket,
   * et un Redis **lent** — pas tombé — l'exécute quelques centaines de
   * millisecondes plus tard. La clé serait alors tenue par un jeton que plus
   * personne ne détient, pour tout le TTL, et refuserait le créneau à des
   * appelants qui n'ont aucun concurrent. C'est l'exact contraire du troisième
   * critère de #38 : un cache lent dégrade l'expérience, il ne refuse pas une
   * réservation. L'appelant a déjà reçu `unavailable` et écrit sans verrou : ce
   * verrou-là n'est à personne, il n'a donc rien à garder.
   *
   * La libération passe par le même script conditionné au jeton : si la commande
   * a finalement échoué et qu'un autre appelant a posé le sien entre-temps, elle
   * ne fait rien.
   */
  private forfeit(command: Promise<unknown>, key: string, token: string): void {
    void command.then(
      (reply) => (reply === 'OK' ? this.releaseLock(key, token) : undefined),
      // La commande a rejeté : rien n'a été posé, il n'y a rien à relâcher.
      () => undefined,
    );
  }

  /**
   * Journalise la panne et rend la main — le verrou se tait, la réservation
   * continue.
   *
   * En `warn` et non en `error` : ce n'est pas un incident applicatif, c'est le
   * mode dégradé prévu. La clé y figure parce qu'elle porte l'établissement et le
   * créneau, ce qui est ce qu'on veut savoir en lisant le journal — et rien
   * d'une donnée personnelle, le `StructuredLogger` élaguant de toute façon ce
   * qui y ressemblerait.
   */
  private degrade(operation: string, key: string, error: unknown): void {
    this.logger.warn(
      `Verrou Redis indisponible (${operation}, « ${key} ») : ${describe(error)} — ` +
        'la réservation se poursuit sans lui.',
      CacheConnection.name,
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
