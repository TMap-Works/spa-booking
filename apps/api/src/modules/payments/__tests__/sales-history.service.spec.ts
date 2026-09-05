import { runWithTenant } from '../../../common/tenant';
import type { ServicesService } from '../../catalog/services.service';
import { HistoryWindowInvalidError } from '../payments.errors';
import type { PosRepository } from '../pos.repository';
import { SalesService } from '../sales.service';
import { FakePosRepository, FakeServicesService } from './pos.doubles';

/**
 * L'historique des ventes, exercé sans HTTP ni base (#62).
 *
 * `sales.service.spec.ts` couvre la **composition** d'un ticket (#60) ; cette
 * suite-ci couvre sa **relecture en liste**, qui est l'autre moitié du même
 * service et n'a aucune règle en commun avec la première.
 *
 * Ce qu'elle prouve :
 *
 * - chaque élément porte les trois faits du premier critère de #62 —
 *   l'opérateur, l'horodatage, le montant — et **pas** les lignes du ticket ;
 * - le tri, du plus récent au plus ancien ;
 * - la fenêtre : `from` inclus, `to` exclu, et la fenêtre vide refusée ;
 * - les deux filtres du back-office : la relève de caisse par opérateur, le
 *   rapprochement d'une fiche cliente par rendez-vous ;
 * - la frontière du tenant.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CASHIER = '33333333-3333-4333-8333-333333333333';
const OTHER_CASHIER = '44444444-4444-4444-8444-444444444444';

const instant = (iso: string): Date => new Date(iso);

describe('SalesService — historique des ventes', () => {
  let repository: FakePosRepository;
  let service: SalesService;

  beforeEach(() => {
    repository = new FakePosRepository();
    service = new SalesService(
      repository as unknown as PosRepository,
      new FakeServicesService() as unknown as ServicesService,
    );
    repository.seedTenant({ tenantId: TENANT_A });
    repository.seedTenant({ tenantId: TENANT_B });
  });

  const page = async (filter: Partial<Parameters<SalesService['history']>[0]> = {}) =>
    runWithTenant(TENANT_A, () => service.history({ page: 1, pageSize: 20, ...filter }));

  it('rend l’opérateur, l’horodatage et les montants — sans les lignes', async () => {
    const seeded = repository.seedSale({
      tenantId: TENANT_A,
      cashierUserId: CASHIER,
      totalAmountMinor: 1850,
      createdAt: instant('2026-09-01T10:00:00.000Z'),
    });

    const result = await page();

    expect(result.items[0]).toEqual({
      id: seeded.id,
      appointmentId: null,
      cashierUserId: CASHIER,
      subtotal: { amountMinor: 1850, currency: 'EUR' },
      tax: { amountMinor: 0, currency: 'EUR' },
      tip: { amountMinor: 0, currency: 'EUR' },
      total: { amountMinor: 1850, currency: 'EUR' },
      createdAt: instant('2026-09-01T10:00:00.000Z'),
    });
    // Le détail se demande par `GET /sales/:id` : une page de cinquante tickets
    // n'a pas à charger cinq cents lignes qu'aucun tableau n'affiche.
    expect(result.items[0]).not.toHaveProperty('items');
  });

  it('rend les tickets du plus récent au plus ancien', async () => {
    repository.seedSale({ tenantId: TENANT_A, createdAt: instant('2026-09-01T08:00:00.000Z') });
    const recent = repository.seedSale({
      tenantId: TENANT_A,
      createdAt: instant('2026-09-01T18:00:00.000Z'),
    });

    const result = await page();

    expect(result.items[0]?.id).toBe(recent.id);
  });

  describe('la fenêtre', () => {
    it('inclut sa borne basse et exclut sa borne haute', async () => {
      repository.seedSale({
        tenantId: TENANT_A,
        id: 'minuit',
        createdAt: instant('2026-09-01T00:00:00.000Z'),
      });
      repository.seedSale({
        tenantId: TENANT_A,
        id: 'lendemain',
        createdAt: instant('2026-09-02T00:00:00.000Z'),
      });

      const result = await page({
        from: instant('2026-09-01T00:00:00.000Z'),
        to: instant('2026-09-02T00:00:00.000Z'),
      });

      expect(result.items.map((item) => item.id)).toEqual(['minuit']);
    });

    it('refuse une fenêtre à l’envers plutôt que de rendre une page vide', async () => {
      await expect(
        page({ from: instant('2026-09-02T00:00:00.000Z'), to: instant('2026-09-01T00:00:00.000Z') }),
      ).rejects.toBeInstanceOf(HistoryWindowInvalidError);
    });
  });

  describe('les deux filtres du back-office', () => {
    it('restreint à l’opérateur — la relève de caisse', async () => {
      const sien = repository.seedSale({ tenantId: TENANT_A, cashierUserId: CASHIER });
      repository.seedSale({ tenantId: TENANT_A, cashierUserId: OTHER_CASHIER });

      const result = await page({ cashierUserId: CASHIER });

      expect(result.items.map((item) => item.id)).toEqual([sien.id]);
      expect(result.totalItems).toBe(1);
    });

    it('restreint au rendez-vous facturé — le rapprochement d’une fiche', async () => {
      const appointmentId = '55555555-5555-4555-8555-555555555555';
      const facture = repository.seedSale({ tenantId: TENANT_A, appointmentId });
      repository.seedSale({ tenantId: TENANT_A, appointmentId: null });

      const result = await page({ appointmentId });

      expect(result.items.map((item) => item.id)).toEqual([facture.id]);
    });
  });

  it('pagine et rend « page 1 sur 0 » sur un ensemble vide', async () => {
    const empty = await page();
    expect(empty.totalPages).toBe(0);

    for (let index = 0; index < 3; index += 1) {
      repository.seedSale({
        tenantId: TENANT_A,
        createdAt: instant(`2026-09-0${String(index + 1)}T10:00:00.000Z`),
      });
    }

    const second = await page({ page: 2, pageSize: 2 });
    expect(second.items).toHaveLength(1);
    expect(second.totalItems).toBe(3);
    expect(second.totalPages).toBe(2);
  });

  it('ne montre rien du salon voisin', async () => {
    repository.seedSale({ tenantId: TENANT_B });

    const result = await page();

    expect(result.items).toHaveLength(0);
    expect(result.totalItems).toBe(0);
  });
});
