import type { INestApplication } from '@nestjs/common';

import { MAX_REPORT_EXPORT_TTL_SECONDS } from '@spa/shared';
import request from 'supertest';

import { createReportingHarness, type ReportingHarness } from './reporting.harness';

/**
 * L'export du reporting servi par URL présignée, exercé en HTTP sur
 * l'application réellement câblée — #563.
 *
 * Ce que cette suite prouve et que les tests unitaires ne peuvent pas :
 *
 * - **les deux routes sont servies** — `POST /reports/export` et
 *   `GET /reports/export/:exportId`. Une route déclarée dans un contrôleur non
 *   enregistré compile, passe ses tests unitaires, et rend 404 en vrai ;
 * - **elles sont gardées au même rang que les trois routes de lecture** — sans
 *   jeton 401, en `STAFF` 403. Un export porte le chiffre d'affaires du salon :
 *   l'ouvrir plus bas que le rapport qu'il sérialise n'aurait aucun sens ;
 * - **le `ValidationPipe` global mord** — bornes manquantes ou mal formées en
 *   400, `tenantId` glissé dans la chaîne de requête refusé, identifiant
 *   d'export non-UUID refusé avant toute lecture ;
 * - **l'URL est éphémère** — `expiresAt` est dans le futur, et à moins de quinze
 *   minutes.
 *
 * La traversée inter-tenant vit dans `reporting-export.isolation-spec.ts`, et
 * c'est là que se joue le critère du 404.
 */

const EXPORT = '/api/v1/reports/export';

const FROM = '2026-08-31T22:00:00Z';
const TO = '2026-09-30T22:00:00Z';

describe('Export du reporting — URL présignée', () => {
  let harness: ReportingHarness;

  beforeEach(async () => {
    harness = await createReportingHarness();

    harness.seedPayment({
      tenantId: harness.tenantId,
      date: '2026-09-03',
      capturedAt: new Date('2026-09-03T14:00:00Z'),
      method: 'CARD',
      currency: 'EUR',
      status: 'SUCCEEDED',
      amountMinor: 12_000,
      refundedAmountMinor: 0,
    });
    harness.seedAppointment({
      tenantId: harness.tenantId,
      date: '2026-09-03',
      startsAt: new Date('2026-09-03T09:00:00Z'),
      status: 'COMPLETED',
      staffId: '33333333-3333-4333-8333-333333333333',
      staffName: 'Camille',
      serviceId: '44444444-4444-4444-8444-444444444444',
      serviceName: 'Massage 60 min',
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Produit un export sous le rôle `MANAGER`, avec le statut qu'on en attend. */
  async function creer(
    query: Record<string, string> = { from: FROM, to: TO },
    status = 201,
  ): Promise<request.Response> {
    return request(server())
      .post(EXPORT)
      .query(query)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(status);
  }

  describe('POST /reports/export', () => {
    it('rend `{ id, url, expiresAt, filename }` et rien d’autre', async () => {
      const response = await creer();

      expect(Object.keys(response.body).sort()).toEqual(['expiresAt', 'filename', 'id', 'url']);
    });

    it('nomme le fichier d’après l’établissement et la période couverte', async () => {
      const response = await creer();

      // La borne haute de la fenêtre est **exclue** : le fichier couvre jusqu'au
      // 30 septembre, et le nom le dit.
      expect(response.body.filename).toBe('maison-lotus-reporting-2026-09-01_2026-09-30.csv');
    });

    it('dépose l’objet sous une clé préfixée par le tenant', async () => {
      const response = await creer();

      expect([...harness.storage.objects.keys()]).toEqual([
        `exports/${harness.tenantId}/${String(response.body.id)}.csv`,
      ]);
    });

    it('dépose un CSV qui porte les chiffres du salon, en entiers et avec sa devise', async () => {
      await creer();
      const [objet] = [...harness.storage.objects.values()];

      expect(objet?.contentType).toBe('text/csv;charset=utf-8');
      expect(objet?.body).toContain('revenu_total;CARD-EUR;CARD;net_minor;12000;EUR');
      expect(objet?.body).toContain('Europe/Paris');
    });

    it('rend une échéance future, et à moins de quinze minutes', async () => {
      const avant = Date.now();
      const response = await creer();

      const echeance = Date.parse(String(response.body.expiresAt));
      expect(echeance).toBeGreaterThan(avant);
      expect(echeance).toBeLessThanOrEqual(avant + MAX_REPORT_EXPORT_TTL_SECONDS * 1000 + 1_000);
    });

    it('refuse sans jeton', async () => {
      await request(server()).post(EXPORT).query({ from: FROM, to: TO }).expect(401);
    });

    it('refuse au rôle `STAFF` — un export porte le chiffre d’affaires du salon', async () => {
      await request(server())
        .post(EXPORT)
        .query({ from: FROM, to: TO })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);
    });

    it('refuse en 400 une borne manquante ou mal formée', async () => {
      await creer({ from: FROM }, 400);
      await creer({ from: '2026-09-01', to: TO }, 400);
    });

    it('refuse en 400 un `tenantId` glissé dans la chaîne de requête', async () => {
      // Le scénario de fuite le plus direct : `forbidNonWhitelisted` le refuse
      // avant que la moindre couche ne le regarde (tenant-isolation §2).
      await creer({ from: FROM, to: TO, tenantId: harness.otherTenantId }, 400);
    });

    it('refuse en 422 une fenêtre inversée, sans rien déposer', async () => {
      await creer({ from: TO, to: FROM }, 422);

      expect(harness.storage.objects.size).toBe(0);
    });

    it('refuse en 422 une fenêtre de plus d’un an', async () => {
      await creer({ from: '2020-01-01T00:00:00Z', to: TO }, 422);
    });
  });

  describe('GET /reports/export/:exportId', () => {
    it('re-signe l’export sans en produire un second', async () => {
      const cree = await creer();

      const resigne = await request(server())
        .get(`${EXPORT}/${String(cree.body.id)}`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(200);

      expect(resigne.body.id).toBe(cree.body.id);
      expect(harness.storage.objects.size).toBe(1);
    });

    it('rend 404 sur un identifiant qui n’a jamais existé', async () => {
      await request(server())
        .get(`${EXPORT}/55555555-5555-4555-8555-555555555555`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(404);
    });

    it('refuse en 400 un identifiant qui n’est pas un UUID', async () => {
      // Le fragment est concaténé dans une clé S3, et une clé accepte `..`
      // comme `/`. Le refus est donc une barrière, pas une politesse.
      await request(server())
        .get(`${EXPORT}/..%2F..%2Fautre-tenant`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(400);
    });

    it('refuse sans jeton', async () => {
      await request(server()).get(`${EXPORT}/55555555-5555-4555-8555-555555555555`).expect(401);
    });

    it('refuse au rôle `STAFF`', async () => {
      await request(server())
        .get(`${EXPORT}/55555555-5555-4555-8555-555555555555`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);
    });
  });
});
