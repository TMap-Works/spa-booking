import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import type { ServicesService } from '../../catalog/services.service';
import {
  SaleAmountOutOfRangeError,
  SaleCurrencyMismatchError,
  SaleItemUnavailableError,
} from '../payments.errors';
import type { PosRepository } from '../pos.repository';
import { SalesService } from '../sales.service';
import { FakePosRepository, FakeServicesService } from './pos.doubles';

/**
 * Les règles de la caisse, exercées sans HTTP ni base (#60).
 *
 * Ce que cette suite couvre en propre, et que ni les tests d'intégration ni la
 * recette n'atteignent aussi finement :
 *
 * - **d'où vient chaque montant** — du catalogue relu, jamais de l'appelant ;
 * - **la composition** du ticket : sous-total, taxe, pourboire, total ;
 * - **les refus** qui protègent la pièce comptable — article retiré, devise
 *   étrangère, total hors bornes ;
 * - **la frontière du tenant**, dans les deux sources de prix : la prestation
 *   passe par `ServicesService`, l'article par le dépôt, et les deux rendent 404
 *   hors de l'établissement courant.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CASHIER = '33333333-3333-4333-8333-333333333333';

describe('SalesService — composition d’un ticket', () => {
  let repository: FakePosRepository;
  let catalog: FakeServicesService;
  let service: SalesService;

  beforeEach(() => {
    repository = new FakePosRepository();
    catalog = new FakeServicesService();
    service = new SalesService(
      repository as unknown as PosRepository,
      catalog as unknown as ServicesService,
    );
    repository.seedTenant({ tenantId: TENANT_A, defaultCurrency: 'EUR', taxRateBps: 2000 });
    repository.seedTenant({ tenantId: TENANT_B, defaultCurrency: 'EUR', taxRateBps: 2000 });
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  describe('le total vient du serveur, et de nulle part ailleurs', () => {
    it('relit le prix de la prestation au catalogue, pas dans la requête', async () => {
      const prestation = catalog.seedService({ tenantId: TENANT_A, amountMinor: 7000 });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'SERVICE', serviceId: prestation.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.subtotal).toEqual({ amountMinor: 7000, currency: 'EUR' });
      expect(sale.total).toEqual({ amountMinor: 8400, currency: 'EUR' });
    });

    it('relit le prix de l’article au rayon, pas dans la requête', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 1850 });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 2 }] },
          CASHIER,
        ),
      );

      expect(sale.subtotal.amountMinor).toBe(3700);
    });

    it('fige sur la ligne le prix du jour de la vente, pas celui d’avant', async () => {
      // Le prix est figé **sur la ligne du ticket**, au moment de la vente : un
      // ticket composé après une hausse la porte, un ticket déjà émis reste ce
      // qu'il était. C'est cette moitié-ci que le service tient ; l'autre est
      // portée par la colonne `sale_items.unit_amount_minor`.
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 1850 });

      const premier = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      await inTenantA(() =>
        repository.updateProduct(article.id, { price: { amountMinor: 1950, currency: 'EUR' } }),
      );

      const second = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(premier.subtotal.amountMinor).toBe(1850);
      expect(second.subtotal.amountMinor).toBe(1950);
      // Le ticket déjà émis n'a pas bougé.
      const relu = await inTenantA(() => service.byId(premier.id));
      expect(relu.items[0]?.unitAmount.amountMinor).toBe(1850);
    });
  });

  describe('un ticket regroupe plusieurs lignes — premier critère', () => {
    it('facture services rendus et produits sur la même addition', async () => {
      const prestation = catalog.seedService({ tenantId: TENANT_A, amountMinor: 7000 });
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 1850 });

      const sale = await inTenantA(() =>
        service.open(
          {
            appointmentId: null,
            lines: [
              { kind: 'SERVICE', serviceId: prestation.id, quantity: 1 },
              { kind: 'PRODUCT', productId: article.id, quantity: 2 },
            ],
          },
          CASHIER,
        ),
      );

      expect(sale.items.map((item) => item.kind)).toEqual(['SERVICE', 'PRODUCT', 'TAX']);
      expect(sale.subtotal.amountMinor).toBe(7000 + 3700);
    });

    it('fige le libellé de chaque article sur sa ligne', async () => {
      const article = repository.seedProduct({
        tenantId: TENANT_A,
        name: 'Shampoing hydratant 250 ml',
      });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.items[0]?.label).toBe('Shampoing hydratant 250 ml');
    });
  });

  describe('vente liée à un rendez-vous ou autonome — deuxième critère', () => {
    it('rattache le ticket au rendez-vous quand il est désigné', async () => {
      const rendezVous = repository.seedAppointment({ tenantId: TENANT_A });
      const article = repository.seedProduct({ tenantId: TENANT_A });

      const sale = await inTenantA(() =>
        service.open(
          {
            appointmentId: rendezVous.id,
            lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }],
          },
          CASHIER,
        ),
      );

      expect(sale.appointmentId).toBe(rendezVous.id);
    });

    it('compose une vente retail autonome sans aucun rendez-vous', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.appointmentId).toBeNull();
    });

    it('refuse en 404 un rendez-vous inconnu de l’établissement', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A });
      const chezLeVoisin = repository.seedAppointment({ tenantId: TENANT_B });

      await expect(
        inTenantA(() =>
          service.open(
            {
              appointmentId: chezLeVoisin.id,
              lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }],
            },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('taxes et pourboires en lignes distinctes — cinquième critère', () => {
    it('compose la ligne de taxe à partir du taux de l’établissement', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 10_000 });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.tax.amountMinor).toBe(2000);
      expect(sale.items.at(-1)).toMatchObject({ kind: 'TAX', serviceId: null, productId: null });
    });

    it('accepte le pourboire de l’appelant — la seule valeur qu’il n’y ait pas à relire', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 10_000 });

      const sale = await inTenantA(() =>
        service.open(
          {
            appointmentId: null,
            lines: [
              { kind: 'PRODUCT', productId: article.id, quantity: 1 },
              { kind: 'TIP', amountMinor: 500 },
            ],
          },
          CASHIER,
        ),
      );

      expect(sale.tip.amountMinor).toBe(500);
      // La taxe reste assise sur le sous-total : un pourboire n'est pas une
      // prestation vendue.
      expect(sale.tax.amountMinor).toBe(2000);
      expect(sale.total.amountMinor).toBe(12_500);
    });

    it('n’ajoute aucune ligne de taxe dans un établissement sans taux', async () => {
      // Un établissement neuf, pour ne pas dépendre de l'ordre d'insertion du
      // double : un ticket sans taxe ne porte que ses articles, jamais une ligne
      // à zéro qui se lirait comme une anomalie sur le reçu.
      const exempt = new FakePosRepository();
      exempt.seedTenant({ tenantId: TENANT_A, defaultCurrency: 'EUR', taxRateBps: 0 });
      const article = exempt.seedProduct({ tenantId: TENANT_A, amountMinor: 10_000 });
      const sansTaxe = new SalesService(
        exempt as unknown as PosRepository,
        catalog as unknown as ServicesService,
      );

      const sale = await inTenantA(() =>
        sansTaxe.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.tax.amountMinor).toBe(0);
      expect(sale.items.map((item) => item.kind)).toEqual(['PRODUCT']);
      expect(sale.total.amountMinor).toBe(10_000);
    });
  });

  describe('les refus qui protègent la pièce comptable', () => {
    it('refuse en 422 un article retiré du rayon', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, isActive: false });

      await expect(
        inTenantA(() =>
          service.open(
            { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(SaleItemUnavailableError);
    });

    it('refuse en 422 une prestation retirée du catalogue', async () => {
      const prestation = catalog.seedService({ tenantId: TENANT_A, isActive: false });

      await expect(
        inTenantA(() =>
          service.open(
            { appointmentId: null, lines: [{ kind: 'SERVICE', serviceId: prestation.id, quantity: 1 }] },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(SaleItemUnavailableError);
    });

    it('refuse plutôt que de convertir un article libellé dans une autre devise', async () => {
      // Une conversion sans taux daté n'est pas une conversion : elle se
      // figerait dans une pièce comptable que le rapprochement relira des mois
      // plus tard.
      const article = repository.seedProduct({ tenantId: TENANT_A, currency: 'MGA' });

      await expect(
        inTenantA(() =>
          service.open(
            { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(SaleCurrencyMismatchError);
    });

    it('nomme le rang de la ligne fautive, jamais son identifiant', async () => {
      const bon = repository.seedProduct({ tenantId: TENANT_A });
      const retire = repository.seedProduct({ tenantId: TENANT_A, isActive: false });

      const refus = await inTenantA(() =>
        service
          .open(
            {
              appointmentId: null,
              lines: [
                { kind: 'PRODUCT', productId: bon.id, quantity: 1 },
                { kind: 'PRODUCT', productId: retire.id, quantity: 1 },
              ],
            },
            CASHIER,
          )
          .catch((error: unknown) => error),
      );

      expect(refus).toBeInstanceOf(SaleItemUnavailableError);
      expect((refus as SaleItemUnavailableError).details).toEqual({ position: 1 });
    });

    it('refuse un total qui déborde ce qu’une colonne de montant peut porter', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 2_000_000 });

      await expect(
        inTenantA(() =>
          service.open(
            {
              appointmentId: null,
              lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1000 }],
            },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(SaleAmountOutOfRangeError);
    });
  });

  describe('la frontière du tenant', () => {
    it('rend 404 sur la prestation du salon voisin — jamais 403, jamais son prix', async () => {
      const chezLeVoisin = catalog.seedService({ tenantId: TENANT_B, amountMinor: 9999 });

      await expect(
        inTenantA(() =>
          service.open(
            { appointmentId: null, lines: [{ kind: 'SERVICE', serviceId: chezLeVoisin.id, quantity: 1 }] },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(repository.allSales()).toHaveLength(0);
    });

    it('rend 404 sur l’article du salon voisin, et n’inscrit aucun ticket', async () => {
      const chezLeVoisin = repository.seedProduct({ tenantId: TENANT_B, amountMinor: 9999 });

      await expect(
        inTenantA(() =>
          service.open(
            { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: chezLeVoisin.id, quantity: 1 }] },
            CASHIER,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(repository.allSales()).toHaveLength(0);
    });

    it('ne trouve pas le ticket du salon voisin', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_B });
      const chezLeVoisin = await runWithTenant(TENANT_B, () =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      await expect(inTenantA(() => service.byId(chezLeVoisin.id))).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('la relecture d’un ticket', () => {
    it('rend les lignes dans l’ordre du reçu', async () => {
      const prestation = catalog.seedService({ tenantId: TENANT_A });
      const article = repository.seedProduct({ tenantId: TENANT_A });

      const written = await inTenantA(() =>
        service.open(
          {
            appointmentId: null,
            lines: [
              { kind: 'SERVICE', serviceId: prestation.id, quantity: 1 },
              { kind: 'PRODUCT', productId: article.id, quantity: 1 },
              { kind: 'TIP', amountMinor: 200 },
            ],
          },
          CASHIER,
        ),
      );

      const relu = await inTenantA(() => service.byId(written.id));

      expect(relu.items.map((item) => item.position)).toEqual([0, 1, 2, 3]);
      expect(relu.items.map((item) => item.kind)).toEqual(['SERVICE', 'PRODUCT', 'TAX', 'TIP']);
    });

    it('trace l’opérateur qui a composé le ticket', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A });

      const sale = await inTenantA(() =>
        service.open(
          { appointmentId: null, lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] },
          CASHIER,
        ),
      );

      expect(sale.cashierUserId).toBe(CASHIER);
    });

    it('rend 404 sur un ticket inconnu', async () => {
      await expect(
        inTenantA(() => service.byId('44444444-4444-4444-8444-444444444444')),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
