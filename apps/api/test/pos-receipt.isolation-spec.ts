import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { NotFoundError } from '../src/common/errors';
import { runWithTenant } from '../src/common/tenant';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { toSaleReceiptDto } from '../src/modules/payments/dto/receipt.dto';
import { ReceiptRepository } from '../src/modules/payments/receipt.repository';
import { ReceiptService } from '../src/modules/payments/receipt.service';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Isolation inter-tenant du **ticket de caisse** — #818, obligatoire pour tout
 * endpoint nouveau (tenant-isolation §6).
 *
 * `GET /v1/sales/:id/receipt` sert la pièce la plus riche du module : identité
 * légale du salon, nom de la cliente, nom du praticien, montants, règlements et
 * avoirs. C'est aussi, pour cette raison, la lecture dont une fuite de portée
 * coûterait le plus — elle livrerait d'un seul appel l'état civil commercial
 * d'un concurrent et le nom de ses clientes.
 *
 * ## Pourquoi contre un vrai PostgreSQL, et non contre un double
 *
 * Parce que ce qui protège n'est pas le dépôt : c'est l'extension de scoping qui
 * pose le filtre `tenant_id` sur la lecture, et les clés étrangères composites
 * qui interdisent à un ticket de désigner le rendez-vous d'un autre salon. Un
 * double programmé pour bien se conduire ne peut rien en dire — c'est le même
 * régime que `pos.isolation-spec.ts`, et la même justification.
 *
 * Le protocole est celui de tenant-isolation §6 : créer chez A, se placer dans
 * la portée de B, lire par identifiant, attendre **404 — jamais 403** —, et
 * vérifier que la pièce de A est intacte.
 */

const EUR = 'EUR';
const TICKET_MINOR = 6500;

interface SeededReceipt {
  readonly tenantId: string;
  readonly saleId: string;
}

