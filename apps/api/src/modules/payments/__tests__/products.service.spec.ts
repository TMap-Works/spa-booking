import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { ProductSkuTakenError } from '../pos.errors';
import type { PosRepository } from '../pos.repository';
import { ProductsService } from '../products.service';
import { FakePosRepository } from './pos.doubles';

/**
 * Le rayon retail, exercé sans HTTP ni base (#60).
 *
 * Trois propriétés y sont vérifiées, et aucune n'est visible depuis un test
 * d'intégration seul :
 *
 * - **la devise n'est pas un paramètre** — elle est celle de l'établissement ;
 * - **l'unicité du code est par tenant** — deux salons codent chacun leur
 *   `SH-01` sans se gêner ;
 * - **il n'y a pas de suppression** — un article se retire du rayon, et ses
 *   tickets passés restent.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('ProductsService — le rayon retail', () => {
  let repository: FakePosRepository;
  let service: ProductsService;

  beforeEach(() => {
    repository = new FakePosRepository();
    service = new ProductsService(repository as unknown as PosRepository);
    repository.seedTenant({ tenantId: TENANT_A, defaultCurrency: 'EUR' });
    repository.seedTenant({ tenantId: TENANT_B, defaultCurrency: 'MGA' });
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  describe('la création', () => {
    it('libelle le prix dans la devise de l’établissement, sans la demander', async () => {
      const product = await inTenantA(() =>
        service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 1850 }),
      );

      expect(product.price).toEqual({ amountMinor: 1850, currency: 'EUR' });
      expect(product.isActive).toBe(true);
    });

    it('donne à chaque salon sa propre devise', async () => {
      const chezB = await runWithTenant(TENANT_B, () =>
        service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 90_000 }),
      );

      expect(chezB.price.currency).toBe('MGA');
    });

    it('refuse en 409 un code déjà pris dans l’établissement', async () => {
      await inTenantA(() => service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 1850 }));

      await expect(
        inTenantA(() => service.create({ sku: 'SH-01', name: 'Autre', priceAmountMinor: 1000 })),
      ).rejects.toBeInstanceOf(ProductSkuTakenError);
    });

    it('ne recopie pas le code en cause dans le corps du refus', async () => {
      // Un corps de conflit qui recopie la valeur rend le refus distinguable
      // d'un autre — de quoi sonder, code par code, le rayon d'un salon.
      await inTenantA(() => service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 1850 }));

      const refus = await inTenantA(() =>
        service
          .create({ sku: 'SH-01', name: 'Autre', priceAmountMinor: 1000 })
          .catch((error: unknown) => error),
      );

      expect((refus as ProductSkuTakenError).details).toEqual({});
    });

    it('laisse le même code libre chez le voisin — l’unicité est par tenant', async () => {
      await inTenantA(() => service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 1850 }));

      const chezB = await runWithTenant(TENANT_B, () =>
        service.create({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 90_000 }),
      );

      expect(chezB.sku).toBe('SH-01');
    });
  });

  describe('la liste', () => {
    it('ne rend que le rayon vendable par défaut', async () => {
      repository.seedProduct({ tenantId: TENANT_A, name: 'Au rayon', isActive: true });
      repository.seedProduct({ tenantId: TENANT_A, name: 'Retiré', isActive: false });

      const products = await inTenantA(() => service.list({ includeInactive: false }));

      expect(products.map((product) => product.name)).toEqual(['Au rayon']);
    });

    it('rend aussi les articles retirés quand on les demande', async () => {
      repository.seedProduct({ tenantId: TENANT_A, name: 'Au rayon', isActive: true });
      repository.seedProduct({ tenantId: TENANT_A, name: 'Retiré', isActive: false });

      const products = await inTenantA(() => service.list({ includeInactive: true }));

      expect(products).toHaveLength(2);
    });

    it('ne laisse voir aucun article du salon voisin', async () => {
      const chezLeVoisin = repository.seedProduct({ tenantId: TENANT_B, name: 'Chez B' });
      repository.seedProduct({ tenantId: TENANT_A, name: 'Chez A' });

      const products = await inTenantA(() => service.list({ includeInactive: true }));

      expect(products.map((product) => product.id)).not.toContain(chezLeVoisin.id);
    });
  });

  describe('la modification', () => {
    it('change le prix en conservant la devise de l’établissement', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A, amountMinor: 1850 });

      const updated = await inTenantA(() => service.update(article.id, { priceAmountMinor: 1950 }));

      expect(updated.price).toEqual({ amountMinor: 1950, currency: 'EUR' });
    });

    it('retire l’article du rayon sans le supprimer', async () => {
      const article = repository.seedProduct({ tenantId: TENANT_A });

      const updated = await inTenantA(() => service.update(article.id, { isActive: false }));

      expect(updated.isActive).toBe(false);
      // La ligne est toujours là : les tickets passés la référencent.
      expect(repository.allProducts().map((product) => product.id)).toContain(article.id);
    });

    it('ne touche que les champs présents', async () => {
      const article = repository.seedProduct({
        tenantId: TENANT_A,
        name: 'Shampoing',
        amountMinor: 1850,
      });

      const updated = await inTenantA(() => service.update(article.id, { name: 'Shampoing bio' }));

      expect(updated.name).toBe('Shampoing bio');
      expect(updated.price.amountMinor).toBe(1850);
      expect(updated.isActive).toBe(true);
    });

    it('rend 404 sur l’article du salon voisin — jamais 403', async () => {
      const chezLeVoisin = repository.seedProduct({ tenantId: TENANT_B, name: 'Chez B' });

      await expect(
        inTenantA(() => service.update(chezLeVoisin.id, { name: 'Détourné' })),
      ).rejects.toBeInstanceOf(NotFoundError);

      // Et la ligne du voisin est intacte.
      expect(
        repository.allProducts().find((product) => product.id === chezLeVoisin.id)?.name,
      ).toBe('Chez B');
    });

    it('rend le même 404 sur un identifiant inconnu — les deux refus sont indiscernables', async () => {
      await expect(
        inTenantA(() => service.update('44444444-4444-4444-8444-444444444444', { name: 'X' })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
