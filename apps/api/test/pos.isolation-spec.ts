import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { runWithTenant } from '../src/common/tenant';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { PosRepository } from '../src/modules/payments/pos.repository';
import { composeSale } from '../src/modules/payments/pos.totals';
import type { PricedCatalogItem, SaleDraft } from '../src/modules/payments/pos.types';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Le dépôt du POS **contre un vrai PostgreSQL** — #60.
 *
 * `pos.integration-spec.ts` et `pos-tenant.isolation-spec.ts` substituent tous
 * deux `PosRepository` par son double en mémoire : ils prouvent les routes, les
 * gardes, la validation et la composition du ticket, mais **aucune ligne de SQL
 * n'y est exécutée**. Or ce que #60 pose de plus risqué vit précisément dans la
 * base, et un double programmé pour bien se conduire ne peut rien en dire :
 *
 * 1. **la transaction** de `createSale` — un en-tête écrit sans ses lignes est
 *    une pièce comptable fausse que rien ne signalerait ;
 * 2. **le scoping par l'extension Prisma** sur `Product`, `Sale` et `SaleItem` :
 *    c'est elle, et non le dépôt, qui pose et filtre `tenant_id` ;
 * 3. **les `CHECK`** que la migration ajoute — `sales_total_amount_minor_check`,
 *    `sale_items_line_amount_minor_check`, `sale_items_reference_check` : ce que
 *    `composeSale` calcule doit les satisfaire, sans quoi la première vente
 *    réelle sortirait en 500 ;
 * 4. **les clés étrangères composites** `(tenant_id, …)`, qui interdisent de
 *    facturer sur le ticket d'un salon l'article d'un autre — la seule barrière
 *    qui subsiste si le scoping applicatif venait à céder.
 *
 * C'est le même régime, et la même justification, que
 * `payments-webhook.isolation-spec.ts` pour l'idempotence des webhooks.
 */

const EUR = 'EUR';
const TAX_RATE_BPS = 2000;

/** Ce qu'un établissement de cette suite porte. */
interface SeededTenant {
  readonly id: string;
  readonly cashierUserId: string;
  readonly serviceId: string;
  readonly appointmentId: string;
  readonly productId: string;
}

function catalogLine(overrides: Partial<PricedCatalogItem>): PricedCatalogItem {
  return {
    kind: 'PRODUCT',
    referenceId: randomUUID(),
    label: 'Shampoing hydratant 250 ml',
    unitPrice: { amountMinor: 1850, currency: EUR },
    quantity: 1,
    ...overrides,
  };
}

