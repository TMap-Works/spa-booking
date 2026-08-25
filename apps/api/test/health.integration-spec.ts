import request from 'supertest';

import { HEALTH_PROBE_TIMEOUT_MS } from '../src/health/health.service';
import { createTestApp, type TestApp } from './utils/test-app';

/**
 * `/health` de bout en bout : le contrôleur, le service, la traduction du
 * rapport en statut HTTP et les en-têtes que l'ALB lit réellement.
 */
describe('GET /health', () => {
  let context: TestApp;

  beforeEach(async () => {
    context = await createTestApp();
  });

  afterEach(async () => {
    await context.close();
  });

  it('répond 200 et le détail par dépendance quand tout répond', async () => {
    const response = await request(context.app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      checks: {
        database: { status: 'up', latencyMs: expect.any(Number) },
        cache: { status: 'up', latencyMs: expect.any(Number) },
      },
    });
  });

  it('interdit la mise en cache de la sonde', async () => {
    const response = await request(context.app.getHttpServer()).get('/health').expect(200);

    // Un 200 mémorisé par un intermédiaire masquerait une panne aussi longtemps
    // que dure son cache.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('répond 503 — et non 500 — quand la base ne répond pas', async () => {
    context.database.failWith('connect ECONNREFUSED 10.0.3.14:5432');

    const response = await request(context.app.getHttpServer()).get('/health').expect(503);

    expect(response.body.status).toBe('error');
    expect(response.body.checks.database.status).toBe('down');
    expect(response.body.checks.cache.status).toBe('up');
  });

  it('répond 503 quand le cache ne répond pas', async () => {
    context.cache.failWith('Connection is closed.');

    const response = await request(context.app.getHttpServer()).get('/health').expect(503);

    expect(response.body.status).toBe('error');
    expect(response.body.checks.cache.status).toBe('down');
    expect(response.body.checks.database.status).toBe('up');
  });

  it('conclut à la panne au lieu de tenir la requête ouverte', async () => {
    context.cache.hang();

    const startedAt = Date.now();
    const response = await request(context.app.getHttpServer()).get('/health').expect(503);

    expect(response.body.checks.cache.status).toBe('down');
    // Le délai de garde borne la réponse ; sans lui, l'ALB conclurait à un
    // dépassement de délai au lieu de lire un 503 explicite.
    expect(Date.now() - startedAt).toBeLessThan(HEALTH_PROBE_TIMEOUT_MS * 3);
  });

  it('ne divulgue jamais la cause de la panne au client', async () => {
    context.database.failWith('connect ECONNREFUSED 10.0.3.14:5432 (user spa_app, db spa_prod)');

    const response = await request(context.app.getHttpServer()).get('/health').expect(503);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('10.0.3.14');
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('spa_app');
    expect(Object.keys(response.body.checks.database).sort()).toEqual(['latencyMs', 'status']);
  });

  it('est servie hors du préfixe /api et hors du versionnement', async () => {
    // Un `target group` ECS ne doit pas avoir à connaître la version de l'API
    // qu'il équilibre : passer en `v2` ne doit rien reconfigurer côté infra.
    await request(context.app.getHttpServer()).get('/health').expect(200);
    await request(context.app.getHttpServer()).get('/api/v1/health').expect(404);
  });
});
