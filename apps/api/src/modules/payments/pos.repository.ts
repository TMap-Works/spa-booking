import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PRISMA, type ScopedPrismaClient } from '../../infrastructure/database/prisma-clients';
import { createdAtWithin } from './history';
import { isUniqueViolation } from './payments.repository';
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
} from './pos.types';

/**
 * Le seul point du POS qui connaît le schéma (api-module §2).
 *
 * Il injecte le client **scopé** : l'extension pose `tenant_id` sur chaque
 * écriture et l'ajoute au `where` de chaque lecture, sans qu'une requête d'ici
 * ait à le répéter — donc sans qu'aucune puisse l'oublier. Rien du POS n'est
 * légitimement inter-tenant, et `prismaUnscoped` n'y est donc pas injecté du
 * tout.
 *
 * C'est ce scoping, et lui seul, qui fait qu'un article ou un ticket du salon
 * voisin est *introuvable* plutôt qu'interdit : la lecture rend `null`, le
 * service lève `NotFoundError`, la route répond 404 — jamais 403, qui
 * confirmerait l'existence de la ressource (tenant-isolation §4).
 *
 * ## Pourquoi il lit `tenants` et `appointments`
 *
 * `tenants` pour deux valeurs — la devise de l'établissement et son taux de
 * taxe — dont dépend la composition du ticket. La lecture est bornée à ces deux
 * colonnes, et le client scopé la restreint d'office à l'établissement courant :
 * l'extension scope `Tenant` sur son `id`, si bien qu'il n'y a aucun moyen
 * d'atteindre la ligne d'un autre salon par cette porte.
 *
 * `appointments` pour une seule question — « ce rendez-vous existe-t-il ici ? »
 * — et la réponse est un booléen. C'est la même dette assumée que celle de
 * `payments.repository.ts` vis-à-vis d'api-module §3, et pour la même raison :
 * `AppointmentsService` n'expose aujourd'hui aucune lecture par identifiant.
 * Aucune colonne personnelle n'est lue, aucune écriture n'est faite. Une issue
 * de suivi porte la dette.
 *
 * Les **prestations**, elles, ne sont pas lues ici : `SalesService` passe par
 * `ServicesService.byId`, la voie conforme d'api-module §3. C'est possible parce
 * que `catalog` expose ce service, et c'est fait parce qu'un prix de prestation
 * lu à deux endroits finit par être lu de deux façons.
 */

/** Ce que le POS lit d'un article — jamais la ligne entière. */
const PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  priceAmountMinor: true,
  priceCurrency: true,
  isActive: true,
} as const;

const SALE_ITEM_SELECT = {
  id: true,
  kind: true,
  serviceId: true,
  productId: true,
  label: true,
  quantity: true,
  unitAmountMinor: true,
  lineAmountMinor: true,
  currency: true,
  position: true,
} as const;

/**
 * L'en-tête d'un ticket, **sans ses lignes** — ce que l'historique lit (#62).
 *
 * Une page de cinquante tickets de dix lignes en aurait chargé cinq cents pour
 * n'en afficher aucune. Le détail se demande par `GET /sales/:id`, qui existe
 * pour cela.
 */
const SALE_SUMMARY_SELECT = {
  id: true,
  appointmentId: true,
  cashierUserId: true,
  subtotalAmountMinor: true,
  taxAmountMinor: true,
  tipAmountMinor: true,
  totalAmountMinor: true,
  currency: true,
  createdAt: true,
} as const;

const SALE_SELECT = {
  ...SALE_SUMMARY_SELECT,
  items: { select: SALE_ITEM_SELECT, orderBy: { position: 'asc' } },
} as const;

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  priceAmountMinor: number;
  priceCurrency: string;
  isActive: boolean;
}

interface SaleItemRow {
  id: string;
  kind: string;
  serviceId: string | null;
  productId: string | null;
  label: string;
  quantity: number;
  unitAmountMinor: number;
  lineAmountMinor: number;
  currency: string;
  position: number;
}

interface SaleSummaryRow {
  id: string;
  appointmentId: string | null;
  cashierUserId: string;
  subtotalAmountMinor: number;
  taxAmountMinor: number;
  tipAmountMinor: number;
  totalAmountMinor: number;
  currency: string;
  createdAt: Date;
}

interface SaleRow extends SaleSummaryRow {
  items: SaleItemRow[];
}

