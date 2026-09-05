import { runWithTenant } from '../../../common/tenant';
import { PaymentsHistoryService } from '../payments-history.service';
import { HistoryWindowInvalidError } from '../payments.errors';
import type { PaymentsRepository } from '../payments.repository';
import { FakePaymentsRepository } from './payments.doubles';

/**
 * L'historique des transactions, exercé sans HTTP ni base (#62).
 *
 * Ce que cette suite couvre en propre :
 *
 * - **le tri** — du plus récent au plus ancien, c'est ce qu'un écran de caisse
 *   ouvre ;
 * - **la fenêtre** : `from` inclus, `to` **exclu**, pour que deux journées bout
 *   à bout ne comptent pas deux fois l'encaissement de minuit ;
 * - **la fenêtre vide**, refusée en 422 plutôt que rendue en page vide ;
 * - **les filtres** de moyen et de statut, et ce qu'ils servent au
 *   rapprochement : les lignes carte portent une référence Stripe, les lignes
 *   espèces n'en portent aucune ;
 * - **la pagination**, dont le « page 1 sur 0 » d'un ensemble vide ;
 * - **la frontière du tenant** — l'historique ne montre que l'établissement
 *   courant.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const instant = (iso: string): Date => new Date(iso);

describe('PaymentsHistoryService', () => {
  let repository: FakePaymentsRepository;
  let service: PaymentsHistoryService;

  beforeEach(() => {
    repository = new FakePaymentsRepository();
    service = new PaymentsHistoryService(repository as unknown as PaymentsRepository);
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  const page = async (filter: Partial<Parameters<PaymentsHistoryService['list']>[0]> = {}) =>
    inTenantA(() => service.list({ page: 1, pageSize: 20, ...filter }));

  it('rend les transactions du plus récent au plus ancien', async () => {
    repository.seedPayment({
      tenantId: TENANT_A,
      appointmentId: null,
      createdAt: instant('2026-09-01T08:00:00.000Z'),
    });
    const recent = repository.seedPayment({
      tenantId: TENANT_A,
      appointmentId: null,
      createdAt: instant('2026-09-01T18:00:00.000Z'),
    });

    const result = await page();

    expect(result.items[0]?.id).toBe(recent.id);
    expect(result.totalItems).toBe(2);
    expect(result.totalPages).toBe(1);
  });

  describe('la fenêtre', () => {
    beforeEach(() => {
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        id: 'veille',
        createdAt: instant('2026-08-31T23:59:59.999Z'),
      });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        id: 'minuit',
        createdAt: instant('2026-09-01T00:00:00.000Z'),
      });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        id: 'lendemain',
        createdAt: instant('2026-09-02T00:00:00.000Z'),
      });
    });

    it('inclut sa borne basse et exclut sa borne haute', async () => {
      const result = await page({
        from: instant('2026-09-01T00:00:00.000Z'),
        to: instant('2026-09-02T00:00:00.000Z'),
      });

      // `minuit` appartient à la journée qui commence, `lendemain` à la
      // suivante : deux journées bout à bout ne le comptent qu'une fois.
      expect(result.items.map((item) => item.id)).toEqual(['minuit']);
    });

    it('refuse une fenêtre à l’envers plutôt que de rendre une page vide', async () => {
      await expect(
        page({ from: instant('2026-09-02T00:00:00.000Z'), to: instant('2026-09-01T00:00:00.000Z') }),
      ).rejects.toBeInstanceOf(HistoryWindowInvalidError);
    });

    it('refuse une fenêtre dont les deux bornes coïncident — elle est vide', async () => {
      await expect(
        page({ from: instant('2026-09-01T00:00:00.000Z'), to: instant('2026-09-01T00:00:00.000Z') }),
      ).rejects.toBeInstanceOf(HistoryWindowInvalidError);
    });
  });

  describe('le rapprochement', () => {
    beforeEach(() => {
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        method: 'CARD',
        status: 'SUCCEEDED',
        providerChargeId: 'ch_test_0001',
      });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        method: 'CASH',
        status: 'SUCCEEDED',
        providerPaymentIntentId: null,
      });
    });

    it('isole ce qui doit se retrouver sur un relevé Stripe', async () => {
      const result = await page({ method: 'CARD' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.providerChargeId).toBe('ch_test_0001');
    });

    it('isole ce dont la caisse fait foi — sans aucune référence de prestataire', async () => {
      const result = await page({ method: 'CASH' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.providerPaymentIntentId).toBeNull();
      expect(result.items[0]?.providerChargeId).toBeNull();
    });

    it('filtre par statut — les remboursements se comptent à part', async () => {
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: null,
        method: 'CARD',
        status: 'REFUNDED',
        refundedAmountMinor: 7000,
      });

      const result = await page({ status: 'REFUNDED' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.refunded).toEqual({ amountMinor: 7000, currency: 'EUR' });
    });
  });

  describe('la pagination', () => {
    it('découpe l’ensemble et en rend le compte total', async () => {
      for (let index = 0; index < 3; index += 1) {
        repository.seedPayment({
          tenantId: TENANT_A,
          appointmentId: null,
          createdAt: instant(`2026-09-0${String(index + 1)}T10:00:00.000Z`),
        });
      }

      const result = await page({ page: 2, pageSize: 2 });

      expect(result.items).toHaveLength(1);
      expect(result.totalItems).toBe(3);
      expect(result.totalPages).toBe(2);
    });

    it('rend « page 1 sur 0 » sur un ensemble vide, et non « 1 sur 1 »', async () => {
      const result = await page();

      expect(result.items).toHaveLength(0);
      expect(result.totalPages).toBe(0);
    });
  });

  it('ne montre rien du salon voisin', async () => {
    repository.seedPayment({ tenantId: TENANT_B, appointmentId: null });

    const result = await page();

    expect(result.items).toHaveLength(0);
    expect(result.totalItems).toBe(0);
  });
});
