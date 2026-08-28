import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { AppConfigService } from '../../../config/app-config.service';
import { RedisAvailabilityCacheStore } from '../availability-cache.redis';

/**
 * L'entrepôt Redis du cache de disponibilité — #35.
 *
 * ## Ce que cette suite existe pour tenir
 *
 * La propriété qu'annonce l'en-tête de `availability-cache.redis.ts`, et la
 * seule qui, si elle cédait, transformerait une panne de cache en panne du
 * parcours de réservation :
 *
 * > **aucune des trois méthodes ne rejette.**
 *
 * Elle ne se relit pas. Un `await` déplacé hors du `try`, un `catch` oublié sur
 * un chemin ajouté plus tard, et la promesse casse sans qu'aucune autre suite ne
 * rougisse : les harnais d'intégration substituent l'entrepôt en mémoire, et les
 * tests unitaires du service parlent au port, jamais à ioredis. C'est donc ici,
 * et nulle part ailleurs, que le comportement de cet adaptateur est exercé.
 *
 * S'y ajoutent les trois formes de commande dont dépend le budget de 300 ms du
 * quatrième critère — **un** `MGET` pour toute la plage, un pipeline de `SET`
 * qui portent chacun leur `EX`, un `SCAN`/`UNLINK` borné — et l'échappement du
 * préfixe, qui est la frontière d'isolation du cache (tenant-isolation §5).
 *
 * ## Un double d'ioredis, et pas un Redis
 *
 * `jest.unit.config.js` le dit en en-tête : les tests unitaires passent sur une
 * machine sans infrastructure, sans Postgres et sans Redis. Le client est donc
 * doublé — ce qui donne en prime ce qu'un vrai serveur ne donnerait pas : la
 * liste exacte des commandes envoyées, donc la preuve du **nombre**
 * d'allers-retours, qui est la raison d'être de `MGET` et du pipeline.
 */

/** La dernière instance rendue au code sous test — voir le `jest.mock` ci-dessous. */
let mockClient: FakeRedis;

jest.mock('ioredis', () => ({
  __esModule: true,
  // `new Redis(...)` rend l'objet que la fabrique retourne.
  default: function MockRedis(): unknown {
    return mockClient;
  },
}));

/** Une commande envoyée : son nom, puis ses arguments. */
type SentCommand = readonly [string, ...unknown[]];

/**
 * Le client, réduit à ce que l'entrepôt lui demande.
 *
 * `failWith` bascule l'ensemble en panne : c'est ainsi qu'on exerce « un cache
 * injoignable est un cache vide » sans couper de socket.
 */
class FakeRedis {
  public status: 'wait' | 'ready' | 'end' = 'ready';
  public readonly sent: SentCommand[] = [];
  public readonly values = new Map<string, string>();
  /** Réponses successives de `SCAN` ; épuisées, on rend un curseur clos. */
  public scanReplies: [string, string[]][] = [];
  public failWith: Error | null = null;
  public quitCalls = 0;
  public disconnectCalls = 0;

  public on(): this {
    return this;
  }

  public scan(...args: unknown[]): Promise<[string, string[]]> {
    return this.record(['scan', ...args], () => this.scanReplies.shift() ?? ['0', []]);
  }

  public unlink(...keys: string[]): Promise<number> {
    return this.record(['unlink', ...keys], () => keys.length);
  }

  public mget(...keys: string[]): Promise<(string | null)[]> {
    return this.record(['mget', ...keys], () => keys.map((key) => this.values.get(key) ?? null));
  }

  public pipeline(): { set: (...args: unknown[]) => unknown; exec: () => Promise<unknown> } {
    const pipeline = {
      set: (...args: unknown[]): unknown => {
        this.sent.push(['set', ...args]);
        return pipeline;
      },
      exec: (): Promise<unknown> => this.record(['exec'], () => []),
    };

    return pipeline;
  }

  public quit(): Promise<'OK'> {
    this.quitCalls += 1;
    return Promise.resolve('OK');
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
  }

  /** Les commandes envoyées, noms seuls — l'assertion du nombre d'allers-retours. */
  public get names(): string[] {
    return this.sent.map(([name]) => name);
  }

