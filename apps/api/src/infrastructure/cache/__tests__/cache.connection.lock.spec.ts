import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import { CacheConnection } from '../cache.connection';

/**
 * La primitive de verrou de `CacheConnection` — #38.
 *
 * ## Ce que cette suite existe pour tenir
 *
 * La propriété dont dépend le troisième critère du ticket, et la seule qui, si
 * elle cédait, transformerait une panne de cache en panne de la caisse :
 *
 * > **ni `acquireLock` ni `releaseLock` ne rejettent, et « pris » n'est jamais
 * > confondu avec « injoignable ».**
 *
 * Elle ne se relit pas dans le code : un `await` sorti du `try`, un booléen
 * rendu à la place du tri-état, et le chemin de réservation se met à refuser des
 * créneaux libres dès que Redis tousse. Aucune autre suite ne le verrait — les
 * harnais d'intégration substituent la connexion, et `SlotLockService` parle à
 * cette classe, jamais à ioredis.
 *
 * S'y ajoute la **forme exacte des commandes** : `SET … EX … NX` et non deux
 * commandes, une libération par script conditionnel et non un `DEL` nu. Ce sont
 * les deux endroits où une réécriture bien intentionnée casserait le verrou sans
 * rien faire échouer.
 *
 * ## Un double d'ioredis, et pas un Redis
 *
 * `jest.unit.config.js` l'exige : les tests unitaires passent sans
 * infrastructure. Le double donne en prime ce qu'un vrai serveur ne donnerait
 * pas — la liste des commandes envoyées, donc la preuve de leur forme.
 */

/** La dernière instance rendue au code sous test — voir le `jest.mock` ci-dessous. */
let mockClient: FakeRedis;

jest.mock('ioredis', () => ({
  __esModule: true,
  default: function MockRedis(): unknown {
    return mockClient;
  },
}));

type SentCommand = readonly [string, ...unknown[]];

/** Le client, réduit à ce que la connexion lui demande. */
class FakeRedis {
  public status: 'wait' | 'ready' | 'end' = 'ready';
  public readonly sent: SentCommand[] = [];
  /** Réponse de `SET` : `'OK'` quand `NX` mord, `null` quand la clé existe. */
  public setReply: 'OK' | null = 'OK';
  /** Ce que le script de libération rend : 1 si la clé était nôtre, 0 sinon. */
  public evalReply: number = 1;
  public failWith: Error | null = null;
  /** Les commandes ne se règlent jamais — exerce le délai de garde. */
  public hang = false;

  public on(): this {
    return this;
  }

  public set(...args: unknown[]): Promise<'OK' | null> {
    return this.record(['set', ...args], () => this.setReply);
  }

  public eval(...args: unknown[]): Promise<number> {
    return this.record(['eval', ...args], () => this.evalReply);
  }

  public ping(): Promise<string> {
    return this.record(['ping'], () => 'PONG');
  }

  public quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }

  public disconnect(): void {
    this.status = 'end';
  }

  public get names(): string[] {
    return this.sent.map(([name]) => name);
  }

  /** La dernière commande envoyée, arguments compris. */
  public get last(): SentCommand {
    return this.sent[this.sent.length - 1] as SentCommand;
  }

  private record<T>(command: SentCommand, reply: () => T): Promise<T> {
    this.sent.push(command);

    if (this.hang) {
      return new Promise<T>(() => undefined);
    }

    return this.failWith === null ? Promise.resolve(reply()) : Promise.reject(this.failWith);
  }
}

function silentLogger(): StructuredLogger {
  return {
    error: (): void => undefined,
    warn: (): void => undefined,
    debug: (): void => undefined,
  } as unknown as StructuredLogger;
}

function createConnection(): CacheConnection {
  return new CacheConnection(
    { redisUrl: 'redis://cache.invalid:6379' } as unknown as AppConfigService,
    silentLogger(),
  );
}

