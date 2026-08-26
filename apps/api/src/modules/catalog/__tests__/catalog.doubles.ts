import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import { ServiceCategorySlugTakenError, ServiceSlugTakenError } from '../catalog.errors';
import type {
  CatalogRepository,
  ServiceCategoryPatch,
  ServiceCategoryRecord,
  ServicePatch,
  ServiceRecord,
} from '../catalog.repository';

/**
 * Doubles du module `catalog`, partagés par ses suites unitaires et par les
 * suites d'isolation.
 *
 * Le dépôt en mémoire reproduit **quatre propriétés précises** du vrai, et
 * chacune porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent. C'est ce que l'extension Prisma
 *    fait en vrai. Un double qui ignorerait le tenant ferait passer les tests
 *    d'isolation pour de mauvaises raisons, ce qui est pire que de ne pas les
 *    écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération. Le
 *    mode ouvert par défaut est ce qui produit les fuites ;
 * 3. l'**unicité du slug par tenant**, avec la même erreur de domaine que la
 *    traduction du code Prisma `P2002` ;
 * 4. la **valeur de retour d'un `updateMany` scopé** — `null` pour un
 *    identifiant inconnu *ou* d'un autre établissement, indistinctement. C'est
 *    cette valeur-là qui devient le 404.
 */

interface StoredCategory {
  tenantId: string;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

interface StoredService {
  tenantId: string;
  id: string;
  slug: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceAmountMinor: number;
  priceCurrency: string;
  isActive: boolean;
}

export class FakeCatalogRepository {
  public readonly categories: StoredCategory[] = [];
  public readonly services: StoredService[] = [];

  /**
   * Insère une catégorie **sans passer par la portée** — c'est l'équivalent d'un
   * jeu d'essai posé en base, pas d'un appel d'API. Le tenant est donc donné en
   * clair, ce qui est précisément ce qu'un test d'isolation doit pouvoir faire
   * pour préparer les données de l'établissement voisin.
   */
  public seedCategory(input: {
    tenantId: string;
    name?: string;
    slug?: string;
    isActive?: boolean;
  }): StoredCategory {
    const category: StoredCategory = {
      tenantId: input.tenantId,
      id: randomUUID(),
      slug: input.slug ?? 'soins-du-visage',
      name: input.name ?? 'Soins du visage',
      description: null,
      isActive: input.isActive ?? true,
    };
    this.categories.push(category);
    return category;
  }

  public seedService(input: {
    tenantId: string;
    name?: string;
    slug?: string;
    categoryId?: string | null;
    durationMinutes?: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    priceAmountMinor?: number;
    priceCurrency?: string;
    isActive?: boolean;
  }): StoredService {
    const service: StoredService = {
      tenantId: input.tenantId,
      id: randomUUID(),
      slug: input.slug ?? 'massage-60-min',
      name: input.name ?? 'Massage 60 min',
      description: null,
      categoryId: input.categoryId ?? null,
      durationMinutes: input.durationMinutes ?? 60,
      bufferBeforeMinutes: input.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: input.bufferAfterMinutes ?? 0,
      priceAmountMinor: input.priceAmountMinor ?? 7000,
      priceCurrency: input.priceCurrency ?? 'EUR',
      isActive: input.isActive ?? true,
    };
    this.services.push(service);
    return service;
  }

  private requireTenant(): string {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      // Défaut fermé, comme l'extension : sans tenant, pas de données. Ne jamais
      // retomber sur « toutes les lignes » — c'est le mode ouvert qui fuit.
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }
    return tenantId;
  }

  private toCategoryRecord(category: StoredCategory): ServiceCategoryRecord {
    return {
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      isActive: category.isActive,
    };
  }

  /**
   * Reproduit la jointure du `select` : la catégorie imbriquée se lit par clé
   * étrangère **depuis une ligne déjà bornée au tenant**, et la clé composite
   * `(tenant_id, category_id)` interdit qu'elle en désigne une d'ailleurs. Le
   * double filtre donc lui aussi sur le tenant de la prestation — sans quoi il
   * autoriserait un rattachement que la base refuse.
   */
  private toServiceRecord(service: StoredService): ServiceRecord {
    const category = this.categories.find(
      (candidate) =>
        candidate.tenantId === service.tenantId && candidate.id === service.categoryId,
    );

    return {
      id: service.id,
      slug: service.slug,
      name: service.name,
      description: service.description,
      category:
        category === undefined
          ? null
          : { id: category.id, slug: category.slug, name: category.name },
      durationMinutes: service.durationMinutes,
      bufferBeforeMinutes: service.bufferBeforeMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
      priceAmountMinor: service.priceAmountMinor,
      priceCurrency: service.priceCurrency,
      isActive: service.isActive,
    };
  }

