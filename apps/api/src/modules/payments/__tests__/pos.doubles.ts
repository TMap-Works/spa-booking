import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { getTenantId } from '../../../common/tenant';
import type { ServiceView } from '../../catalog/catalog.types';
import type { ServicesService } from '../../catalog/services.service';
import type { PosRepository } from '../pos.repository';
import type {
  Product,
  ProductDraft,
  ProductPatch,
  Sale,
  SaleDraft,
  SaleHistoryFilter,
  SaleItem,
  SaleSummary,
  TenantSaleSettings,
} from '../pos.types';

/**
 * Doubles du POS, partagés par ses suites unitaires et par ses suites
 * d'intégration et d'isolation (#60).
 *
 * Le dépôt en mémoire reproduit **quatre propriétés précises** du vrai, et
 * chacune porte un test :
 *
 * 1. le **scoping par tenant** — chaque ligne porte son `tenantId`, et toute
 *    lecture comme toute écriture le filtrent, exactement comme l'extension
 *    Prisma le fait en vrai. Un double qui ignorerait le tenant ferait passer
 *    les tests d'isolation pour de mauvaises raisons, ce qui est pire que de ne
 *    pas les écrire ;
 * 2. le **défaut fermé** — sans portée de tenant résolue, aucune opération. Le
 *    mode ouvert par défaut est ce qui produit les fuites ;
 * 3. l'**unicité `(tenantId, sku)`**, rendue par un `null` de `createProduct`
 *    comme le vrai traduit le code Prisma `P2002` ;
 * 4. la **projection** — ce que le vrai ne lit pas, le double ne le connaît pas
 *    non plus, faute de quoi un test pourrait s'appuyer sur une donnée que le
 *    module n'a jamais eue.
 *
 * Le catalogue, lui, est doublé au niveau du **service** et non du dépôt : c'est
 * `ServicesService` que `SalesService` appelle (api-module §3), et c'est donc sa
 * frontière — 404 hors de l'établissement courant — qu'il faut reproduire.
 */

/** Sans portée résolue, rien ne passe — c'est la propriété 2. */
function requireTenant(): string {
  const tenantId = getTenantId();

  if (tenantId === undefined) {
    throw new Error(
      'FakePosRepository : aucune portée de tenant ouverte. Le vrai dépôt ' +
        'lèverait `MissingTenantContextError` — un double qui rendrait « toutes ' +
        'les lignes » ferait verdir la fuite qu’on cherche.',
    );
  }

  return tenantId;
}

interface StoredTenant {
  tenantId: string;
  defaultCurrency: string;
  taxRateBps: number;
}

/**
 * Les lignes du double sont **mutables** là où les formes du domaine sont
 * `readonly` : `updateProduct` écrit en place, comme le vrai écrit en base. Un
 * `extends Product` aurait hérité de l'immuabilité, qui décrit ce que le module
 * rend et non ce que la table contient.
 */
interface StoredProduct {
  tenantId: string;
  id: string;
  sku: string;
  name: string;
  price: { amountMinor: number; currency: string };
  isActive: boolean;
}

interface StoredSale extends Sale {
  tenantId: string;
}

interface StoredAppointment {
  tenantId: string;
  id: string;
}

/**
 * La surface publique du vrai dépôt, et rien d'autre.
 *
 * `Pick` plutôt qu'`implements PosRepository` : le vrai porte un champ privé
 * (`prisma`), et TypeScript n'autorise à implémenter un type à membres privés
 * que par héritage. Le témoin qu'on veut ici n'est pas la parenté, c'est la
 * **substituabilité** — une méthode renommée dans le vrai fait échouer la
 * compilation de ce fichier.
 */
type PosRepositoryPort = Pick<
  PosRepository,
  | 'tenantSaleSettings'
  | 'listProducts'
  | 'findProductById'
  | 'createProduct'
  | 'updateProduct'
  | 'appointmentExists'
  | 'createSale'
  | 'findSaleById'
  | 'listSales'
>;

export class FakePosRepository implements PosRepositoryPort {
  private readonly tenants: StoredTenant[] = [];
  private readonly products: StoredProduct[] = [];
  private readonly sales: StoredSale[] = [];
  private readonly appointments: StoredAppointment[] = [];

  /**
   * Déclare le paramétrage d'un établissement.
   *
   * Le `tenantId` est **explicite** et non pris dans le contexte : une suite de
   * fuite sème chez A pour lire chez B, ce qu'un ensemencement scopé rendrait
   * impossible à écrire.
   */
  public seedTenant(input: {
    tenantId: string;
    defaultCurrency?: string;
    taxRateBps?: number;
  }): StoredTenant {
    const row: StoredTenant = {
      tenantId: input.tenantId,
      defaultCurrency: input.defaultCurrency ?? 'EUR',
      taxRateBps: input.taxRateBps ?? 0,
    };
    this.tenants.push(row);
    return row;
  }

