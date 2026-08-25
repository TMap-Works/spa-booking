import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../common/logging/structured-logger';
import { CacheConnection } from '../infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../infrastructure/database/database.connection';

/**
 * Sonde de vivacité des dépendances.
 *
 * « Vérifiant réellement la base et le cache » se prend au mot : on n'inspecte
 * pas un état de connexion mis en cache par le pilote, on exécute une commande
 * (`SELECT 1`, `PING`). Un pool qui se croit connecté à une base tombée est
 * précisément le cas qu'une sonde doit attraper.
 *
 * Le corps de réponse ne dit **jamais pourquoi** une dépendance est tombée : le
 * message d'erreur d'un pilote cite l'hôte, le port et parfois l'utilisateur de
 * connexion. `/health` est interrogeable par l'ALB comme par n'importe qui ;
 * le détail va dans le journal.
 */

export type DependencyStatus = 'up' | 'down';

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
}

export interface HealthReport {
  status: 'ok' | 'error';
  checks: {
    database: DependencyCheck;
    cache: DependencyCheck;
  };
}

/** Au-delà, la dépendance est considérée tombée, même si elle finit par répondre. */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

class ProbeTimeoutError extends Error {
  public constructor(ms: number) {
    super(`sonde sans réponse après ${ms} ms`);
    this.name = 'ProbeTimeoutError';
  }
}

/**
 * Borne une sonde dans le temps. Sans cela, une base injoignable tient la
 * requête HTTP ouverte jusqu'au délai TCP — et l'ALB conclut à un
 * dépassement de délai au lieu de lire un 503 explicite.
 */
async function withTimeout(operation: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // La sonde perdante continue de vivre : sans ce `catch`, son rejet
      // ultérieur remonterait en `unhandledRejection`.
      operation.catch((error: unknown) => {
        throw error;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

@Injectable()
export class HealthService {
  public constructor(
    private readonly database: DatabaseConnection,
    private readonly cache: CacheConnection,
    private readonly logger: StructuredLogger,
  ) {}

  public async check(): Promise<HealthReport> {
    // En parallèle : le temps de réponse de la sonde est celui de la dépendance
    // la plus lente, pas leur somme.
    const [database, cache] = await Promise.all([
      this.probe('database', () => this.database.ping()),
      this.probe('cache', () => this.cache.ping()),
    ]);

    const status = database.status === 'up' && cache.status === 'up' ? 'ok' : 'error';
    return { status, checks: { database, cache } };
  }

  private async probe(name: string, run: () => Promise<void>): Promise<DependencyCheck> {
    const startedAt = process.hrtime.bigint();
    try {
      await withTimeout(run(), HEALTH_PROBE_TIMEOUT_MS);
      return { status: 'up', latencyMs: elapsedMs(startedAt) };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Sonde « ${name} » en échec : ${reason}`, HealthService.name);
      return { status: 'down', latencyMs: elapsedMs(startedAt) };
    }
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