  private record<T>(command: SentCommand, reply: () => T): Promise<T> {
    this.sent.push(command);

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

function createStore(): RedisAvailabilityCacheStore {
  return new RedisAvailabilityCacheStore(
    { redisUrl: 'redis://cache.invalid:6379' } as unknown as AppConfigService,
    silentLogger(),
  );
}

const KEY_A = 'avail:t1:s1:any:2026-09-01';
const KEY_B = 'avail:t1:s1:any:2026-09-02';

describe('RedisAvailabilityCacheStore — lecture', () => {
  let store: RedisAvailabilityCacheStore;

  beforeEach(() => {
    mockClient = new FakeRedis();
    store = createStore();
  });

  it('lit toute la plage en un seul aller-retour', async () => {
    // La raison d'être de `MGET` : une plage de trente et un jours ne doit pas
    // coûter trente et un allers-retours sur un chemin budgété à 300 ms.
    mockClient.values.set(KEY_A, '{"a":1}');

    await expect(store.readMany([KEY_A, KEY_B])).resolves.toEqual(['{"a":1}', null]);
    expect(mockClient.names).toEqual(['mget']);
  });

  it('rend un défaut par clé demandée quand le cache est injoignable', async () => {
    // L'appelant doit pouvoir traiter la panne exactement comme un cache froid :
    // autant de `null` que de clés, dans le même ordre, et aucun rejet.
    mockClient.failWith = new Error('ECONNREFUSED');

    await expect(store.readMany([KEY_A, KEY_B])).resolves.toEqual([null, null]);
  });

  it('n’envoie rien pour une lecture sans clé', async () => {
    // `MGET` sans argument est une erreur de syntaxe Redis, et l'aller-retour
    // serait payé pour rien.
    await expect(store.readMany([])).resolves.toEqual([]);
    expect(mockClient.sent).toHaveLength(0);
  });
});

describe('RedisAvailabilityCacheStore — écriture', () => {
  let store: RedisAvailabilityCacheStore;

  beforeEach(() => {
    mockClient = new FakeRedis();
    store = createStore();
  });

  it('écrit chaque entrée avec son propre TTL, en un pipeline', async () => {
    // `MSET` ne sait pas poser de durée de vie : des clés de disponibilité sans
    // TTL survivraient à toute panne d'invalidation.
    await store.writeMany(
      [
        { key: KEY_A, value: '{"a":1}' },
        { key: KEY_B, value: '{"b":2}' },
      ],
      60,
    );

    expect(mockClient.sent).toEqual([
      ['set', KEY_A, '{"a":1}', 'EX', 60],
      ['set', KEY_B, '{"b":2}', 'EX', 60],
      ['exec'],
    ]);
  });

  it('perd l’écriture sans faire échouer la requête qui l’a produite', async () => {
    // Refuser la réponse parce que le cache n'a pas pu la retenir échangerait
    // une vente contre au plus soixante secondes de recalcul.
    mockClient.failWith = new Error('ECONNREFUSED');

    await expect(store.writeMany([{ key: KEY_A, value: '{}' }], 60)).resolves.toBeUndefined();
  });

  it('n’envoie rien pour une écriture sans entrée', async () => {
    await expect(store.writeMany([], 60)).resolves.toBeUndefined();
    expect(mockClient.sent).toHaveLength(0);
  });
});

describe('RedisAvailabilityCacheStore — invalidation', () => {
  let store: RedisAvailabilityCacheStore;

  beforeEach(() => {
    mockClient = new FakeRedis();
    store = createStore();
  });

  it('balaye jusqu’au retour du curseur et délie ce qu’il trouve', async () => {
    mockClient.scanReplies = [
      ['42', [KEY_A]],
      ['0', [KEY_B]],
    ];

    await store.evictByPrefix('avail:t1:');

    expect(mockClient.names).toEqual(['scan', 'unlink', 'scan', 'unlink']);
    expect(mockClient.sent[1]).toEqual(['unlink', KEY_A]);
    expect(mockClient.sent[3]).toEqual(['unlink', KEY_B]);
  });

  it('ne délie rien quand l’itération ne rend aucune clé', async () => {
    // `UNLINK` sans argument est une erreur de syntaxe : le garde-fou compte.
    mockClient.scanReplies = [['0', []]];

    await store.evictByPrefix('avail:t1:');

    expect(mockClient.names).toEqual(['scan']);
  });

  it('neutralise les métacaractères du préfixe', async () => {
    // Un `*` glissé dans un préfixe ferait déborder l'invalidation d'un
    // établissement sur ses voisins — la frontière que la clé existe pour tenir
    // (tenant-isolation §5). Le tiret des UUID est échappé au passage, ce que
    // Redis relit bien comme un tiret littéral.
    await store.evictByPrefix('avail:9f1a-2b*:');

    expect(mockClient.sent[0]).toEqual([
      'scan',
      '0',
      'MATCH',
      'avail:9f1a\\-2b\\*:*',
      'COUNT',
      500,
    ]);
  });

  it('abandonne plutôt que de tenir la requête HTTP indéfiniment', async () => {
    // `SCAN` ne promet que de finir par rendre zéro. Un espace de clés qui
    // grossit plus vite qu'on ne le balaye tiendrait la boucle sans fin, sur le
    // fil d'une réservation déjà commitée.
    mockClient.scanReplies = Array.from({ length: 1_000 }, (): [string, string[]] => ['42', []]);

    await store.evictByPrefix('avail:t1:');

    // `MAX_SCAN_ITERATIONS`, non exporté : la borne est vérifiée par son effet.
    expect(mockClient.names).toHaveLength(200);
  });

  it('avale l’échec — le rendez-vous vient d’être posé', async () => {
    // Le cas le plus coûteux si la promesse rejetait : l'écriture en base a déjà
    // commité, et la réservation remonterait une erreur pour un rendez-vous bel
    // et bien pris.
    mockClient.failWith = new Error('ECONNREFUSED');

    await expect(store.evictByPrefix('avail:t1:')).resolves.toBeUndefined();
  });
});

describe('RedisAvailabilityCacheStore — cycle de vie', () => {
  beforeEach(() => {
    mockClient = new FakeRedis();
  });

  it('n’ouvre aucune connexion tant qu’aucune commande n’est envoyée', async () => {
    // Nest instancie ses fournisseurs avec impatience : ouvrir la socket au
    // constructeur ferait de chaque suite de test un client Redis de plus.
    const store = createStore();

    await store.onModuleDestroy();

    expect(mockClient.quitCalls).toBe(0);
    expect(mockClient.disconnectCalls).toBe(0);
  });

  it('négocie la fermeture d’un client connecté', async () => {
    const store = createStore();
    await store.readMany([KEY_A]);

    await store.onModuleDestroy();

    expect(mockClient.quitCalls).toBe(1);
  });

  it('coupe sans négocier un client jamais connecté', async () => {
    // `quit()` sur un client en `wait` ou en `end` reste en attente
    // indéfiniment — même conduite que `CacheConnection`.
    const store = createStore();
    await store.readMany([KEY_A]);
    mockClient.status = 'wait';

    await store.onModuleDestroy();

    expect(mockClient.quitCalls).toBe(0);
    expect(mockClient.disconnectCalls).toBe(1);
  });
});
