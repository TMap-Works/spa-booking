import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import {
  ServiceCategorySlugTakenError,
  ServiceStaffAlreadyAssignedError,
  ServiceSlugTakenError,
} from './catalog.errors';
import type { PublicServiceView, ServiceCategoryView, ServiceView } from './catalog.types';

/**
 * Seul point du module qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une seule requête
 * d'ici ait à le répéter — donc sans qu'aucune puisse l'oublier. Le module n'a
 * **aucune** dérogation : contrairement à `identity`, rien ici n'est
 * légitimement inter-tenant, et `prismaUnscoped` n'y est donc pas injecté du
 * tout. C'est plus sûr qu'un client disponible dont on se promet de ne pas se
 * servir.
 */

/** Une catégorie, telle que le service en a besoin. */
export interface ServiceCategoryRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

/** Une prestation, catégorie déjà jointe. */
export interface ServiceRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: { id: string; slug: string; name: string } | null;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceAmountMinor: number;
  priceCurrency: string;
  isActive: boolean;
}

/** Champs modifiables d'une prestation — tous facultatifs, aucun ne l'est tous. */
export interface ServicePatch {
  slug?: string;
  name?: string;
  description?: string | null;
  categoryId?: string | null;
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  priceAmountMinor?: number;
  priceCurrency?: string;
  isActive?: boolean;
}

/** Une fiche praticien, réduite à ce que le catalogue en montre. */
export interface StaffRecord {
  id: string;
  displayName: string;
  isActive: boolean;
}

/** Une prestation publiable, praticiens actifs déjà joints. */
export interface PublicServiceRecord {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: { id: string; slug: string; name: string } | null;
  durationMinutes: number;
  priceAmountMinor: number;
  priceCurrency: string;
  staff: { id: string; displayName: string }[];
}

/** Champs modifiables d'une catégorie. */
export interface ServiceCategoryPatch {
  slug?: string;
  name?: string;
  description?: string | null;
  isActive?: boolean;
}

/**
 * Projections explicites, écrites une fois.
 *
 * Ni `tenantId`, ni `legacyCategory`, ni les horodatages : le `select` explicite
 * est ce qui rend vérifiable à la lecture qu'aucune entité Prisma brute ne sort
 * du module (api-module §4). Le premier est une information interne
 * (tenant-isolation §4) ; la seconde est la chaîne libre que #24 remplace et que
 * plus rien ne doit lire.
 */
const CATEGORY_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  isActive: true,
} as const;

/** Forme réduite de la catégorie, telle qu'imbriquée dans une prestation. */
const CATEGORY_SUMMARY_SELECT = { id: true, slug: true, name: true } as const;

const SERVICE_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  durationMinutes: true,
  bufferBeforeMinutes: true,
  bufferAfterMinutes: true,
  priceAmountMinor: true,
  priceCurrency: true,
  isActive: true,
  // Lecture de relation : elle ne repasse pas par l'extension de scoping, mais
  // se parcourt par clé étrangère depuis une ligne **déjà bornée** au tenant
  // courant par l'opération de premier niveau. Ce sont les clés composites
  // `(tenant_id, category_id)` de la migration qui interdisent que cette ligne
  // en désigne une d'un autre établissement.
  category: { select: CATEGORY_SUMMARY_SELECT },
} as const;

/**
 * La fiche praticien, réduite à ce que le catalogue a le droit d'en montrer.
 *
 * Ni `userId` — il révélerait le compte derrière la fiche —, ni `bio`, qui est
 * de la vitrine et n'a rien à faire dans une liste d'affectations où il ferait
 * transiter deux mille caractères par ligne.
 */
const STAFF_SELECT = { id: true, displayName: true, isActive: true } as const;

/** Forme réduite du praticien, telle que la page publique la reçoit. */
const STAFF_SUMMARY_SELECT = { id: true, displayName: true } as const;