  // -------------------------------------------------------------------------
  // Catégories
  // -------------------------------------------------------------------------

  public async listCategories(activeOnly: boolean): Promise<ServiceCategoryRecord[]> {
    const tenantId = this.requireTenant();
    return this.categories
      .filter(
        (category) =>
          category.tenantId === tenantId && (!activeOnly || category.isActive),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((category) => this.toCategoryRecord(category));
  }

  public async findCategoryById(id: string): Promise<ServiceCategoryRecord | null> {
    const tenantId = this.requireTenant();
    const category = this.categories.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return category === undefined ? null : this.toCategoryRecord(category);
  }

  public async createCategory(input: {
    slug: string;
    name: string;
    description: string | null;
  }): Promise<ServiceCategoryRecord> {
    const tenantId = this.requireTenant();
    if (
      this.categories.some(
        (candidate) => candidate.tenantId === tenantId && candidate.slug === input.slug,
      )
    ) {
      throw new ServiceCategorySlugTakenError(input.slug);
    }

    const category: StoredCategory = {
      tenantId,
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      description: input.description,
      isActive: true,
    };
    this.categories.push(category);
    return this.toCategoryRecord(category);
  }

  public async updateCategory(
    id: string,
    patch: ServiceCategoryPatch,
  ): Promise<ServiceCategoryRecord | null> {
    const tenantId = this.requireTenant();
    const category = this.categories.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    if (category === undefined) {
      return null;
    }

    if (
      patch.slug !== undefined &&
      this.categories.some(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.id !== id &&
          candidate.slug === patch.slug,
      )
    ) {
      throw new ServiceCategorySlugTakenError(patch.slug);
    }

    Object.assign(category, patch);
    return this.toCategoryRecord(category);
  }

  // -------------------------------------------------------------------------
  // Prestations
  // -------------------------------------------------------------------------

  public async listServices(filters: {
    activeOnly: boolean;
    categoryId?: string;
  }): Promise<ServiceRecord[]> {
    const tenantId = this.requireTenant();
    return this.services
      .filter(
        (service) =>
          service.tenantId === tenantId &&
          (!filters.activeOnly || service.isActive) &&
          (filters.categoryId === undefined || service.categoryId === filters.categoryId),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((service) => this.toServiceRecord(service));
  }

  public async findServiceById(id: string): Promise<ServiceRecord | null> {
    const tenantId = this.requireTenant();
    const service = this.services.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return service === undefined ? null : this.toServiceRecord(service);
  }

  public async createService(input: {
    slug: string;
    name: string;
    description: string | null;
    categoryId: string | null;
    durationMinutes: number;
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    priceAmountMinor: number;
    priceCurrency: string;
  }): Promise<ServiceRecord> {
    const tenantId = this.requireTenant();
    if (
      this.services.some(
        (candidate) => candidate.tenantId === tenantId && candidate.slug === input.slug,
      )
    ) {
      throw new ServiceSlugTakenError(input.slug);
    }

    const service: StoredService = { tenantId, id: randomUUID(), isActive: true, ...input };
    this.services.push(service);
    return this.toServiceRecord(service);
  }

  public async updateService(id: string, patch: ServicePatch): Promise<ServiceRecord | null> {
    const tenantId = this.requireTenant();
    const service = this.services.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    if (service === undefined) {
      return null;
    }

    if (
      patch.slug !== undefined &&
      this.services.some(
        (candidate) =>
          candidate.tenantId === tenantId && candidate.id !== id && candidate.slug === patch.slug,
      )
    ) {
      throw new ServiceSlugTakenError(patch.slug);
    }

    Object.assign(service, patch);
    return this.toServiceRecord(service);
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asRepository(): CatalogRepository {
    return this as unknown as CatalogRepository;
  }
}
