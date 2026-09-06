import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createReportingHarness, type ReportingHarness } from './reporting.harness';

/**
 * Le reporting de base, exercé en HTTP sur l'application réellement câblée
 * (#74).
 *
 * Ce que cette suite prouve et que les tests unitaires ne peuvent pas :
 *
 * - **les trois routes sont servies** — un contrôleur oublié dans les
 *   `controllers` de son module, ou un module absent du graphe d'`AppModule`,
 *   compile, passe ses tests unitaires, et rend 404 en vrai ;
 * - **les gardes sont montées** — sans jeton 401, avec un jeton `STAFF` 403 : le
 *   chiffre d'affaires du salon et le rendement de chaque praticien ne sont pas
 *   des données de comptoir ;
 * - **le `ValidationPipe` global mord** — `forbidNonWhitelisted` refuse en 400
 *   un `tenantId` glissé dans la chaîne de requête, qui est le scénario de fuite
 *   le plus direct ;
 * - **les deux fenêtres refusées le sont en 422 et non en 400** — les bornes
 *   sont bien formées, c'est leur relation qui ne l'est pas ;
 * - **la sérialisation est celle du contrat** — montants entiers, devise
 *   explicite, instants en UTC suffixés `Z`, `rate` nul plutôt qu'absent.
 *
 * La traversée inter-tenant, elle, vit dans `reporting-tenant.isolation-spec.ts`.
 */

const REVENUE = '/api/v1/reports/revenue';
const VOLUME = '/api/v1/reports/appointments';
const NO_SHOWS = '/api/v1/reports/no-shows';

const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';

