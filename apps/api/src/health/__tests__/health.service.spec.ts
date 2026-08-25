import type { StructuredLogger } from '../../common/logging/structured-logger';
import type { CacheConnection } from '../../infrastructure/cache/cache.connection';
import type { DatabaseConnection } from '../../infrastructure/database/database.connection';
import { HEALTH_PROBE_TIMEOUT_MS, HealthService } from '../health.service';

function build(database: () => Promise<void>, cache: () => Promise<void>) {
  const logger = { warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
  const service = new HealthService(
    { ping: database } as unknown as DatabaseConnection,
    { ping: cache } as unknown as CacheConnection,
    logger as unknown as StructuredLogger,
  );
  return { service, logger };
}

const up = (): Promise<void> => Promise.resolve();
const down = (message = 'connect ECONNREFUSED 127.0.0.1:5432'): (() => Promise<void>) =>
  () => Promise.reject(new Error(message));

describe('HealthService', () => {
  it('rapporte ok quand les deux dépendances répondent', async () => {
    const { service } = build(up, up);

    const report = await service.check();

    expect(report.status).toBe('ok');
    expect(report.checks.database.status).toBe('up');
    expect(report.checks.cache.status).toBe('up');
  });

  it.each([
    { failing: 'database', database: down(), cache: up },
    { failing: 'cache', database: up, cache: down('Connection is closed.') },
  ])('rapporte error dès que $failing tombe', async ({ failing, database, cache }) => {
    const { service } = build(database, cache);

    const report = await service.check();

    expect(report.status).toBe('error');
    expect(report.checks[failing as 'database' | 'cache'].status).toBe('down');
  });

  it('n’expose ni la cause ni l’hôte de la panne dans le rapport', async () => {
    const { service } = build(down('connect ECONNREFUSED 10.0.3.14:5432 (spa@prod-db)'), up);

    const report = await service.check();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('10.0.3.14');
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('prod-db');
    expect(Object.keys(report.checks.database).sort()).toEqual(['latencyMs', 'status']);
  });

  it('journalise la cause détaillée, elle, côté serveur', async () => {
    const { service, logger } = build(down('connect ECONNREFUSED 10.0.3.14:5432'), up);

    await service.check();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toContain('ECONNREFUSED');
  });

  it('conclut à une panne quand une sonde dépasse son délai de garde', async () => {
    jest.useFakeTimers();
    try {
      const { service } = build(() => new Promise<void>(() => undefined), up);

      const pending = service.check();
      await jest.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 1);
      const report = await pending;

      expect(report.status).toBe('error');
      expect(report.checks.database.status).toBe('down');
    } finally {
      jest.useRealTimers();
    }
  });

  it('sonde les deux dépendances en parallèle', async () => {
    const order: string[] = [];
    const { service } = build(
      async () => {
        order.push('db:start');
        await Promise.resolve();
        order.push('db:end');
      },
      async () => {
        order.push('cache:start');
        await Promise.resolve();
        order.push('cache:end');
      },
    );

    await service.check();

    // En séquentiel, `cache:start` viendrait après `db:end`.
    expect(order.indexOf('cache:start')).toBeLessThan(order.indexOf('db:end'));
  });
});