describe('Isolation inter-tenant — ticket de caisse', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle sème et **observe**, sans le filtre testé. */
  let prismaUnscoped: PrismaClient;
  let repository: ReceiptRepository;
  let service: ReceiptService;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      await prismaUnscoped.sale.count({ where: { receiptNumber: null } });
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    repository = new ReceiptRepository(createScopedPrismaClient(prismaUnscoped));
    service = new ReceiptService(repository);
  });

  afterAll(async () => {
    if (database === undefined) {
      return;
    }
    try {
      await prismaUnscoped.$disconnect();
    } finally {
      await database.drop();
    }
  });

  /**
   * Sème un établissement **complet** : identité légale, opérateur, et un ticket
   * clos, numéroté, réglé en espèces.
   *
   * Les deux salons portent délibérément le **même rang de pièce**, ce
   * qu'`@@unique([tenantId, receiptNumber])` autorise expressément : c'est
   * exactement là qu'une confusion de tenant se verrait.
   */
  const seed = async (label: string): Promise<SeededReceipt> => {
    const tenant = await prismaUnscoped.tenant.create({
      data: {
        slug: `i818-iso-${label}-${randomUUID()}`,
        name: `Salon ${label}`,
        legalName: `SALON ${label} SARL`,
        legalIdType: 'SIRET',
        legalId: '73282932000074',
        vatNumber: 'FR40303265045',
        receiptFooter: `Mentions du salon ${label}`,
        receiptPrefix: label === 'A' ? 'AAA' : 'BBB',
        timezone: 'Europe/Paris',
        defaultCurrency: EUR,
        taxRateBps: 2000,
      },
    });

    const cashier = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `caisse-${randomUUID()}@example.test`,
        role: 'STAFF',
        firstName: 'Camille',
        lastName: `Caisse${label}`,
        passwordHash: 'x'.repeat(60),
      },
    });

    const sale = await prismaUnscoped.sale.create({
      data: {
        tenantId: tenant.id,
        appointmentId: null,
        cashierUserId: cashier.id,
        subtotalAmountMinor: 5417,
        taxAmountMinor: 1083,
        taxRateBps: 2000,
        tipAmountMinor: 0,
        totalAmountMinor: TICKET_MINOR,
        settledAmountMinor: TICKET_MINOR,
        settledAt: new Date('2026-09-17T09:30:00.000Z'),
        // Le **même** rang des deux côtés : deux salons émettent chacun leur
        // pièce n° 1, et rien ne les confond.
        receiptNumber: 1,
        currency: EUR,
      },
      select: { id: true },
    });

    // `sale_items_reference_check` exige qu'une ligne `SERVICE` désigne une
    // prestation : la pièce nomme ce qui a été vendu, elle ne l'invente pas.
    const service = await prismaUnscoped.service.create({
      data: {
        tenantId: tenant.id,
        slug: `soin-${randomUUID().slice(0, 8)}`,
        name: `Soin ${label}`,
        durationMinutes: 45,
        priceAmountMinor: TICKET_MINOR,
        priceCurrency: EUR,
      },
      select: { id: true },
    });

    await prismaUnscoped.saleItem.create({
      data: {
        tenantId: tenant.id,
        saleId: sale.id,
        kind: 'SERVICE',
        serviceId: service.id,
        productId: null,
        label: `Soin ${label}`,
        quantity: 1,
        unitAmountMinor: TICKET_MINOR,
        lineAmountMinor: TICKET_MINOR,
        currency: EUR,
        position: 0,
      },
    });

    await prismaUnscoped.payment.create({
      data: {
        tenantId: tenant.id,
        saleId: sale.id,
        appointmentId: null,
        amountMinor: TICKET_MINOR,
        currency: EUR,
        method: 'CASH',
        status: 'SUCCEEDED',
        capturedAt: new Date('2026-09-17T09:30:00.000Z'),
        tenderedAmountMinor: 10_000,
      },
    });

    return { tenantId: tenant.id, saleId: sale.id };
  };

  let a: SeededReceipt;
  let b: SeededReceipt;

  beforeEach(async () => {
    a = await seed('A');
    b = await seed('B');
  });

  it('ne trouve pas la pièce du voisin — le dépôt rend `null`', async () => {
    expect(await runWithTenant(a.tenantId, () => repository.findReceiptBySaleId(b.saleId))).toBeNull();
    expect(
      await runWithTenant(b.tenantId, () => repository.findReceiptBySaleId(b.saleId)),
    ).not.toBeNull();
  });

  it('lève `NotFoundError` sur la pièce du voisin — 404, jamais 403', async () => {
    // Le refus doit être **indiscernable** de celui d'un identifiant inventé :
    // la différence servirait de sonde d'existence (tenant-isolation §4).
    await expect(
      runWithTenant(a.tenantId, () => service.bySaleId(b.saleId)),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      runWithTenant(a.tenantId, () => service.bySaleId(randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sert à chacun **sa** pièce, malgré un rang identique des deux côtés', async () => {
    const chezA = toSaleReceiptDto(await runWithTenant(a.tenantId, () => service.bySaleId(a.saleId)));
    const chezB = toSaleReceiptDto(await runWithTenant(b.tenantId, () => service.bySaleId(b.saleId)));

    expect(chezA.number).toBe('AAA-2026-000001');
    expect(chezB.number).toBe('BBB-2026-000001');
    expect(chezA.issuer.name).toBe('Salon A');
    expect(chezB.issuer.name).toBe('Salon B');
    expect(chezA.cashier.displayName).toBe('Camille CaisseA');
  });

  it('laisse la pièce du voisin intacte après un refus', async () => {
    await runWithTenant(a.tenantId, () => service.bySaleId(b.saleId)).catch(() => undefined);

    const untouched = await prismaUnscoped.sale.findUniqueOrThrow({
      where: { id: b.saleId },
      select: { receiptNumber: true, settledAmountMinor: true },
    });

    expect(untouched).toEqual({ receiptNumber: 1, settledAmountMinor: TICKET_MINOR });
  });

  it('n’expose ni `tenantId` ni aucun identifiant de personne dans la pièce servie', async () => {
    const dto = toSaleReceiptDto(await runWithTenant(a.tenantId, () => service.bySaleId(a.saleId)));
    const serialized = JSON.stringify(dto);

    expect(serialized).not.toContain(a.tenantId);
    expect(serialized).not.toContain('tenantId');
    expect(serialized).not.toContain('cashierUserId');
  });
});