describe('POS — le dépôt contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /**
   * La racine non scopée : elle sème les établissements — qui n'ont par
   * définition aucun tenant courant — et **observe** la base sans le filtre dont
   * on teste justement l'effet.
   */
  let prismaUnscoped: PrismaClient;
  let repository: PosRepository;

  let a: SeededTenant;
  let b: SeededTenant;

  async function seedTenant(label: string): Promise<SeededTenant> {
    const tenant = await prismaUnscoped.tenant.create({
      data: {
        slug: `pos60-${label}-${randomUUID()}`,
        name: `Établissement ${label}`,
        timezone: 'Europe/Paris',
        defaultCurrency: EUR,
        taxRateBps: TAX_RATE_BPS,
      },
    });

    const cashier = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `caisse-${randomUUID()}@example.test`,
        role: 'STAFF',
        firstName: 'Alix',
        lastName: 'Martin',
      },
    });

    const client = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `cliente-${randomUUID()}@example.test`,
        role: 'CLIENT',
        firstName: 'Camille',
        lastName: 'Durand',
      },
    });

    const staff = await prismaUnscoped.staff.create({
      data: { tenantId: tenant.id, userId: cashier.id, displayName: 'Alix' },
    });

    const service = await prismaUnscoped.service.create({
      data: {
        tenantId: tenant.id,
        slug: `massage-${randomUUID().slice(0, 8)}`,
        name: 'Massage 60 min',
        durationMinutes: 60,
        priceAmountMinor: 7000,
        priceCurrency: EUR,
      },
    });

    const appointment = await prismaUnscoped.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: client.id,
        staffId: staff.id,
        serviceId: service.id,
        startsAt: new Date('2026-10-01T09:00:00Z'),
        endsAt: new Date('2026-10-01T10:00:00Z'),
        priceAmountMinor: 7000,
        priceCurrency: EUR,
      },
    });

    const product = await prismaUnscoped.product.create({
      data: {
        tenantId: tenant.id,
        sku: 'SH-01',
        name: 'Shampoing hydratant 250 ml',
        priceAmountMinor: 1850,
        priceCurrency: EUR,
      },
    });

    return {
      id: tenant.id,
      cashierUserId: cashier.id,
      serviceId: service.id,
      appointmentId: appointment.id,
      productId: product.id,
    };
  }

  /** Le ticket que le service composerait, prêt pour le dépôt. */
  function draftFor(tenant: SeededTenant, tipAmountMinor = 0): SaleDraft {
    const composed = composeSale({
      currency: EUR,
      taxRateBps: TAX_RATE_BPS,
      items: [
        catalogLine({
          kind: 'SERVICE',
          referenceId: tenant.serviceId,
          label: 'Massage 60 min',
          unitPrice: { amountMinor: 7000, currency: EUR },
        }),
        catalogLine({ referenceId: tenant.productId, quantity: 2 }),
      ],
      tipAmountMinor,
    });

    return { ...composed, appointmentId: tenant.appointmentId, cashierUserId: tenant.cashierUserId };
  }

  beforeAll(async () => {
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });
    await prismaUnscoped.$connect();
    // Une requête réelle : elle prouve que le schéma est en place, et que la
    // migration du POS s'est bien appliquée.
    await prismaUnscoped.product.count();

    // Le client scopé est construit **par la fabrique de l'application** : c'est
    // l'extension que `DatabaseModule` applique réellement qui est exercée.
    repository = new PosRepository(createScopedPrismaClient(prismaUnscoped));

    a = await seedTenant('a');
    b = await seedTenant('b');
  }, 120_000);

  afterAll(async () => {
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  describe('le paramétrage lu sur `tenants`', () => {
    it('rend la devise et le taux de l’établissement courant, jamais ceux du voisin', async () => {
      await prismaUnscoped.tenant.update({
        where: { id: b.id },
        data: { defaultCurrency: 'MGA', taxRateBps: 0 },
      });

      const chezA = await runWithTenant(a.id, () => repository.tenantSaleSettings());
      const chezB = await runWithTenant(b.id, () => repository.tenantSaleSettings());

      expect(chezA).toEqual({ defaultCurrency: EUR, taxRateBps: TAX_RATE_BPS });
      expect(chezB).toEqual({ defaultCurrency: 'MGA', taxRateBps: 0 });

      await prismaUnscoped.tenant.update({
        where: { id: b.id },
        data: { defaultCurrency: EUR, taxRateBps: TAX_RATE_BPS },
      });
    });
  });

  describe('le rayon', () => {
    it('laisse le même code libre chez le voisin — l’unicité est par tenant', async () => {
      // `SH-01` est déjà semé des deux côtés : la contrainte est bien
      // `@@unique([tenantId, sku])`, et non une unicité globale.
      const chezA = await runWithTenant(a.id, () =>
        repository.createProduct({
          sku: 'SH-01',
          name: 'Doublon',
          price: { amountMinor: 100, currency: EUR },
        }),
      );

      expect(chezA).toBeNull();

      const libre = await runWithTenant(a.id, () =>
        repository.createProduct({
          sku: `SH-${randomUUID().slice(0, 8)}`,
          name: 'Après-shampoing',
          price: { amountMinor: 1500, currency: EUR },
        }),
      );

      expect(libre).not.toBeNull();
    });

    it('ne rend au listing que le rayon de l’appelant', async () => {
      const chezA = await runWithTenant(a.id, () =>
        repository.listProducts({ includeInactive: true }),
      );

      expect(chezA.map((product) => product.id)).toContain(a.productId);
      expect(chezA.map((product) => product.id)).not.toContain(b.productId);
    });

    it('ne trouve pas l’article du voisin, et ne le modifie pas', async () => {
      expect(await runWithTenant(a.id, () => repository.findProductById(b.productId))).toBeNull();
      expect(
        await runWithTenant(a.id, () => repository.updateProduct(b.productId, { name: 'Détourné' })),
      ).toBeNull();

      const intact = await prismaUnscoped.product.findUniqueOrThrow({ where: { id: b.productId } });
      expect(intact.name).toBe('Shampoing hydratant 250 ml');
    });

    it('ne trouve pas le rendez-vous du voisin', async () => {
      expect(await runWithTenant(a.id, () => repository.appointmentExists(a.appointmentId))).toBe(
        true,
      );
      expect(await runWithTenant(a.id, () => repository.appointmentExists(b.appointmentId))).toBe(
        false,
      );
    });
  });

  describe('l’écriture d’un ticket', () => {
    it('inscrit l’en-tête et ses lignes en une seule transaction, dans le tenant courant', async () => {
      const draft = draftFor(a, 500);

      const sale = await runWithTenant(a.id, () => repository.createSale(draft));

      expect(sale.total.amountMinor).toBe(
        sale.subtotal.amountMinor + sale.tax.amountMinor + sale.tip.amountMinor,
      );
      expect(sale.items.map((item) => item.kind)).toEqual(['SERVICE', 'PRODUCT', 'TAX', 'TIP']);
      expect(sale.items.map((item) => item.position)).toEqual([0, 1, 2, 3]);

      const written = await prismaUnscoped.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
      // Le tenant vient du contexte, jamais du `data` : le dépôt n'en fournit
      // aucun.
      expect(written.tenantId).toBe(a.id);
      expect(written.items).toHaveLength(4);
      for (const item of written.items) {
        expect(item.tenantId).toBe(a.id);
      }
    });

    it('satisfait les `CHECK` de la base — le calcul et la contrainte disent la même chose', async () => {
      const sale = await runWithTenant(a.id, () => repository.createSale(draftFor(a, 777)));

      const row = await prismaUnscoped.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: { orderBy: { position: 'asc' } } },
      });

      expect(row.totalAmountMinor).toBe(
        row.subtotalAmountMinor + row.taxAmountMinor + row.tipAmountMinor,
      );
      for (const item of row.items) {
        expect(item.lineAmountMinor).toBe(item.unitAmountMinor * item.quantity);
        // `sale_items_reference_check` : une ligne porte exactement la référence
        // de sa nature.
        if (item.kind === 'SERVICE') {
          expect([item.serviceId, item.productId]).toEqual([a.serviceId, null]);
        } else if (item.kind === 'PRODUCT') {
          expect([item.serviceId, item.productId]).toEqual([null, a.productId]);
        } else {
          expect([item.serviceId, item.productId]).toEqual([null, null]);
        }
      }
    });

    it('ne laisse aucun en-tête derrière elle quand les lignes sont refusées', async () => {
      // Une ligne dont le montant ne vaut pas `unit × quantity` viole
      // `sale_items_line_amount_minor_check`. L'en-tête est écrit avant les
      // lignes : sans la transaction, il resterait en base — un total sans rien
      // pour le justifier.
      const draft = draftFor(a);
      const before = await prismaUnscoped.sale.count({ where: { tenantId: a.id } });

      const corrompu: SaleDraft = {
        ...draft,
        items: draft.items.map((item, index) =>
          index === 0 ? { ...item, lineAmount: { ...item.lineAmount, amountMinor: 1 } } : item,
        ),
      };

      await expect(runWithTenant(a.id, () => repository.createSale(corrompu))).rejects.toThrow();
      expect(await prismaUnscoped.sale.count({ where: { tenantId: a.id } })).toBe(before);
    });

    it('ne trouve pas le ticket du voisin', async () => {
      const chezB = await runWithTenant(b.id, () => repository.createSale(draftFor(b)));

      expect(await runWithTenant(a.id, () => repository.findSaleById(chezB.id))).toBeNull();
      expect(await runWithTenant(b.id, () => repository.findSaleById(chezB.id))).not.toBeNull();
    });
  });

  describe('les clés étrangères composites — la frontière tenue par la base', () => {
    it('refuse une ligne qui facturerait l’article du voisin, même écrite hors scoping', async () => {
      // Le dernier rempart : si le scoping applicatif cédait, c'est la clé
      // `(tenant_id, product_id) → products(tenant_id, id)` qui refuserait.
      const sale = await runWithTenant(a.id, () => repository.createSale(draftFor(a)));

      await expect(
        prismaUnscoped.saleItem.create({
          data: {
            tenantId: a.id,
            saleId: sale.id,
            kind: 'PRODUCT',
            productId: b.productId,
            label: 'Article du voisin',
            quantity: 1,
            unitAmountMinor: 100,
            lineAmountMinor: 100,
            currency: EUR,
            position: 99,
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('refuse un ticket dont l’opérateur appartient à un autre établissement', async () => {
      await expect(
        prismaUnscoped.sale.create({
          data: {
            tenantId: a.id,
            cashierUserId: b.cashierUserId,
            subtotalAmountMinor: 1000,
            taxAmountMinor: 0,
            tipAmountMinor: 0,
            totalAmountMinor: 1000,
            currency: EUR,
          },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });
});