/**
 * Charge utile de création **sans** le tenant, tel que le dépôt l'écrit.
 *
 * Même conversion, et pour la même raison, que dans `payments.repository.ts` :
 * le type généré exige `tenantId` — la colonne est `NOT NULL` — alors que le
 * dépôt ne doit justement pas le fournir. C'est l'extension qui le pose depuis
 * le contexte de requête, et qui **écrase** ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: { amountMinor: row.priceAmountMinor, currency: row.priceCurrency },
    isActive: row.isActive,
  };
}

function toSaleItem(row: SaleItemRow): SaleItem {
  return {
    id: row.id,
    // L'énumération du schéma est reprise telle quelle : le témoin de
    // `pos.types.spec.ts` garantit que les libellés coïncident.
    kind: row.kind as SaleItem['kind'],
    serviceId: row.serviceId,
    productId: row.productId,
    label: row.label,
    quantity: row.quantity,
    unitAmount: { amountMinor: row.unitAmountMinor, currency: row.currency },
    lineAmount: { amountMinor: row.lineAmountMinor, currency: row.currency },
    position: row.position,
  };
}

function toSaleSummary(row: SaleSummaryRow): SaleSummary {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    cashierUserId: row.cashierUserId,
    subtotal: { amountMinor: row.subtotalAmountMinor, currency: row.currency },
    tax: { amountMinor: row.taxAmountMinor, currency: row.currency },
    tip: { amountMinor: row.tipAmountMinor, currency: row.currency },
    total: { amountMinor: row.totalAmountMinor, currency: row.currency },
    createdAt: row.createdAt,
  };
}

function toSale(row: SaleRow): Sale {
  return { ...toSaleSummary(row), items: row.items.map((item) => toSaleItem(item)) };
}

/**
 * Le `where` de l'historique des ventes — **sans `tenantId`**, que l'extension
 * ajoute.
 *
 * La fenêtre vient de `createdAtWithin` — la **même fonction** que
 * `transactionWhere` de `payments.repository.ts`, et non une copie qu'il
 * faudrait tenir en regard : la borne haute y est exclue, ce qui permet de poser
 * deux journées de caisse bout à bout sans compter deux fois le ticket de
 * minuit, et les deux historiques du même ticket ne peuvent pas avoir deux idées
 * d'un jour de caisse.
 */
