import request from 'supertest';

import { createReportingHarness, type ReportingHarness } from './reporting.harness';

/**
 * Isolation inter-tenant du module `reporting` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de #74).
 *
 * ## Pourquoi ce module a besoin de cette suite plus que les autres
 *
 * Parce que le protocole habituel ne s'y applique pas. Aucune des trois routes
 * ne prend d'identifiant : il n'y a donc **rien à demander par id**, et pas un
 * seul 404 de traversée à écrire. Ce qui pourrait fuir ici n'est pas une
 * ressource nommée, c'est un **chiffre** — un total qui compterait les
 * encaissements du salon voisin, un taux de no-show calculé sur son agenda. Une
 * fuite de cette sorte ne se voit dans aucune réponse : elle ressemble
 * exactement à un salon qui aurait fait plus de chiffre.
 *
 * Elle est d'autant moins théorique que ce module est le seul dont **toutes**
 * les lectures passent par du SQL brut, qui ne bénéficie d'aucun scoping
 * automatique (ADR 0006, angle mort n°1). Le `WHERE tenant_id = …` y est écrit à
 * la main, une fois par requête ; c'est précisément le genre de ligne qu'un
 * refactor emporte.
 *
 * ## Le protocole, adapté
 *
 * Semer **des deux côtés**, interroger comme A, et vérifier trois choses :
 *
 * | Ce qui est vérifié | Sur quelle route |
 * |---|---|
 * | le total ne compte que les lignes de A | `revenue`, `appointments`, `no-shows` |
 * | aucune clé ni aucun libellé du voisin n'apparaît | `appointments` |
 * | le fuseau rendu est celui de A | les trois |
 *
 * Le fuseau est le témoin le plus sûr du lot : le harnais donne
 * `Europe/Paris` à A et `Pacific/Tahiti` à B. Une confusion d'établissement se
 * lit alors dans la réponse elle-même, sans avoir à raisonner sur des sommes.
 *
 * ## Le scénario délibéré : les deux salons ont exactement la même journée
 *
 * Mêmes dates, mêmes montants, mêmes statuts, mêmes identifiants d'équipe. C'est
 * la configuration où une confusion de tenant ne se voit **que** dans les
 * totaux — un jeu de données dissemblable aurait laissé une suite passer au vert
 * en comparant des libellés qui, eux, diffèrent.
 */

const REVENUE = '/api/v1/reports/revenue';
const VOLUME = '/api/v1/reports/appointments';
const NO_SHOWS = '/api/v1/reports/no-shows';

const FROM = '2026-09-01T00:00:00Z';
const TO = '2026-10-01T00:00:00Z';

/** Le praticien du voisin — l'identifiant qu'aucune réponse de A ne doit porter. */
const STAFF_VOISIN = '99999999-9999-4999-8999-999999999999';
const SERVICE_VOISIN = '88888888-8888-4888-8888-888888888888';