/**
 * La prestation telle que le catalogue **public** la lit.
 *
 * Ni les tampons, ni `isActive` : le premier couple est de l'exploitation — la
 * cadence interne du salon —, le second vaudrait toujours `true` puisque la
 * lecture ne porte que sur des prestations actives. Ce qui n'est pas lu ici ne
 * peut pas fuiter plus loin.
 *
 * `assignedStaff` est filtré sur les praticiens **actifs** : un praticien
 * désactivé ne prend plus de rendez-vous, et le proposer au choix mènerait à un
 * créneau qu'aucun agenda ne peut honorer. Le filtre porte sur la relation, pas
 * sur la ligne d'affectation — celle-ci survit intacte à la désactivation, et la
 * réactivation la fait réapparaître sans avoir à la recréer.
 */
const PUBLIC_SERVICE_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  durationMinutes: true,
  priceAmountMinor: true,
  priceCurrency: true,
  category: { select: CATEGORY_SUMMARY_SELECT },
  assignedStaff: {
    where: { staff: { isActive: true } },
    select: { staff: { select: STAFF_SUMMARY_SELECT } },
    // Objet et non tableau à un élément : `as const` fige un littéral de tableau
    // en `readonly`, et Prisma n'accepte qu'un `OrderByInput[]` mutable. La forme
    // objet dit la même chose sans buter dessus.
    orderBy: { staff: { displayName: 'asc' } },
  },
} as const;

/**
 * Charge utile de création **sans** le tenant, tel que le repository l'écrit.
 *
 * Même conversion, et pour la même raison, que `identity.repository.ts` : le
 * type généré par Prisma exige `tenantId` — la colonne est `NOT NULL` — alors
 * que le repository ne doit justement pas le fournir. C'est l'extension qui le
 * pose depuis le contexte de requête, et qui **écrase** ce qui s'y trouverait.
 *
 * Ce qui rend la conversion sûre n'est pas une promesse : l'extension refuse
 * toute opération sans contexte de tenant, et la colonne n'a pas de valeur par
 * défaut. Si l'extension venait à être contournée, l'insertion échouerait en
 * base — bruyamment, jamais en silence.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/**
 * Un enregistrement, sous la forme que l'API rend.
 *
 * Les deux fonctions vivent ici — à côté des projections qu'elles consomment,
 * comme `toProfile` dans `identity.repository.ts` — et non dans les services :
 * c'est le même endroit qui décide ce qui sort de la base et ce qui sort de
 * l'API, donc le seul endroit à relire pour vérifier qu'aucune colonne interne
 * ne franchit la frontière.
 */
export function toCategoryView(category: ServiceCategoryRecord): ServiceCategoryView {
  return {
    id: category.id,
    slug: category.slug,
    name: category.name,
    description: category.description,
    isActive: category.isActive,
  };
}

export function toServiceView(service: ServiceRecord): ServiceView {
  return {
    id: service.id,
    slug: service.slug,
    name: service.name,
    description: service.description,
    category: service.category,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    // Dérivée à la sortie, jamais stockée : une quatrième colonne se
    // désynchroniserait de ses trois termes à la première mise à jour partielle.
    occupiedMinutes:
      service.bufferBeforeMinutes + service.durationMinutes + service.bufferAfterMinutes,
    // Le montant se reconstitue ici, à partir des deux colonnes plates. C'est la
    // frontière : au-delà, un prix est un couple indissociable, et personne n'a
    // de raison de manipuler un entier sans sa devise.
    price: { amountMinor: service.priceAmountMinor, currency: service.priceCurrency },
    isActive: service.isActive,
  };
}

/**
 * Une prestation publiable, sous la forme que la page de réservation reçoit.
 *
 * Le prix se recompose ici comme dans `toServiceView`, et les praticiens sont
 * recopiés champ par champ plutôt qu'étalés : c'est la même frontière, et un
 * `{ ...staff }` publierait le jour venu tout champ ajouté à la projection.
 */
export function toPublicServiceView(service: PublicServiceRecord): PublicServiceView {
  return {
    id: service.id,
    slug: service.slug,
    name: service.name,
    description: service.description,
    category: service.category,
    durationMinutes: service.durationMinutes,
    price: { amountMinor: service.priceAmountMinor, currency: service.priceCurrency },
    staff: service.staff.map((member) => ({ id: member.id, displayName: member.displayName })),
  };
}

/** Code Prisma d'une violation de contrainte d'unicité. */
const UNIQUE_VIOLATION = 'P2002';

