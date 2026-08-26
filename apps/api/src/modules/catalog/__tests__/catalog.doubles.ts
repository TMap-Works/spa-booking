import { randomUUID } from 'node:crypto';

import { getTenantId } from '../../../common/tenant';
import {
  ServiceCategorySlugTakenError,
  ServiceStaffAlreadyAssignedError,
  ServiceSlugTakenError,
} from '../catalog.errors';
import type {
  CatalogRepository,
  PublicServiceRecord,
  ServiceCategoryPatch,
  ServiceCategoryRecord,
  ServicePatch,
  ServiceRecord,
  StaffRecord,
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
 *    cette valeur-là qui devient le 404 ; le `deleteMany` d'une affectation rend
 *    de même `false` dans les deux cas ;
 * 5. les **filtres d'activité de la projection publique** — prestations actives,
 *    praticiens actifs. Ils sont dans le `select` du vrai et non chez l'appelant,
 *    pour que la donnée retirée du catalogue ne quitte jamais la base.
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

interface StoredStaff {
  tenantId: string;
  id: string;
  displayName: string;
  isActive: boolean;
}

/**
 * Une ligne de `service_staff`.
 *
 * Le `tenantId` y est **stocké**, comme en base, plutôt que déduit de la
 * prestation : c'est ce qui permet aux tests de fabriquer la ligne croisée que
 * les clés étrangères composites interdisent, et de vérifier que le service la
 * refuse avant d'y arriver.
 */
interface StoredAssignment {
  tenantId: string;
  serviceId: string;
  staffId: string;
}

export class FakeCatalogRepository {
  public readonly categories: StoredCategory[] = [];
  public readonly services: StoredService[] = [];
  public readonly staff: StoredStaff[] = [];
  public readonly assignments: StoredAssignment[] = [];

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

  public seedStaff(input: {
    tenantId: string;
    displayName?: string;
    isActive?: boolean;
  }): StoredStaff {
    const member: StoredStaff = {
      tenantId: input.tenantId,
      id: randomUUID(),
      displayName: input.displayName ?? 'Camille Rousseau',
      isActive: input.isActive ?? true,
    };
    this.staff.push(member);
    return member;
  }

  /**
   * Pose une affectation sans passer par la portée — un jeu d'essai, pas un
   * appel d'API. Le tenant est donné en clair, ce qui autorise délibérément la
   * ligne croisée que la base refuserait : c'est ainsi qu'un test peut vérifier
   * que rien, dans les couches au-dessus, ne la rend visible.
   */
  public seedAssignment(input: {
    tenantId: string;
    serviceId: string;
    staffId: string;
  }): StoredAssignment {
    const assignment: StoredAssignment = { ...input };
    this.assignments.push(assignment);
    return assignment;
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

  // -------------------------------------------------------------------------
  // Affectations
  // -------------------------------------------------------------------------

  private toStaffRecord(member: StoredStaff): StaffRecord {
    return { id: member.id, displayName: member.displayName, isActive: member.isActive };
  }

  public async findStaffById(id: string): Promise<StaffRecord | null> {
    const tenantId = this.requireTenant();
    const member = this.staff.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return member === undefined ? null : this.toStaffRecord(member);
  }

  /**
   * Les praticiens affectés, **désactivés compris** — c'est ce que le vrai rend,
   * et ce que l'écran d'affectation doit montrer.
   *
   * Le filtre porte sur le tenant de la **ligne d'affectation**, comme le
   * `where` scopé du vrai : une ligne croisée posée par `seedAssignment` ne
   * remonte donc pas, même quand elle désigne une prestation d'ici.
   */
  public async listServiceStaff(serviceId: string): Promise<StaffRecord[]> {
    const tenantId = this.requireTenant();
    return this.assignments
      .filter(
        (assignment) => assignment.tenantId === tenantId && assignment.serviceId === serviceId,
      )
      .flatMap((assignment) =>
        this.staff.filter(
          (member) => member.tenantId === tenantId && member.id === assignment.staffId,
        ),
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((member) => this.toStaffRecord(member));
  }

  /** Reproduit l'unicité `(tenant_id, service_id, staff_id)` et son 409. */
  public async assignStaff(serviceId: string, staffId: string): Promise<void> {
    const tenantId = this.requireTenant();
    if (
      this.assignments.some(
        (assignment) =>
          assignment.tenantId === tenantId &&
          assignment.serviceId === serviceId &&
          assignment.staffId === staffId,
      )
    ) {
      throw new ServiceStaffAlreadyAssignedError(serviceId, staffId);
    }
    this.assignments.push({ tenantId, serviceId, staffId });
  }

  /** Reproduit le compte d'un `deleteMany` scopé — `false` pour zéro ligne. */
  public async removeStaff(serviceId: string, staffId: string): Promise<boolean> {
    const tenantId = this.requireTenant();
    const index = this.assignments.findIndex(
      (assignment) =>
        assignment.tenantId === tenantId &&
        assignment.serviceId === serviceId &&
        assignment.staffId === staffId,
    );
    if (index === -1) {
      return false;
    }
    this.assignments.splice(index, 1);
    return true;
  }

  /**
   * Le catalogue publiable — prestations **actives**, praticiens **actifs**.
   *
   * Les deux filtres sont ceux du vrai `select`, et ils comptent : c'est ici que
   * se vérifie qu'une prestation retirée du catalogue ne rejaillit pas sur la
   * page publique, et qu'un praticien désactivé n'y reste pas proposable.
   */
  public async listPublicServices(): Promise<PublicServiceRecord[]> {
    const tenantId = this.requireTenant();
    return this.services
      .filter((service) => service.tenantId === tenantId && service.isActive)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((service) => {
        const record = this.toServiceRecord(service);
        return {
          id: record.id,
          slug: record.slug,
          name: record.name,
          description: record.description,
          category: record.category,
          durationMinutes: record.durationMinutes,
          priceAmountMinor: record.priceAmountMinor,
          priceCurrency: record.priceCurrency,
          staff: this.assignments
            .filter(
              (assignment) =>
                assignment.tenantId === tenantId && assignment.serviceId === service.id,
            )
            .flatMap((assignment) =>
              this.staff.filter(
                (member) =>
                  member.tenantId === tenantId && member.id === assignment.staffId && member.isActive,
              ),
            )
            .sort((left, right) => left.displayName.localeCompare(right.displayName))
            .map((member) => ({ id: member.id, displayName: member.displayName })),
        };
      });
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asRepository(): CatalogRepository {
    return this as unknown as CatalogRepository;
  }
}
