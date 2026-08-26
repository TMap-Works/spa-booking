import { randomUUID } from 'node:crypto';

import { BusinessRuleError, NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { ServiceCategorySlugTakenError } from '../catalog.errors';
import { ServiceCategoriesService } from '../service-categories.service';
import { FakeCatalogRepository } from './catalog.doubles';

/**
 * Règles métier des rubriques du catalogue — sans HTTP, sans base.
 *
 * Comme pour les prestations, le service est exercé **dans une portée de
 * tenant** : celle que `JwtAuthGuard` renseigne en vrai.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

describe('ServiceCategoriesService', () => {
  let repository: FakeCatalogRepository;
  let categories: ServiceCategoriesService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    categories = new ServiceCategoriesService(repository.asRepository());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  describe('création', () => {
    it('dérive le slug du nom et crée la rubrique active', async () => {
      const created = await inTenantA(async () => categories.create({ name: 'Soins du Visage' }));

      expect(created).toMatchObject({
        slug: 'soins-du-visage',
        name: 'Soins du Visage',
        description: null,
        isActive: true,
      });
    });

    it('refuse en 422 un nom dont aucun slug ne peut sortir', async () => {
      // Un slug vide passerait l'unicité une fois puis échouerait pour toutes
      // les suivantes, et produirait une URL publique inatteignable.
      const error = await inTenantA(async () => rejectionOf(categories.create({ name: '!!!' })));

      expect(error).toBeInstanceOf(BusinessRuleError);
      expect(error).toMatchObject({ status: 422, details: { field: 'name' } });
    });

    it('refuse un slug déjà pris dans cet établissement', async () => {
      await inTenantA(async () => categories.create({ name: 'Coiffure' }));

      const error = await inTenantA(async () =>
        rejectionOf(categories.create({ name: 'coiffure' })),
      );

      expect(error).toBeInstanceOf(ServiceCategorySlugTakenError);
      expect(error).toMatchObject({ status: 409, details: { slug: 'coiffure' } });
    });

    it('laisse deux établissements porter la même rubrique', async () => {
      const a = await inTenantA(async () => categories.create({ name: 'Coiffure' }));
      const b = await inTenantB(async () => categories.create({ name: 'Coiffure' }));

      expect(a.slug).toBe(b.slug);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe('lecture', () => {
    it('ne liste que les rubriques de l’établissement courant', async () => {
      repository.seedCategory({ tenantId: TENANT_A, name: 'Coiffure', slug: 'coiffure' });
      repository.seedCategory({ tenantId: TENANT_B, name: 'Barbier', slug: 'barbier' });

      const listed = await inTenantA(async () => categories.list(false));

      expect(listed.map((category) => category.name)).toEqual(['Coiffure']);
    });

    it('filtre sur l’activité quand on le demande', async () => {
      repository.seedCategory({ tenantId: TENANT_A, name: 'Coiffure', slug: 'coiffure' });
      repository.seedCategory({
        tenantId: TENANT_A,
        name: 'Saison passée',
        slug: 'saison-passee',
        isActive: false,
      });

      expect(await inTenantA(async () => categories.list(false))).toHaveLength(2);
      expect(await inTenantA(async () => categories.list(true))).toHaveLength(1);
    });

    it('répond 404 pour la rubrique d’un autre établissement', async () => {
      const chezB = repository.seedCategory({ tenantId: TENANT_B });

      const error = await inTenantA(async () => rejectionOf(categories.byId(chezB.id)));

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe('modification', () => {
    it('ne touche que les champs présents, et efface sur un `null` explicite', async () => {
      const seeded = repository.seedCategory({
        tenantId: TENANT_A,
        name: 'Coiffure',
        slug: 'coiffure',
      });
      await inTenantA(async () => categories.update(seeded.id, { description: 'Coupe, couleur' }));

      const renamed = await inTenantA(async () =>
        categories.update(seeded.id, { name: 'Coiffure & couleur' }),
      );
      // Le slug ne suit **pas** le nom : c'est ce qui préserve l'URL publique
      // d'une rubrique renommée. Le changer se demande explicitement.
      expect(renamed).toMatchObject({
        name: 'Coiffure & couleur',
        slug: 'coiffure',
        description: 'Coupe, couleur',
      });

      const cleared = await inTenantA(async () =>
        categories.update(seeded.id, { description: null }),
      );
      expect(cleared.description).toBeNull();
    });

    it('désactive sans supprimer — la ligne reste, les prestations avec', async () => {
      const seeded = repository.seedCategory({ tenantId: TENANT_A });
      repository.seedService({ tenantId: TENANT_A, categoryId: seeded.id });

      const updated = await inTenantA(async () =>
        categories.update(seeded.id, { isActive: false }),
      );

      expect(updated.isActive).toBe(false);
      // Retirer une rubrique du catalogue ne retire pas les soins qu'elle
      // regroupait : ils restent vendables et gardent leur rattachement, ce qui
      // permet précisément de reclasser à froid.
      expect(repository.categories).toHaveLength(1);
      expect(repository.services[0]).toMatchObject({ categoryId: seeded.id, isActive: true });
    });

    it('répond 404 pour la rubrique d’un autre établissement, sans rien écrire', async () => {
      const chezB = repository.seedCategory({ tenantId: TENANT_B, name: 'Barbier' });

      const error = await inTenantA(async () =>
        rejectionOf(categories.update(chezB.id, { name: 'Détourné', isActive: false })),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.categories[0]).toMatchObject({ name: 'Barbier', isActive: true });
    });

    it('refuse un slug déjà porté par une autre rubrique du même établissement', async () => {
      repository.seedCategory({ tenantId: TENANT_A, slug: 'coiffure' });
      const autre = repository.seedCategory({ tenantId: TENANT_A, slug: 'barbier' });

      const error = await inTenantA(async () =>
        rejectionOf(categories.update(autre.id, { slug: 'coiffure' })),
      );

      expect(error).toBeInstanceOf(ServiceCategorySlugTakenError);
    });
  });

  it('refuse toute opération hors portée de tenant', async () => {
    await expect(categories.list(false)).rejects.toThrow(/tenant/i);
  });
});