  /** Sème un article dans un établissement. */
  public seedProduct(input: {
    tenantId: string;
    id?: string;
    sku?: string;
    name?: string;
    amountMinor?: number;
    currency?: string;
    isActive?: boolean;
  }): StoredProduct {
    const row: StoredProduct = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      sku: input.sku ?? `SKU-${randomUUID().slice(0, 8)}`,
      name: input.name ?? 'Shampoing hydratant 250 ml',
      price: {
        amountMinor: input.amountMinor ?? 1850,
        currency: input.currency ?? this.currencyOf(input.tenantId),
      },
      isActive: input.isActive ?? true,
    };
    this.products.push(row);
    return row;
  }

  /** Sème un rendez-vous — le POS n'en lit que l'existence. */
  public seedAppointment(input: { tenantId: string; id?: string }): StoredAppointment {
    const row: StoredAppointment = { tenantId: input.tenantId, id: input.id ?? randomUUID() };
    this.appointments.push(row);
    return row;
  }

  /**
   * Sème un ticket déjà inscrit — l'ensemencement de l'historique (#62).
   *
   * Le `tenantId`, l'opérateur et l'instant sont **explicites** : une suite de
   * fuite sème chez A pour lire chez B, et une suite de filtre a besoin de poser
   * deux tickets de part et d'autre d'une borne à la milliseconde près. Aucun ne
   * pourrait s'écrire en passant par `createSale`, qui les prend du contexte et
   * de l'horloge.
   */
  public seedSale(input: {
    tenantId: string;
    id?: string;
    appointmentId?: string | null;
    cashierUserId?: string;
    totalAmountMinor?: number;
    currency?: string;
    createdAt?: Date;
  }): StoredSale {
    const currency = input.currency ?? this.currencyOf(input.tenantId);
    const total = input.totalAmountMinor ?? 1850;
    const row: StoredSale = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      appointmentId: input.appointmentId ?? null,
      cashierUserId: input.cashierUserId ?? randomUUID(),
      subtotal: { amountMinor: total, currency },
      tax: { amountMinor: 0, currency },
      tip: { amountMinor: 0, currency },
      total: { amountMinor: total, currency },
      items: [],
      createdAt: input.createdAt ?? new Date(),
    };
    this.sales.push(row);
    return row;
  }

  /** Tous les articles, tous établissements confondus — pour l'assertion « intact ». */
  public allProducts(): readonly StoredProduct[] {
    return this.products;
  }

  /** Tous les tickets, tous établissements confondus. */
  public allSales(): readonly StoredSale[] {
    return this.sales;
  }

  public tenantSaleSettings(): Promise<TenantSaleSettings | null> {
    const tenantId = requireTenant();
    const row = this.tenants.find((candidate) => candidate.tenantId === tenantId);

    return Promise.resolve(
      row === undefined
        ? null
        : { defaultCurrency: row.defaultCurrency, taxRateBps: row.taxRateBps },
    );
  }

  public listProducts(options: { includeInactive: boolean }): Promise<Product[]> {
    const tenantId = requireTenant();

    return Promise.resolve(
      this.products
        .filter((candidate) => candidate.tenantId === tenantId)
        .filter((candidate) => options.includeInactive || candidate.isActive)
        .map((candidate) => toProduct(candidate))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  public findProductById(id: string): Promise<Product | null> {
    const row = this.locateProduct(id);

    return Promise.resolve(row === undefined ? null : toProduct(row));
  }

  public createProduct(draft: ProductDraft): Promise<Product | null> {
    const tenantId = requireTenant();
    const taken = this.products.some(
      (candidate) => candidate.tenantId === tenantId && candidate.sku === draft.sku,
    );

    // Propriété 3 : l'unicité est tranchée ici, comme la base la tranche.
    if (taken) {
      return Promise.resolve(null);
    }

    const row: StoredProduct = {
      tenantId,
      id: randomUUID(),
      sku: draft.sku,
      name: draft.name,
      price: draft.price,
      isActive: true,
    };
    this.products.push(row);

    return Promise.resolve(toProduct(row));
  }

  public updateProduct(id: string, patch: ProductPatch): Promise<Product | null> {
    const row = this.locateProduct(id);

    if (row === undefined) {
      return Promise.resolve(null);
    }

    if (patch.name !== undefined) {
      row.name = patch.name;
    }
    if (patch.price !== undefined) {
      row.price = patch.price;
    }
    if (patch.isActive !== undefined) {
      row.isActive = patch.isActive;
    }

    return Promise.resolve(toProduct(row));
  }

  public appointmentExists(appointmentId: string): Promise<boolean> {
    const tenantId = requireTenant();

    return Promise.resolve(
      this.appointments.some(
        (candidate) => candidate.tenantId === tenantId && candidate.id === appointmentId,
      ),
    );
  }

  public createSale(draft: SaleDraft): Promise<Sale> {
    const tenantId = requireTenant();

    const row: StoredSale = {
      tenantId,
      id: randomUUID(),
      appointmentId: draft.appointmentId,
      cashierUserId: draft.cashierUserId,
      subtotal: { amountMinor: draft.subtotalAmountMinor, currency: draft.currency },
      tax: { amountMinor: draft.taxAmountMinor, currency: draft.currency },
      tip: { amountMinor: draft.tipAmountMinor, currency: draft.currency },
      total: { amountMinor: draft.totalAmountMinor, currency: draft.currency },
      items: draft.items.map((item): SaleItem => ({ id: randomUUID(), ...item })),
      createdAt: new Date(),
    };
    this.sales.push(row);

    return Promise.resolve(toSale(row));
  }

  public findSaleById(id: string): Promise<Sale | null> {
    const tenantId = requireTenant();
    const row = this.sales.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );

    return Promise.resolve(row === undefined ? null : toSale(row));
  }

  /**
   * L'historique, trié et paginé comme le vrai le fait — et **sans les lignes**.
   *
   * Les deux propriétés comptent. Le tri décroissant sur `createdAt` puis sur
   * l'identifiant reproduit l'`orderBy` du dépôt : sans le second critère, deux
   * tickets du même instant changeraient de page d'un appel à l'autre. Et
   * l'absence de lignes est ce que la projection du vrai garantit — un double
   * qui les rendrait quand même laisserait une suite s'appuyer sur une donnée
   * que la route n'a jamais servie.
   */
  public listSales(
    filter: SaleHistoryFilter,
  ): Promise<{ items: SaleSummary[]; totalItems: number }> {
    const tenantId = requireTenant();

    const matching = this.sales
      .filter((candidate) => candidate.tenantId === tenantId)
      .filter(
        (candidate) =>
          filter.cashierUserId === undefined || candidate.cashierUserId === filter.cashierUserId,
      )
      .filter(
        (candidate) =>
          filter.appointmentId === undefined || candidate.appointmentId === filter.appointmentId,
      )
      .filter((candidate) => filter.from === undefined || candidate.createdAt >= filter.from)
      // Borne haute **exclue**, comme le `lt` du vrai.
      .filter((candidate) => filter.to === undefined || candidate.createdAt < filter.to)
      .sort((left, right) => {
        const byInstant = right.createdAt.getTime() - left.createdAt.getTime();

        return byInstant === 0 ? right.id.localeCompare(left.id) : byInstant;
      });

    const skip = (filter.page - 1) * filter.pageSize;

    return Promise.resolve({
      items: matching.slice(skip, skip + filter.pageSize).map((row) => toSaleSummary(row)),
      totalItems: matching.length,
    });
  }

  /** La ligne mutable, bornée à l'établissement courant. */
  private locateProduct(id: string): StoredProduct | undefined {
    const tenantId = requireTenant();

    return this.products.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );
  }

  private currencyOf(tenantId: string): string {
    return this.tenants.find((candidate) => candidate.tenantId === tenantId)?.defaultCurrency ?? 'EUR';
  }
}

