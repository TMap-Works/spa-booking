import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { getTenantId } from '../../../common/tenant';
import type { UsersService } from '../../identity/users.service';
import {
  ServiceCategorySlugTakenError,
  ServiceStaffAlreadyAssignedError,
  ServiceSlugTakenError,
  StaffProfileAlreadyExistsError,
} from '../catalog.errors';
import type {
  CatalogRepository,
  PublicServiceRecord,
  ServiceCategoryPatch,
  ServiceCategoryRecord,
  ServicePatch,
  ServiceRecord,
  StaffPatch,
  StaffProfileRecord,
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
 *    pour que la donnée retirée du catalogue ne quitte jamais la base ;
 * 6. l'**unicité `(tenant_id, user_id)` de la fiche praticien** (#694), avec la
 *    même erreur de domaine que la traduction du code Prisma `P2002` — c'est
 *    elle qui interdit deux fiches pour la même personne.
 *
 * S'y ajoute `FakeUsersService`, en fin de fichier : le double du seul service
 * qu'un autre module rend à celui-ci.
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

/**
 * Une ligne de `staff`.
 *
 * `userId` y figure depuis #694 — il n'était pas nécessaire tant que la table
 * n'était que lue. Il l'est devenu : c'est lui que porte l'unicité
 * `(tenant_id, user_id)`, celle qui interdit deux fiches pour la même personne,
 * et un double qui l'ignorerait ferait passer le test du 409 sans rien prouver.
 */
interface StoredStaff {
  tenantId: string;
  id: string;
  userId: string;
  displayName: string;
  bio: string | null;
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
    userId?: string;
    displayName?: string;
    bio?: string | null;
    isActive?: boolean;
  }): StoredStaff {
    const member: StoredStaff = {
      tenantId: input.tenantId,
      id: randomUUID(),
      userId: input.userId ?? randomUUID(),
      displayName: input.displayName ?? 'Camille Rousseau',
      bio: input.bio ?? null,
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
   *
   * Les deux comptes de praticiens reproduisent les deux agrégats scopés du vrai
   * repository (`countStaffAssignments`) : **toutes** les affectations de la
   * prestation d'un côté, celles dont le praticien est actif de l'autre. Un double
   * qui les confondrait ferait passer le test pour de mauvaises raisons — c'est
   * précisément leur écart que #895 a rendu observable. Le filtre sur `tenantId`
   * est celui que l'extension de scoping pose sur les vraies requêtes.
   */
  private toServiceRecord(service: StoredService): ServiceRecord {
    const category = this.categories.find(
      (candidate) =>
        candidate.tenantId === service.tenantId && candidate.id === service.categoryId,
    );
    const assigned = this.assignments.filter(
      (assignment) =>
        assignment.tenantId === service.tenantId && assignment.serviceId === service.id,
    );
    const assignedStaffCount = assigned.length;
    const activeAssignedStaffCount = assigned.filter((assignment) =>
      this.staff.some(
        (member) =>
          member.tenantId === service.tenantId &&
          member.id === assignment.staffId &&
          member.isActive,
      ),
    ).length;

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
      assignedStaffCount,
      activeAssignedStaffCount,
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

  /**
   * Le lot de prestations, scopé comme le vrai — et **sans les absentes**
   * (#420).
   *
   * Trois propriétés du vrai, chacune portée par un test : le résultat n'a pas
   * la longueur de l'entrée — un identifiant inconnu, ou d'un autre
   * établissement, en est simplement absent, c'est la propriété 4 déclinée pour
   * un lot —, deux fois le même identifiant ne rend qu'une prestation comme le
   * `IN` de la base les confond, et le lot vide court-circuite **avant** la
   * portée, le vrai ne touchant alors pas la base.
   */
  public async findServicesByIds(ids: readonly string[]): Promise<ServiceRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const tenantId = this.requireTenant();
    const wanted = new Set(ids);

    return this.services
      .filter((candidate) => candidate.tenantId === tenantId && wanted.has(candidate.id))
      .map((service) => this.toServiceRecord(service));
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

  /**
   * La fiche **présentation comprise** — la projection des routes dont la fiche
   * est l'objet (#771).
   *
   * Deux projections plutôt qu'une, comme le vrai repository : `listServiceStaff`
   * lit `STAFF_SELECT` et les trois autres `STAFF_PROFILE_SELECT`. Un double qui
   * rendrait `bio` partout laisserait passer une liste d'affectations qui
   * transporte la vitrine, et un double qui ne le rendrait nulle part ferait
   * passer les tests de la fiche sans rien prouver.
   */
  private toStaffProfileRecord(member: StoredStaff): StaffProfileRecord {
    return { ...this.toStaffRecord(member), bio: member.bio };
  }

  public async findStaffById(id: string): Promise<StaffProfileRecord | null> {
    const tenantId = this.requireTenant();
    const member = this.staff.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    return member === undefined ? null : this.toStaffProfileRecord(member);
  }

  /**
   * L'annuaire des fiches de l'établissement courant (#421), **désactivées
   * comprises** par défaut.
   *
   * Le filtre porte sur le tenant de la **fiche** — c'est ce que le `where`
   * scopé du vrai fait —, et non sur une affectation : c'est toute la différence
   * avec `listServiceStaff`, et c'est ce qui permet d'amorcer un salon où rien
   * n'est encore affecté.
   */
  public async listStaff(activeOnly: boolean): Promise<StaffProfileRecord[]> {
    const tenantId = this.requireTenant();
    return this.staff
      .filter((member) => member.tenantId === tenantId && (!activeOnly || member.isActive))
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((member) => this.toStaffProfileRecord(member));
  }

  /**
   * Reproduit l'unicité `(tenant_id, user_id)` et son 409 (#694).
   *
   * La fiche naît **active** — c'est le `@default(true)` de la colonne, et c'est
   * le sens du geste : on crée une fiche pour qu'elle prenne des rendez-vous.
   *
   * Ce que le double ne reproduit pas, et n'a pas à reproduire : la clé
   * étrangère composite `(tenant_id, user_id)` vers `users`. Le compte n'est pas
   * vérifié ici, il l'est un cran plus haut par `UsersService` — c'est
   * précisément le partage de responsabilité que le service documente.
   */
  public async createStaff(input: {
    userId: string;
    displayName: string;
    bio: string | null;
  }): Promise<StaffProfileRecord> {
    const tenantId = this.requireTenant();

    if (
      this.staff.some(
        (candidate) => candidate.tenantId === tenantId && candidate.userId === input.userId,
      )
    ) {
      throw new StaffProfileAlreadyExistsError(input.userId);
    }

    const member: StoredStaff = { tenantId, id: randomUUID(), isActive: true, ...input };
    this.staff.push(member);
    return this.toStaffProfileRecord(member);
  }

  /** Reproduit la valeur de retour d'un `updateMany` scopé — `null` pour zéro ligne. */
  public async updateStaff(id: string, patch: StaffPatch): Promise<StaffProfileRecord | null> {
    const tenantId = this.requireTenant();
    const member = this.staff.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
    if (member === undefined) {
      return null;
    }

    Object.assign(member, patch);
    return this.toStaffProfileRecord(member);
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

/**
 * Le double de `UsersService`, réduit à ce que `catalog` lui demande : « ce
 * compte est-il un compte **interne d'ici** ? » (#694).
 *
 * Il reproduit la seule propriété qui compte pour l'appelant — un 404 qui
 * **confond** les trois refus : compte inconnu, compte de l'établissement
 * voisin, fiche cliente. Les distinguer ferait de la création de fiche un oracle
 * sur l'annuaire du voisin (tenant-isolation §4), et un double qui les
 * distinguerait laisserait passer cette régression sans rien dire.
 *
 * Le tenant est lu dans la **portée courante**, comme le vrai le fait par son
 * client Prisma scopé : un test qui pose un compte chez le voisin et l'appelle
 * d'ici doit voir le même 404 que la production.
 */
export class FakeUsersService {
  public readonly accounts: { tenantId: string; id: string; isClient: boolean }[] = [];

  /** Pose un compte sans passer par la portée — un jeu d'essai, pas un appel. */
  public seedAccount(input: { tenantId: string; isClient?: boolean }): { id: string } {
    const account = { tenantId: input.tenantId, id: randomUUID(), isClient: input.isClient ?? false };
    this.accounts.push(account);
    return account;
  }

  public async byId(userId: string): Promise<{ id: string }> {
    const tenantId = getTenantId();
    if (tenantId === undefined) {
      throw new Error('aucun tenant courant — le double refuse de lire sans portée');
    }

    const account = this.accounts.find(
      (candidate) =>
        candidate.tenantId === tenantId && candidate.id === userId && !candidate.isClient,
    );

    if (account === undefined) {
      throw new NotFoundError('Compte introuvable.');
    }

    return { id: account.id };
  }

  /** Vue typée pour l'injection dans les services du module. */
  public asService(): UsersService {
    return this as unknown as UsersService;
  }
}