const KEY = 'slot:tenant-1:staff-1:2026-09-01T10:00:00.000Z';

describe('CacheConnection — prise de verrou', () => {
  let cache: CacheConnection;

  beforeEach(() => {
    mockClient = new FakeRedis();
    cache = createConnection();
  });

  it('pose le verrou en une seule commande `SET … EX … NX`', async () => {
    // Une commande et une seule : un `EXISTS` suivi d'un `SET` laisserait entre
    // les deux la fenêtre que `NX` existe pour supprimer.
    const outcome = await cache.acquireLock(KEY, 10);

    expect(outcome.state).toBe('acquired');
    expect(mockClient.names).toEqual(['set']);
    expect(mockClient.last).toEqual([
      'set',
      KEY,
      expect.any(String),
      'EX',
      10,
      'NX',
    ]);
  });

  it('rend « pris » — et non une erreur — quand la clé existe déjà', async () => {
    // C'est le cas nominal de contention : quelqu'un d'autre écrit ce créneau.
    mockClient.setReply = null;

    await expect(cache.acquireLock(KEY, 10)).resolves.toEqual({ state: 'taken' });
  });

  it('rend « injoignable » quand Redis est tombé, jamais « pris »', async () => {
    // La distinction est tout le ticket : confondre les deux ferait refuser
    // toutes les réservations pendant une panne de cache.
    mockClient.failWith = new Error('ECONNREFUSED 127.0.0.1:6379');

    await expect(cache.acquireLock(KEY, 10)).resolves.toEqual({ state: 'unavailable' });
  });

  it('abandonne une commande qui ne répond pas, plutôt que de retenir la réservation', async () => {
    // Un cache qui met cinq secondes à répondre a déjà coûté plus cher que son
    // absence : le délai de garde rend la main, et l'appelant réserve sans lui.
    jest.useFakeTimers();
    mockClient.hang = true;

    try {
      const pending = cache.acquireLock(KEY, 10);
      await jest.advanceTimersByTimeAsync(500);

      await expect(pending).resolves.toEqual({ state: 'unavailable' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('tire un jeton différent à chaque prise', async () => {
    // Le jeton est ce qui rend la libération sûre : deux prises qui
    // partageraient le même laisseraient l'une supprimer le verrou de l'autre.
    const first = await cache.acquireLock(KEY, 10);
    const second = await cache.acquireLock(KEY, 10);

    expect(first).toMatchObject({ state: 'acquired' });
    expect(second).toMatchObject({ state: 'acquired' });
    expect(first).not.toEqual(second);
  });
});

describe('CacheConnection — libération de verrou', () => {
  let cache: CacheConnection;

  beforeEach(() => {
    mockClient = new FakeRedis();
    cache = createConnection();
  });

  it('libère par script conditionnel, en passant le jeton', async () => {
    // Un `DEL` nu supprimerait le verrou d'un autre appelant dès que le nôtre a
    // expiré entre-temps. Le script compare avant de supprimer, atomiquement.
    const outcome = await cache.acquireLock(KEY, 10);

    if (outcome.state !== 'acquired') {
      throw new Error('le verrou aurait dû être pris');
    }

    await cache.releaseLock(KEY, outcome.token);

    expect(mockClient.names).toEqual(['set', 'eval']);
    expect(mockClient.last).toEqual([
      'eval',
      expect.stringContaining("redis.call('del', KEYS[1])"),
      1,
      KEY,
      outcome.token,
    ]);
  });

  it('ne rejette pas quand la libération échoue', async () => {
    // La libération ratée n'a aucune conséquence sur l'écriture déjà validée, et
    // le TTL relâche de lui-même. Rejeter ici remplacerait, depuis un `finally`,
    // l'erreur de l'appelant par celle du cache.
    mockClient.failWith = new Error('ECONNRESET');

    await expect(cache.releaseLock(KEY, 'un-jeton')).resolves.toBeUndefined();
  });
});