describe('Isolation inter-tenant — module reporting', () => {
  let harness: ReportingHarness;
  /** L'établissement de l'appelant. */
  let a: string;
  /** L'établissement voisin, celui qu'aucune réponse ne doit laisser voir. */
  let b: string;

  beforeEach(async () => {
    harness = await createReportingHarness();
    a = harness.tenantId;
    b = harness.otherTenantId;

    // Une journée identique des deux côtés : une recette de 12 000 et un
    // rendez-vous honoré chez A, la même chose chez B — plus, chez B seulement,
    // un no-show et une seconde recette. Si le scoping tombait, les totaux de A
    // s'en trouveraient gonflés d'exactement ce surplus.
    for (const tenantId of [a, b]) {
      harness.seedPayment({
        tenantId,
        date: '2026-09-03',
        capturedAt: new Date('2026-09-03T14:00:00Z'),
        method: 'CARD',
        currency: 'EUR',
        status: 'SUCCEEDED',
        amountMinor: 12_000,
        refundedAmountMinor: 0,
      });
      harness.seedAppointment({
        tenantId,
        date: '2026-09-03',
        startsAt: new Date('2026-09-03T09:00:00Z'),
        status: 'COMPLETED',
        staffId: '33333333-3333-4333-8333-333333333333',
        staffName: 'Camille',
        serviceId: '44444444-4444-4444-8444-444444444444',
        serviceName: 'Massage 60 min',
      });
    }

    harness.seedPayment({
      tenantId: b,
      date: '2026-09-04',
      capturedAt: new Date('2026-09-04T14:00:00Z'),
      method: 'CASH',
      currency: 'EUR',
      status: 'SUCCEEDED',
      amountMinor: 50_000,
      refundedAmountMinor: 0,
    });
    harness.seedAppointment({
      tenantId: b,
      date: '2026-09-04',
      startsAt: new Date('2026-09-04T09:00:00Z'),
      status: 'NO_SHOW',
      staffId: STAFF_VOISIN,
      staffName: 'Praticien du voisin',
      serviceId: SERVICE_VOISIN,
      serviceName: 'Soin du voisin',
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Interroge un rapport sous un jeton `MANAGER` de l'établissement voulu. */
  async function reportFor(path: string, tenantId: string, query: Record<string, string> = {}) {
    return request(harness.app.getHttpServer())
      .get(path)
      .query({ from: FROM, to: TO, ...query })
      .set('Authorization', await harness.bearer('MANAGER', tenantId))
      .expect(200);
  }

  describe('GET /reports/revenue', () => {
    it('ne compte que la recette de l’établissement du jeton', async () => {
      const response = await reportFor(REVENUE, a);

      expect(response.body.days).toHaveLength(1);
      expect(response.body.totals).toEqual([
        expect.objectContaining({ method: 'CARD', netAmountMinor: 12_000 }),
      ]);
      // La recette en espèces du voisin ne doit apparaître nulle part.
      expect(JSON.stringify(response.body)).not.toContain('50000');
      expect(JSON.stringify(response.body)).not.toContain('CASH');
    });

    it('rend au voisin sa propre recette, et son propre fuseau', async () => {
      const response = await reportFor(REVENUE, b);

      expect(response.body.timeZone).toBe('Pacific/Tahiti');
      expect(response.body.days).toHaveLength(2);
    });
  });

  describe('GET /reports/appointments', () => {
    it('ne compte que les rendez-vous de l’établissement du jeton', async () => {
      const response = await reportFor(VOLUME, a);

      expect(response.body.total).toBe(1);
    });

    it('ne laisse voir ni l’identifiant ni le nom du praticien voisin', async () => {
      const response = await reportFor(VOLUME, a, { groupBy: 'staff' });

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(STAFF_VOISIN);
      expect(body).not.toContain('Praticien du voisin');
      expect(response.body.rows).toHaveLength(1);
    });

    it('ne laisse voir ni l’identifiant ni le nom de la prestation voisine', async () => {
      const response = await reportFor(VOLUME, a, { groupBy: 'service' });

      const body = JSON.stringify(response.body);
      expect(body).not.toContain(SERVICE_VOISIN);
      expect(body).not.toContain('Soin du voisin');
    });
  });

  describe('GET /reports/no-shows', () => {
    it('ne compte pas le no-show du voisin — c’est le taux du salon qui en dépend', async () => {
      const response = await reportFor(NO_SHOWS, a);

      expect(response.body).toMatchObject({ noShows: 0, honored: 1, total: 1, rate: 0 });
    });

    it('rend au voisin son propre taux', async () => {
      const response = await reportFor(NO_SHOWS, b);

      expect(response.body).toMatchObject({ noShows: 1, honored: 1, total: 2, rate: 0.5 });
    });
  });

  describe('Le fuseau rendu est celui du jeton', () => {
    it.each([REVENUE, VOLUME, NO_SHOWS])(
      '%s : `Europe/Paris` pour A, jamais celui du voisin',
      async (path) => {
        const response = await reportFor(path, a);

        expect(response.body.timeZone).toBe('Europe/Paris');
      },
    );
  });
});
