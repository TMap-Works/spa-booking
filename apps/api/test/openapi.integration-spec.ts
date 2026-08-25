import request from 'supertest';

import { OPENAPI_PATH, setupOpenApi } from '../src/bootstrap';
import type { AppConfigService } from '../src/config/app-config.service';
import { ProbeModule } from './fixtures/probe.module';
import { createTestApp, type TestApp } from './utils/test-app';

/** Configuration minimale attendue par `setupOpenApi`, en environnement déployé. */
function productionConfig(): AppConfigService {
  return { isProduction: true, apiUrl: 'https://api.example.test' } as AppConfigService;
}

describe('OpenAPI', () => {
  let context: TestApp;

  afterEach(async () => {
    await context.close();
  });

  it('est exposé hors production, avec les routes versionnées du document', async () => {
    context = await createTestApp({ imports: [ProbeModule], withOpenApi: true });
    expect(context.openApiMounted).toBe(true);

    const response = await request(context.app.getHttpServer())
      .get(`/${OPENAPI_PATH}-json`)
      .expect(200);

    expect(response.body.info.title).toBe('Spa & Salon Booking API');
    expect(Object.keys(response.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/probe', '/health']),
    );
  });

  it("n'est pas monté en production", async () => {
    // Aucun document n'est monté par l'aide de test : c'est `setupOpenApi` qui
    // refuse, sur la seule foi de la configuration.
    context = await createTestApp({ imports: [ProbeModule] });

    expect(setupOpenApi(context.app, productionConfig())).toBe(false);

    // La cartographie complète des routes et de leurs corps est une aide à
    // l'attaque autant qu'à l'intégration : elle ne doit pas être servie.
    await request(context.app.getHttpServer()).get(`/${OPENAPI_PATH}`).expect(404);
    await request(context.app.getHttpServer()).get(`/${OPENAPI_PATH}-json`).expect(404);
  });
});