describe('Reporting — revenu, volume, no-shows', () => {
  let harness: ReportingHarness;

  beforeEach(async () => {
    harness = await createReportingHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Un appel de rapport sous le rôle `MANAGER`, avec le statut qu'on en attend. */
  async function get(
    path: string,
    query: Record<string, string>,
    status = 200,
  ): Promise<request.Response> {
    return request(server())
      .get(path)
      .query(query)
      .set('Authorization', await harness.bearer('MANAGER'))
      .expect(status);
  }

  function semerRecette(
    overrides: Partial<Parameters<ReportingHarness['seedPayment']>[0]> = {},
  ): void {
    harness.seedPayment({
      tenantId: harness.tenantId,
      date: '2026-09-03',
      capturedAt: new Date('2026-09-03T14:00:00Z'),
      method: 'CARD',
      currency: 'EUR',
      status: 'SUCCEEDED',
      amountMinor: 12_000,
      refundedAmountMinor: 0,
      ...overrides,
    });
  }

  function semerRendezVous(
    overrides: Partial<Parameters<ReportingHarness['seedAppointment']>[0]> = {},
  ): void {
    harness.seedAppointment({
      tenantId: harness.tenantId,
      date: '2026-09-03',
      startsAt: new Date('2026-09-03T09:00:00Z'),
      status: 'COMPLETED',
      staffId: '33333333-3333-4333-8333-333333333333',
      staffName: 'Camille',
      serviceId: '44444444-4444-4444-8444-444444444444',
      serviceName: 'Massage 60 min',
      ...overrides,
    });
  }

  describe('GET /reports/revenue', () => {
    it('rend le revenu du jour, ventilé par moyen de paiement', async () => {
      semerRecette();
      semerRecette({ method: 'CASH', amountMinor: 3_000 });

      const response = await get(REVENUE, { from: FROM, to: TO });

      expect(response.body).toMatchObject({
        window: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
        timeZone: 'Europe/Paris',
      });
      expect(response.body.days).toHaveLength(2);
      expect(response.body.totals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'CARD', currency: 'EUR', netAmountMinor: 12_000 }),
          expect.objectContaining({ method: 'CASH', currency: 'EUR', netAmountMinor: 3_000 }),
        ]),
      );
    });

    it('rend des montants entiers accompagnés de leur devise, jamais un flottant', async () => {
      semerRecette({ amountMinor: 12_050, refundedAmountMinor: 50 });

      const response = await get(REVENUE, { from: FROM, to: TO });

      expect(response.body.days[0]).toMatchObject({
        grossAmountMinor: 12_050,
        refundedAmountMinor: 50,
        netAmountMinor: 12_000,
        currency: 'EUR',
      });
      expect(Number.isInteger(response.body.days[0].netAmountMinor)).toBe(true);
    });

    it('rend une fenêtre sans recette comme un rapport vide, pas comme une erreur', async () => {
      const response = await get(REVENUE, { from: FROM, to: TO });

      expect(response.body).toMatchObject({ days: [], totals: [] });
    });
  });

  describe('GET /reports/appointments', () => {
    it('groupe par journée civile du salon par défaut', async () => {
      semerRendezVous();

      const response = await get(VOLUME, { from: FROM, to: TO });

      expect(response.body).toMatchObject({ groupBy: 'day', total: 1 });
      expect(response.body.rows[0]).toMatchObject({ key: '2026-09-03', label: null });
      expect(response.body.rows[0].byStatus).toEqual({
        PENDING: 0,
        CONFIRMED: 0,
        COMPLETED: 1,
        CANCELLED: 0,
        NO_SHOW: 0,
      });
    });

    it('groupe par praticien et rend son nom public', async () => {
      semerRendezVous();

      const response = await get(VOLUME, { from: FROM, to: TO, groupBy: 'staff' });

      expect(response.body.rows[0]).toMatchObject({
        key: '33333333-3333-4333-8333-333333333333',
        label: 'Camille',
      });
    });

    it('groupe par prestation', async () => {
      semerRendezVous();

      const response = await get(VOLUME, { from: FROM, to: TO, groupBy: 'service' });

      expect(response.body.rows[0]).toMatchObject({ label: 'Massage 60 min' });
    });

    it('refuse un axe inconnu en 400, en nommant le champ', async () => {
      const response = await get(VOLUME, { from: FROM, to: TO, groupBy: 'client' }, 400);

      expect(JSON.stringify(response.body)).toContain('groupBy');
    });
  });

  describe('GET /reports/no-shows', () => {
    it('rend le nombre et le taux, annulations exclues du dénominateur', async () => {
      semerRendezVous({ status: 'COMPLETED' });
      semerRendezVous({ status: 'NO_SHOW', date: '2026-09-04' });
      semerRendezVous({ status: 'CANCELLED', date: '2026-09-05' });

      const response = await get(NO_SHOWS, { from: FROM, to: TO });

      expect(response.body).toMatchObject({
        noShows: 1,
        honored: 1,
        cancelled: 1,
        total: 3,
        rate: 0.5,
      });
    });

    it('rend `rate: null` — et non zéro — quand personne n’était attendu', async () => {
      const response = await get(NO_SHOWS, { from: FROM, to: TO });

      expect(response.body.rate).toBeNull();
      expect(response.body).toHaveProperty('rate');
    });
  });

  describe('Les gardes', () => {
    it.each([REVENUE, VOLUME, NO_SHOWS])('%s : 401 sans jeton', async (path) => {
      await request(server()).get(path).query({ from: FROM, to: TO }).expect(401);
    });

    it.each([REVENUE, VOLUME, NO_SHOWS])('%s : 403 pour un compte STAFF', async (path) => {
      await request(server())
        .get(path)
        .query({ from: FROM, to: TO })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(403);
    });

    it.each([REVENUE, VOLUME, NO_SHOWS])('%s : 403 pour une cliente', async (path) => {
      await request(server())
        .get(path)
        .query({ from: FROM, to: TO })
        .set('Authorization', await harness.bearer('CLIENT'))
        .expect(403);
    });

    it.each([REVENUE, VOLUME, NO_SHOWS])('%s : ouvert à ADMIN, au-dessus du seuil', async (path) => {
      await request(server())
        .get(path)
        .query({ from: FROM, to: TO })
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(200);
    });
  });

  describe('La fenêtre', () => {
    it('exige les deux bornes — 400 quand `to` manque', async () => {
      const response = await get(REVENUE, { from: FROM }, 400);

      expect(JSON.stringify(response.body)).toContain('to');
    });

    it('refuse une date-heure sans offset explicite', async () => {
      await get(REVENUE, { from: '2026-09-01T00:00:00', to: TO }, 400);
    });

    it('refuse une date civile qui n’existe pas', async () => {
      await get(REVENUE, { from: '2026-02-31T00:00:00Z', to: TO }, 400);
    });

    it('refuse un `tenantId` glissé dans la chaîne de requête', async () => {
      await get(REVENUE, { from: FROM, to: TO, tenantId: harness.otherTenantId }, 400);
    });

    it('refuse une fenêtre inversée en 422, avec un code stable', async () => {
      const response = await get(REVENUE, { from: TO, to: FROM }, 422);

      expect(response.body).toMatchObject({ code: 'REPORT_WINDOW_INVALID' });
      expect(response.body).toHaveProperty('message');
    });

    it('refuse une fenêtre de plus d’un an en 422, en disant le plafond', async () => {
      const response = await get(
        NO_SHOWS,
        { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
        422,
      );

      expect(response.body).toMatchObject({
        code: 'REPORT_WINDOW_TOO_WIDE',
        details: { maxDays: 366 },
      });
    });
  });
});