/** `true` si l'erreur est une violation de `@@unique([tenantId, slug])`. */
function isSlugConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION;
}

@Injectable()
export class CatalogRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  // -------------------------------------------------------------------------
  // Catégories
  // -------------------------------------------------------------------------

  /**
   * Les catégories de l'établissement courant.
   *
   * Ordre stable par `name` : sans `orderBy`, PostgreSQL n'en garantit aucun et
   * la liste change d'un appel à l'autre — ce qui rend l'écran de back-office
   * illisible et toute assertion d'ordre fausse une fois sur deux. Pas de
   * pagination : le nombre de rubriques d'un catalogue de salon est borné par
   * nature, là où la clientèle ne l'est pas.
   */
  public async listCategories(activeOnly: boolean): Promise<ServiceCategoryRecord[]> {
    return this.prisma.serviceCategory.findMany({
      where: activeOnly ? { isActive: true } : {},
      select: CATEGORY_SELECT,
      orderBy: [{ name: 'asc' }],
    });
  }

  /**
   * Une catégorie de l'établissement courant, par identifiant.
   *
   * `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
   * `where`, et `findUnique` exige que le `where` désigne *exactement* une clé
   * unique — ce que `{ id, tenantId }` ne fait pas sous cette forme. Rend `null`
   * pour l'identifiant d'un autre établissement, ce qui donne le 404 attendu
   * plutôt qu'un 403 qui confirmerait l'existence de la ligne.
   */
  public async findCategoryById(id: string): Promise<ServiceCategoryRecord | null> {
    return this.prisma.serviceCategory.findFirst({ where: { id }, select: CATEGORY_SELECT });
  }

  public async createCategory(input: {
    slug: string;
    name: string;
    description: string | null;
  }): Promise<ServiceCategoryRecord> {
    try {
      return await this.prisma.serviceCategory.create({
        data: withScopedTenant<Prisma.ServiceCategoryUncheckedCreateInput>({
          slug: input.slug,
          name: input.name,
          description: input.description,
        }),
        select: CATEGORY_SELECT,
      });
    } catch (error: unknown) {
      // La base tranche, pas le contrôle préalable du service : deux créations
      // concurrentes sur le même slug le passent toutes les deux. Sans cette
      // traduction, la perdante recevrait un 500 là où le contrat annonce un 409.
      if (isSlugConflict(error)) {
        throw new ServiceCategorySlugTakenError(input.slug);
      }
      throw error;
    }
  }

  /**
   * Modifie une catégorie de l'établissement courant. Rend `null` si aucune
   * ligne n'a été touchée — identifiant inconnu, ou d'un autre établissement.
   *
   * `updateMany` et non `update` : sous le scoping, le `where` porte `id` **et**
   * `tenantId`, ce qui n'est pas une clé unique au sens de Prisma. Le compte est
   * surtout la propriété utile — il vaut `0` pour un identifiant d'un autre
   * établissement, ce qui donne le 404 sans avoir à distinguer les deux cas.
   *
   * La relecture qui suit est une seconde requête, donc un second instant : une
   * modification concurrente rendrait l'état le plus récent plutôt que celui que
   * cet appel vient d'écrire. C'est le comportement voulu — sur une fiche de
   * catalogue, la dernière écriture gagne, et rendre un état déjà périmé
   * tromperait davantage l'écran qui l'affiche.
   */
  public async updateCategory(
    id: string,
    patch: ServiceCategoryPatch,
  ): Promise<ServiceCategoryRecord | null> {
    const data: Prisma.ServiceCategoryUncheckedUpdateInput = {
      ...(patch.slug !== undefined && { slug: patch.slug }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    };

    try {
      const { count } = await this.prisma.serviceCategory.updateMany({ where: { id }, data });
      if (count === 0) {
        return null;
      }
    } catch (error: unknown) {
      if (isSlugConflict(error)) {
        throw new ServiceCategorySlugTakenError(patch.slug ?? '');
      }
      throw error;
    }

    return this.findCategoryById(id);
  }

  // -------------------------------------------------------------------------
  // Prestations
  // -------------------------------------------------------------------------

  /**
   * Les prestations de l'établissement courant.
   *
   * `@@index([tenantId, isActive])` sert le filtre d'activité,
   * `@@index([tenantId, categoryId])` celui de rubrique — les deux seules
   * lectures que cet endpoint sait produire.
   */
  public async listServices(filters: {
    activeOnly: boolean;
    categoryId?: string;
  }): Promise<ServiceRecord[]> {
    return this.prisma.service.findMany({
      where: {
        ...(filters.activeOnly && { isActive: true }),
        ...(filters.categoryId !== undefined && { categoryId: filters.categoryId }),
      },
      select: SERVICE_SELECT,
      orderBy: [{ name: 'asc' }],
    });
  }

  /** Une prestation de l'établissement courant — `null` hors de celui-ci. */
  public async findServiceById(id: string): Promise<ServiceRecord | null> {
    return this.prisma.service.findFirst({ where: { id }, select: SERVICE_SELECT });
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
    try {
      return await this.prisma.service.create({
        data: withScopedTenant<Prisma.ServiceUncheckedCreateInput>({
          slug: input.slug,
          name: input.name,
          description: input.description,
          categoryId: input.categoryId,
          durationMinutes: input.durationMinutes,
          bufferBeforeMinutes: input.bufferBeforeMinutes,
          bufferAfterMinutes: input.bufferAfterMinutes,
          priceAmountMinor: input.priceAmountMinor,
          priceCurrency: input.priceCurrency,
        }),
        select: SERVICE_SELECT,
      });
    } catch (error: unknown) {
      if (isSlugConflict(error)) {
        throw new ServiceSlugTakenError(input.slug);
      }
      throw error;
    }
  }

  /** Modifie une prestation — mêmes garanties que `updateCategory`. */
  public async updateService(id: string, patch: ServicePatch): Promise<ServiceRecord | null> {
    const data: Prisma.ServiceUncheckedUpdateInput = {
      ...(patch.slug !== undefined && { slug: patch.slug }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
      ...(patch.durationMinutes !== undefined && { durationMinutes: patch.durationMinutes }),
      ...(patch.bufferBeforeMinutes !== undefined && {
        bufferBeforeMinutes: patch.bufferBeforeMinutes,
      }),
      ...(patch.bufferAfterMinutes !== undefined && {
        bufferAfterMinutes: patch.bufferAfterMinutes,
      }),
      ...(patch.priceAmountMinor !== undefined && { priceAmountMinor: patch.priceAmountMinor }),
      ...(patch.priceCurrency !== undefined && { priceCurrency: patch.priceCurrency }),
      ...(patch.isActive !== undefined && { isActive: patch.isActive }),
    };

    try {
      const { count } = await this.prisma.service.updateMany({ where: { id }, data });
      if (count === 0) {
        return null;
      }
    } catch (error: unknown) {
      if (isSlugConflict(error)) {
        throw new ServiceSlugTakenError(patch.slug ?? '');
      }
      throw error;
    }

    return this.findServiceById(id);
  }

  // -------------------------------------------------------------------------
  // Affectation « ce praticien pratique cette prestation »
  // -------------------------------------------------------------------------

  /**
   * Une fiche praticien de l'établissement courant — `null` hors de celui-ci.
   *
   * Le module `catalog` lit la table `staff` sans en être propriétaire : il ne
   * la crée ni ne la modifie, il vérifie seulement qu'un identifiant reçu
   * désigne un praticien **d'ici** avant d'écrire l'affectation. Ce n'est pas
   * l'import du repository d'un autre module (api-module §3) — aucun module ne
   * possède encore la fiche praticien, et le jour où l'un la prendra, cette
   * lecture deviendra l'appel de service correspondant.
   */
  public async findStaffById(id: string): Promise<StaffRecord | null> {
    return this.prisma.staff.findFirst({ where: { id }, select: STAFF_SELECT });
  }

  /**
   * Les praticiens affectés à une prestation de l'établissement courant.
   *
   * `@@index([tenantId, staffId])` ne sert pas cette lecture-ci ; c'est l'unicité
   * `(tenant_id, service_id, staff_id)` qui la porte, son préfixe couvrant
   * exactement `where: { tenantId, serviceId }`.
   *
   * Les praticiens **désactivés** y figurent, contrairement au catalogue public :
   * un écran d'affectation doit montrer qu'une prestation reste rattachée à
   * quelqu'un qui ne prend plus de rendez-vous. Le masquer ferait croire à une
   * affectation perdue et inviterait à la recréer, pour se heurter au conflit
   * d'unicité.
   */
  public async listServiceStaff(serviceId: string): Promise<StaffRecord[]> {
    const assignments = await this.prisma.serviceStaff.findMany({
      where: { serviceId },
      select: { staff: { select: STAFF_SELECT } },
      orderBy: [{ staff: { displayName: 'asc' } }],
    });
    return assignments.map((assignment) => assignment.staff);
  }

  /**
   * Affecte un praticien à une prestation, tous deux de l'établissement courant.
   *
   * Lève `ServiceStaffAlreadyAssignedError` sur l'unicité
   * `(tenant_id, service_id, staff_id)` : c'est la base qui tranche, et non un
   * contrôle préalable du service, parce que deux clics concurrents sur la même
   * case le passeraient tous les deux. Sans cette traduction, le perdant
   * recevrait un 500 là où le contrat annonce un 409.
   *
   * Les deux clés étrangères composites `(tenant_id, service_id)` et
   * `(tenant_id, staff_id)` sont ce qui rend impossible d'affecter le praticien
   * d'un salon à la prestation d'un autre — même si les contrôles applicatifs
   * venaient à être contournés, l'insertion échouerait en base.
   */
  public async assignStaff(serviceId: string, staffId: string): Promise<void> {
    try {
      await this.prisma.serviceStaff.create({
        data: withScopedTenant<Prisma.ServiceStaffUncheckedCreateInput>({ serviceId, staffId }),
        select: { id: true },
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_VIOLATION) {
        throw new ServiceStaffAlreadyAssignedError(serviceId, staffId);
      }
      throw error;
    }
  }

  /**
   * Retire l'affectation. Rend `false` si elle n'existait pas — identifiants
   * inconnus, ou d'un autre établissement, indistinctement.
   *
   * `deleteMany` et non `delete` : sous le scoping, le `where` porte `tenantId`
   * en plus, ce qui n'est pas une clé unique au sens de Prisma. Le compte est de
   * toute façon la propriété utile — il vaut `0` pour une affectation d'ailleurs,
   * ce qui donne le 404 sans avoir à distinguer les deux cas.
   *
   * Une **suppression** ici, là où le reste du module désactive : une ligne
   * d'affectation n'est pas une donnée d'historique. Les rendez-vous déjà pris
   * portent leur propre `staff_id` et ne la référencent pas, si bien que la
   * retirer n'efface rien de ce qui a été vendu.
   */
  public async removeStaff(serviceId: string, staffId: string): Promise<boolean> {
    const { count } = await this.prisma.serviceStaff.deleteMany({ where: { serviceId, staffId } });
    return count > 0;
  }

  // -------------------------------------------------------------------------
  // Catalogue public
  // -------------------------------------------------------------------------

  /**
   * Le catalogue **publiable** de l'établissement de la requête.
   *
   * L'établissement vient du contexte ouvert par `TenantScopeMiddleware`, qui a
   * résolu le slug d'URL contre la table `tenants` : le client Prisma est déjà
   * borné, et il n'y a pas de paramètre par lequel désigner un autre salon.
   *
   * Ne rend que les prestations **actives** — le filtre est ici et non chez
   * l'appelant, pour que la donnée d'un catalogue retiré ne quitte jamais la
   * base. `@@index([tenantId, isActive])` le sert.
   */
  public async listPublicServices(): Promise<PublicServiceRecord[]> {
    const services = await this.prisma.service.findMany({
      where: { isActive: true },
      select: PUBLIC_SERVICE_SELECT,
      orderBy: [{ name: 'asc' }],
    });

    return services.map((service) => ({
      id: service.id,
      slug: service.slug,
      name: service.name,
      description: service.description,
      category: service.category,
      durationMinutes: service.durationMinutes,
      priceAmountMinor: service.priceAmountMinor,
      priceCurrency: service.priceCurrency,
      staff: service.assignedStaff.map((assignment) => assignment.staff),
    }));
  }
}