function toProduct(row: StoredProduct): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: { ...row.price },
    isActive: row.isActive,
  };
}

function toSaleSummary(row: StoredSale): SaleSummary {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    cashierUserId: row.cashierUserId,
    subtotal: { ...row.subtotal },
    tax: { ...row.tax },
    tip: { ...row.tip },
    total: { ...row.total },
    createdAt: row.createdAt,
  };
}

function toSale(row: StoredSale): Sale {
  return { ...toSaleSummary(row), items: row.items.map((item) => ({ ...item })) };
}

/**
 * Le catalogue des prestations, doublé **au niveau du service**.
 *
 * C'est `ServicesService.byId` que `SalesService` appelle — la voie conforme
 * d'api-module §3 —, et c'est donc sa frontière qu'il faut reproduire : une
 * prestation d'un autre établissement est *introuvable*, pas interdite. Le
 * double lève la même `NotFoundError` que le vrai, ce qui est exactement la
 * propriété que les suites de fuite exercent.
 */
type ServicesServicePort = Pick<ServicesService, 'byId'>;

export class FakeServicesService implements ServicesServicePort {
  private readonly services: (ServiceView & { tenantId: string })[] = [];

  public seedService(input: {
    tenantId: string;
    id?: string;
    name?: string;
    amountMinor?: number;
    currency?: string;
    isActive?: boolean;
  }): ServiceView & { tenantId: string } {
    const durationMinutes = 60;
    const row = {
      tenantId: input.tenantId,
      id: input.id ?? randomUUID(),
      slug: 'massage-60-min',
      name: input.name ?? 'Massage 60 min',
      description: null,
      category: null,
      durationMinutes,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      occupiedMinutes: durationMinutes,
      price: { amountMinor: input.amountMinor ?? 7000, currency: input.currency ?? 'EUR' },
      isActive: input.isActive ?? true,
    };
    this.services.push(row);
    return row;
  }

  public byId(id: string): Promise<ServiceView> {
    const tenantId = requireTenant();
    const row = this.services.find(
      (candidate) => candidate.tenantId === tenantId && candidate.id === id,
    );

    if (row === undefined) {
      // Le **même** refus que le vrai : 404, jamais 403, et sans rien qui
      // distingue « inconnue » de « chez le voisin » (tenant-isolation §4).
      return Promise.reject(new NotFoundError('Prestation introuvable.'));
    }

    return Promise.resolve(row);
  }
}
