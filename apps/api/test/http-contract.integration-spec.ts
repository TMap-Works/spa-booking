import request from 'supertest';

import { ProbeModule } from './fixtures/probe.module';
import { createTestApp, type TestApp } from './utils/test-app';

/**
 * Contrat HTTP transverse du squelette : versionnement, `ValidationPipe` global
 * et filtre d'exceptions. Ces trois pièces sont déclarées une fois pour toute
 * l'API ; si elles ne s'appliquent pas ici, elles ne s'appliqueront à aucun
 * module métier.
 *
 * Les surfaces exercées viennent de `fixtures/probe.module.ts`, monté à côté
 * d'`AppModule` — le câblage global traversé est bien celui de production.
 */
describe('Contrat HTTP', () => {
  let context: TestApp;

  beforeEach(async () => {
    context = await createTestApp({ imports: [ProbeModule] });
  });

  afterEach(async () => {
    await context.close();
  });

  describe('versionnement', () => {
    it('sert les routes métier sous /api/v1', async () => {
      await request(context.app.getHttpServer())
        .post('/api/v1/probe')
        .send({ label: 'coupe', amountMinor: 3500 })
        .expect(201, { label: 'coupe', amountMinor: 3500 });
    });

    it('ne les sert ni sans préfixe ni sans version', async () => {
      await request(context.app.getHttpServer()).post('/probe').expect(404);
      await request(context.app.getHttpServer()).post('/api/probe').expect(404);
    });

    it('rend une route inconnue au format d’erreur commun', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/v1/inexistant')
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.details).toEqual({});
    });
  });

  describe('ValidationPipe global', () => {
    it('rejette un champ non déclaré dans le DTO', async () => {
      // `forbidNonWhitelisted` : c'est ce réglage qui interdit à un client
      // d'injecter un `tenantId` dans un corps JSON (tenant-isolation).
      const response = await request(context.app.getHttpServer())
        .post('/api/v1/probe')
        .send({ label: 'coupe', amountMinor: 3500, tenantId: 'tenant_autre' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body.details)).toContain('tenantId');
    });

    it('rejette un champ manquant ou mal typé', async () => {
      const response = await request(context.app.getHttpServer())
        .post('/api/v1/probe')
        .send({ label: 'coupe' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(response.body.message).toBe('La requête est invalide.');
      expect(Array.isArray(response.body.details.violations)).toBe(true);
    });

    it('ne convertit pas implicitement une chaîne en nombre', async () => {
      // Sans ce garde-fou, `"3500abc"` deviendrait `3500` — un montant faux
      // accepté en silence.
      await request(context.app.getHttpServer())
        .post('/api/v1/probe')
        .send({ label: 'coupe', amountMinor: '3500' })
        .expect(400);
    });
  });

  describe("filtre d'exceptions", () => {
    it.each([
      { route: 'not-found', status: 404, code: 'NOT_FOUND' },
      { route: 'conflict', status: 409, code: 'CONFLICT' },
      { route: 'business-rule', status: 422, code: 'BUSINESS_RULE_VIOLATION' },
    ])('traduit une erreur de domaine en $status/$code', async ({ route, status, code }) => {
      const response = await request(context.app.getHttpServer())
        .get(`/api/v1/probe/${route}`)
        .expect(status);

      expect(response.body).toEqual({
        code,
        message: expect.any(String),
        details: expect.any(Object),
      });
    });

    it('transmet les `details` non personnels de l’erreur de domaine', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/v1/probe/conflict')
        .expect(409);

      expect(response.body.details).toEqual({ slotId: 'slot_42' });
    });

    it('répond 500 générique sur une erreur imprévue, sans rien en divulguer', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/v1/probe/boom')
        .expect(500);

      expect(response.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'Une erreur interne est survenue.',
        details: {},
      });

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('Sup3rS3cret');
      expect(serialized).not.toContain('prod-db.internal');
      expect(serialized).not.toContain('alice@example.test');
      expect(serialized).not.toContain('appointments');
    });
  });
});