function saleWhere(filter: SaleHistoryFilter): Prisma.SaleWhereInput {
  const createdAt = createdAtWithin(filter);

  return {
    ...(filter.cashierUserId === undefined ? {} : { cashierUserId: filter.cashierUserId }),
    ...(filter.appointmentId === undefined ? {} : { appointmentId: filter.appointmentId }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

@Injectable()
export class PosRepository {
  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}

  /**
   * La devise et le taux de taxe de l'établissement courant.
   *
   * `findFirst` et non `findUnique` : l'extension scope `Tenant` sur son `id`,
   * et `findUnique` exige que le `where` désigne exactement une clé unique
   * déclarée. Même raison que dans `catalog.repository.ts`.
   *
   * Rend `null` si aucune ligne n'est visible — ce qui, portée ouverte, ne
   * devrait pas arriver, mais se signale plutôt que de se deviner.
   */
  public async tenantSaleSettings(): Promise<TenantSaleSettings | null> {
    const row = await this.prisma.tenant.findFirst({
      select: { defaultCurrency: true, taxRateBps: true },
    });

    return row === null ? null : { defaultCurrency: row.defaultCurrency, taxRateBps: row.taxRateBps };
  }

  /** Le rayon de l'établissement courant, trié pour l'écran de caisse. */
  public async listProducts(options: { includeInactive: boolean }): Promise<Product[]> {
    const rows = await this.prisma.product.findMany({
      where: options.includeInactive ? {} : { isActive: true },
      select: PRODUCT_SELECT,
      orderBy: [{ name: 'asc' }],
    });

    return rows.map((row) => toProduct(row));
  }

  /** Un article de l'établissement courant, ou `null`. */
  public async findProductById(id: string): Promise<Product | null> {
    const row = await this.prisma.product.findFirst({ where: { id }, select: PRODUCT_SELECT });

    return row === null ? null : toProduct(row);
  }

  /**
   * Inscrit un article.
   *
   * Rend `null` — et non une erreur — quand le code est déjà pris : c'est
   * `@@unique([tenantId, sku])` qui tranche, jamais une vérification applicative
   * qui laisserait passer deux requêtes concurrentes.
   */
  public async createProduct(draft: ProductDraft): Promise<Product | null> {
    try {
      const row = await this.prisma.product.create({
        data: withScopedTenant<Prisma.ProductUncheckedCreateInput>({
          sku: draft.sku,
          name: draft.name,
          priceAmountMinor: draft.price.amountMinor,
          priceCurrency: draft.price.currency,
        }),
        select: PRODUCT_SELECT,
      });

      return toProduct(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Modifie un article de l'établissement courant.
   *
   * `updateMany` et non `update` : `update` exige une clé unique déclarée dans
   * son `where`, où l'extension ne peut pas ajouter `tenantId`. Un compte de
   * zéro se lit « aucune ligne visible ici », ce que le service traduit en 404.
   */
  public async updateProduct(id: string, patch: ProductPatch): Promise<Product | null> {
    const result = await this.prisma.product.updateMany({
      where: { id },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.price === undefined
          ? {}
          : {
              priceAmountMinor: patch.price.amountMinor,
              priceCurrency: patch.price.currency,
            }),
        ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
      },
    });

    return result.count === 0 ? null : this.findProductById(id);
  }

  /**
   * `true` si ce rendez-vous appartient à l'établissement courant.
   *
   * Un booléen, et pas la ligne : le POS n'a besoin de savoir que cela, et ce
   * qu'on ne lit pas ne peut pas fuiter. Aucune colonne personnelle n'est
   * touchée — `select: { id: true }` et rien d'autre.
   */
  public async appointmentExists(appointmentId: string): Promise<boolean> {
    const row = await this.prisma.appointment.findFirst({
      where: { id: appointmentId },
      select: { id: true },
    });

    return row !== null;
  }

  /**
   * Écrit le ticket et ses lignes **dans une seule transaction**.
   *
   * L'atomicité n'est pas une élégance : un ticket dont les lignes auraient
   * échoué après l'en-tête laisserait en base un total sans rien pour le
   * justifier, c'est-à-dire une pièce comptable fausse que rien ne signalerait.
   *
   * Les lignes sont insérées par `createMany` en une instruction — cent lignes
   * ne font pas cent allers-retours —, puis le ticket est relu par la même
   * transaction pour rendre les identifiants que la base vient d'attribuer.
   */
  public async createSale(draft: SaleDraft): Promise<Sale> {
    return this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: withScopedTenant<Prisma.SaleUncheckedCreateInput>({
          appointmentId: draft.appointmentId,
          cashierUserId: draft.cashierUserId,
          subtotalAmountMinor: draft.subtotalAmountMinor,
          taxAmountMinor: draft.taxAmountMinor,
          tipAmountMinor: draft.tipAmountMinor,
          totalAmountMinor: draft.totalAmountMinor,
          currency: draft.currency,
        }),
        select: { id: true },
      });

      await tx.saleItem.createMany({
        data: draft.items.map((item) =>
          withScopedTenant<Prisma.SaleItemUncheckedCreateInput>({
            saleId: sale.id,
            kind: item.kind,
            serviceId: item.serviceId,
            productId: item.productId,
            label: item.label,
            quantity: item.quantity,
            unitAmountMinor: item.unitAmount.amountMinor,
            lineAmountMinor: item.lineAmount.amountMinor,
            currency: item.lineAmount.currency,
            position: item.position,
          }),
        ),
      });

      const written = await tx.sale.findFirst({ where: { id: sale.id }, select: SALE_SELECT });

      if (written === null) {
        // Inatteignable : la ligne vient d'être écrite par cette transaction.
        // Se signaler bruyamment vaut mieux que rendre un ticket fabriqué.
        throw new Error('Le ticket vient d’être écrit et reste introuvable dans sa transaction.');
      }

      return toSale(written);
    });
  }

  /** Un ticket de l'établissement courant, lignes comprises, ou `null`. */
  public async findSaleById(id: string): Promise<Sale | null> {
    const row = await this.prisma.sale.findFirst({ where: { id }, select: SALE_SELECT });

    return row === null ? null : toSale(row);
  }

  /**
   * Une page de l'historique des ventes de l'établissement courant (#62).
   *
   * `@@index([tenantId, createdAt])` a été posé pour cette lecture dès #60 — le
   * commentaire du schéma le dit en toutes lettres, « l'historique des ventes,
   * du plus récent au plus ancien (#62) ». Le tri décroissant dans un
   * établissement tombe donc sur un B-tree, et le filtre par opérateur, qui n'a
   * pas d'index dédié, s'applique à l'intérieur de cet ensemble et non de la
   * table.
   *
   * La page et son total sont lus dans la même transaction, **en lecture
   * répétable** — même raison que dans `listTransactions` et dans
   * `crm.repository.ts` : une vente concurrente entre les deux requêtes donnerait
   * un `totalItems` qui ne correspond à aucune des pages rendues. L'identifiant
   * départage deux tickets du même instant, sans quoi l'un peut changer de page
   * d'un appel à l'autre.
   */
  public async listSales(
    filter: SaleHistoryFilter,
  ): Promise<{ items: SaleSummary[]; totalItems: number }> {
    const where = saleWhere(filter);

    const [rows, totalItems] = await this.prisma.$transaction(
      [
        this.prisma.sale.findMany({
          where,
          select: SALE_SUMMARY_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (filter.page - 1) * filter.pageSize,
          take: filter.pageSize,
        }),
        this.prisma.sale.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { items: rows.map((row) => toSaleSummary(row)), totalItems };
  }
}
