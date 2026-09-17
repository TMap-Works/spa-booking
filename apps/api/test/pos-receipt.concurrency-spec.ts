import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { runWithTenant } from '../src/common/tenant';
import {
  createScopedPrismaClient,
  type ScopedPrismaClient,
} from '../src/infrastructure/database/prisma-clients';
import { allocateReceiptNumber } from '../src/modules/payments/receipt.numbering';
import { SettlementRepository } from '../src/modules/payments/settlement.repository';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * La numérotation des tickets de caisse sous concurrence — contre un vrai
 * PostgreSQL (#818, premier critère).
 *
 * ## Ce qui ne se prouve qu'ici
 *
 * « La suite n'a **aucun trou**, même sous concurrence » est le critère qui
 * conditionne le reste du ticket, et aucun double en mémoire ne peut en dire
 * quoi que ce soit : l'invariant n'est pas tenu par du code applicatif — il ne
 * peut pas l'être — mais par deux mécanismes de la base, et il faut la base pour
 * les exercer.
 *
 * | Mécanisme | Ce qu'il tient | Le cas qui le montre |
 * |---|---|---|
 * | `SELECT … FOR UPDATE` sur `receipt_counters` | la **sérialisation** des clôtures | N clôtures simultanées rendent exactement 1…N |
 * | le compteur en **ligne**, non en séquence | le **retour arrière** d'un rang | une transaction annulée ne consomme rien |
 * | `sales_tenant_id_receipt_number_key` | le doublon **non représentable** | l'écriture forcée d'un rang déjà pris est refusée |
 *
 * Sans le premier, N transactions liraient toutes le même `next_value` : soit
 * elles écriraient le même rang — l'unique en refuserait N−1, et le comptoir
 * recevrait une panne —, soit, avec un `MAX(receipt_number) + 1`, elles
 * écriraient des rangs qui sautent.
 *
 * Sans le second — c'est-à-dire avec une `SEQUENCE` PostgreSQL —, le rang d'une
 * clôture annulée serait perdu pour toujours : c'est la propriété de conception
 * des séquences, et c'est exactement le trou que le critère interdit.
 *
 * ## Le service n'est pas monté, le dépôt l'est
 *
 * L'objet du test est la transaction. Le dépôt est donc exercé directement, avec
 * le client **scopé**, dans une portée de tenant — comme derrière le middleware.
 * Chaque cas sème son propre établissement : aucun ne dépend de ce que le
 * précédent a laissé en base.
 */

/**
 * Le nombre de clôtures lancées de front, aligné sur les autres suites de
 * concurrence : deux requêtes peuvent se sérialiser par hasard sur un pool de
 * connexions, et un test qui passe par chance ne prouve rien.
 */
const CONCURRENT_CLOSINGS = 8;

/** Le ticket du quatrième critère de #817 — 78,00 €. */
const TICKET_MINOR = 7800;

describe('Numérotation des pièces de caisse — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  let prisma: ScopedPrismaClient;
  let settlements: SettlementRepository;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Deux requêtes réelles sur ce que la migration vient de poser : c'est
      // elles qui prouvent que le schéma est en place, table de compteur
      // comprise.
      await prismaUnscoped.sale.count({ where: { receiptNumber: null } });
      await prismaUnscoped.receiptCounter.count();
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    prisma = createScopedPrismaClient(prismaUnscoped);
    settlements = new SettlementRepository(prisma);
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

  /** Sème un établissement et son opérateur de comptoir. */
  const seedTenant = async (
    overrides: { readonly receiptPrefix?: string } = {},
  ): Promise<{ readonly tenantId: string; readonly cashierUserId: string }> => {
    const tenant = await prismaUnscoped.tenant.create({
      data: {
        slug: `i818-${randomUUID()}`,
        name: 'Spa Lumière',
        timezone: 'Europe/Paris',
        defaultCurrency: 'EUR',
        ...(overrides.receiptPrefix === undefined
          ? {}
          : { receiptPrefix: overrides.receiptPrefix }),
      },
    });

    const cashier = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `caisse-${randomUUID()}@example.test`,
        role: 'STAFF',
        firstName: 'Camille',
        lastName: 'Roux',
        passwordHash: 'x'.repeat(60),
      },
    });

    return { tenantId: tenant.id, cashierUserId: cashier.id };
  };

  /** Ouvre un ticket du montant donné, **sans le régler**. */
  const openSale = async (
    tenantId: string,
    cashierUserId: string,
    totalAmountMinor = TICKET_MINOR,
  ): Promise<string> => {
    const sale = await prismaUnscoped.sale.create({
      data: {
        tenantId,
        appointmentId: null,
        cashierUserId,
        subtotalAmountMinor: totalAmountMinor,
        taxAmountMinor: 0,
        taxRateBps: 0,
        tipAmountMinor: 0,
        totalAmountMinor,
        currency: 'EUR',
      },
      select: { id: true },
    });

    return sale.id;
  };

  const counterOf = (tenantId: string) =>
    prismaUnscoped.receiptCounter.findUniqueOrThrow({
      where: { tenantId },
      select: { nextValue: true },
    });

  const numbersOf = async (tenantId: string): Promise<number[]> => {
    const rows = await prismaUnscoped.sale.findMany({
      where: { tenantId, receiptNumber: { not: null } },
      select: { receiptNumber: true },
      orderBy: { receiptNumber: 'asc' },
    });

    return rows.map((sale) => sale.receiptNumber ?? 0);
  };

  it('rend exactement 1…N sur N clôtures simultanées — aucun trou, aucun doublon', async () => {
    const { tenantId, cashierUserId } = await seedTenant();

    const saleIds = await Promise.all(
      Array.from({ length: CONCURRENT_CLOSINGS }, () => openSale(tenantId, cashierUserId)),
    );

    const outcomes = await Promise.all(
      saleIds.map((saleId) =>
        runWithTenant(tenantId, () => settlements.settleSale(saleId, { method: 'CASH' })),
      ),
    );

    // Les huit clôtures aboutissent : ce sont huit tickets distincts, et rien ne
    // les met en concurrence sur autre chose que le compteur.
    expect(outcomes.filter((outcome) => outcome.outcome === 'settled')).toHaveLength(
      CONCURRENT_CLOSINGS,
    );

    // **Le cœur du critère** : la suite est `1, 2, … N`. Sans le verrou, ce
    // tableau porterait des doublons — ou des trous, si la lecture avait été un
    // `MAX(receipt_number) + 1` suivi d'un refus de l'unique.
    expect(await numbersOf(tenantId)).toEqual(
      Array.from({ length: CONCURRENT_CLOSINGS }, (_, index) => index + 1),
    );

    // Et le compteur pointe le rang suivant, pas le dernier attribué.
    expect(await counterOf(tenantId)).toEqual({ nextValue: CONCURRENT_CLOSINGS + 1 });
  });

  it('ne consomme aucun rang quand la transaction de clôture est annulée', async () => {
    // Ce que ferait une `SEQUENCE` : `nextval()` ne revient pas en arrière, et le
    // rang pris par une transaction avortée serait perdu — un trou dans la
    // suite, définitif. Une **ligne** verrouillée, elle, est incrémentée dans la
    // transaction, donc annulée avec elle.
    const { tenantId, cashierUserId } = await seedTenant();

    // Une première clôture, pour que le compteur existe et porte un état qu'un
    // retour arrière puisse restituer.
    const first = await openSale(tenantId, cashierUserId);
    await runWithTenant(tenantId, () => settlements.settleSale(first, { method: 'CASH' }));
    expect(await counterOf(tenantId)).toEqual({ nextValue: 2 });

    const boom = new Error('la clôture échoue après avoir pris son rang');

    await expect(
      runWithTenant(tenantId, () =>
        prisma.$transaction(async (tx) => {
          // Le rang 2 est bel et bien pris…
          expect(await allocateReceiptNumber(tx)).toBe(2);
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);

    // … et il est **rendu**. Une séquence PostgreSQL aurait laissé le compteur
    // à 3, et le rang 2 serait manquant pour toujours.
    expect(await counterOf(tenantId)).toEqual({ nextValue: 2 });

    // La clôture suivante le reprend : la suite reste `1, 2`.
    const second = await openSale(tenantId, cashierUserId);
    await runWithTenant(tenantId, () => settlements.settleSale(second, { method: 'CASH' }));

    expect(await numbersOf(tenantId)).toEqual([1, 2]);
  });

  it('n’attribue aucun rang à un versement partiel — un ticket réglé en trois fois est une pièce', async () => {
    const { tenantId, cashierUserId } = await seedTenant();
    const saleId = await openSale(tenantId, cashierUserId);

    await runWithTenant(tenantId, () =>
      settlements.settleSale(saleId, { method: 'CASH', amountMinor: 5000 }),
    );

    // Le ticket n'est pas soldé : il n'y a pas encore de pièce, donc pas de rang.
    expect(await numbersOf(tenantId)).toEqual([]);
    expect(await counterOf(tenantId).catch(() => null)).toBeNull();

    await runWithTenant(tenantId, () =>
      settlements.settleSale(saleId, { method: 'CARD', amountMinor: 2800 }),
    );

    expect(await numbersOf(tenantId)).toEqual([1]);
    expect(await counterOf(tenantId)).toEqual({ nextValue: 2 });
  });

  it('inscrit le billet tendu, d’où se déduit la monnaie rendue', async () => {
    const { tenantId, cashierUserId } = await seedTenant();
    const saleId = await openSale(tenantId, cashierUserId);

    await runWithTenant(tenantId, () =>
      settlements.settleSale(saleId, { method: 'CASH', tenderedAmountMinor: 10_000 }),
    );

    const payment = await prismaUnscoped.payment.findFirstOrThrow({
      where: { saleId },
      select: { amountMinor: true, tenderedAmountMinor: true },
    });

    // L'excédent n'est pas encaissé : la ligne vaut le ticket, et le billet est
    // inscrit à côté pour que le reçu puisse dire ce qui a été rendu.
    expect(payment).toEqual({ amountMinor: TICKET_MINOR, tenderedAmountMinor: 10_000 });
  });

  it('refuse en base un rang déjà pris — la contrainte est le filet', async () => {
    // On force le doublon **sans passer par le dépôt**, pour prouver que
    // l'invariant ne dépend pas de `receipt.numbering.ts`. Si l'unique
    // disparaissait de la migration, ce cas verdirait — et c'est exactement ce
    // qu'il faut voir rougir.
    const { tenantId, cashierUserId } = await seedTenant();
    const first = await openSale(tenantId, cashierUserId);
    const second = await openSale(tenantId, cashierUserId);

    await prismaUnscoped.sale.update({ where: { id: first }, data: { receiptNumber: 1 } });

    await expect(
      prismaUnscoped.sale.update({ where: { id: second }, data: { receiptNumber: 1 } }),
      // Prisma nomme les colonnes plutôt que l'index : c'est bien
      // `sales_tenant_id_receipt_number_key` qui a refusé.
    ).rejects.toThrow(/tenant_id.*receipt_number/u);
  });

  it('refuse en base un rang nul ou négatif — `0` n’est pas une pièce', async () => {
    const { tenantId, cashierUserId } = await seedTenant();
    const saleId = await openSale(tenantId, cashierUserId);

    await expect(
      prismaUnscoped.sale.update({ where: { id: saleId }, data: { receiptNumber: 0 } }),
    ).rejects.toThrow(/sales_receipt_number_check/u);
  });

  it('refuse en base un second compteur pour le même établissement', async () => {
    // Deux compteurs seraient deux suites concurrentes sur la même colonne,
    // c'est-à-dire un trou garanti dès la deuxième clôture. La clé primaire de
    // `receipt_counters` porte `tenant_id`, et c'est elle qui l'interdit.
    const { tenantId, cashierUserId } = await seedTenant();
    const saleId = await openSale(tenantId, cashierUserId);

    await runWithTenant(tenantId, () => settlements.settleSale(saleId, { method: 'CASH' }));

    await expect(
      prismaUnscoped.receiptCounter.create({ data: { tenantId, nextValue: 99 } }),
    ).rejects.toThrow();
  });

  it('tient une suite par établissement — le voisin repart de 1', async () => {
    // `sales_tenant_id_receipt_number_key` porte `(tenant_id, receipt_number)`,
    // jamais `receipt_number` seul : deux salons ne se citent pas l'un l'autre,
    // et une unicité globale aurait fait dépendre la numérotation d'un salon du
    // volume de tous les autres (tenant-isolation §1).
    const mine = await seedTenant();
    const neighbour = await seedTenant();

    for (const tenant of [mine, mine, neighbour]) {
      const saleId = await openSale(tenant.tenantId, tenant.cashierUserId);
      await runWithTenant(tenant.tenantId, () =>
        settlements.settleSale(saleId, { method: 'CASH' }),
      );
    }

    expect(await numbersOf(mine.tenantId)).toEqual([1, 2]);
    expect(await numbersOf(neighbour.tenantId)).toEqual([1]);
  });

  it('n’atteint jamais le compteur du salon voisin — le SQL brut porte son propre filtre', async () => {
    // `$queryRaw` ne traverse pas l'extension de scoping (ADR 0006) :
    // `allocateReceiptNumber` écrit donc son prédicat d'établissement à la main,
    // et sa valeur vient du contexte de requête. Une portée ouverte sur A ne
    // peut pas faire avancer le compteur de B.
    const mine = await seedTenant();
    const neighbour = await seedTenant();

    const saleId = await openSale(neighbour.tenantId, neighbour.cashierUserId);
    await runWithTenant(neighbour.tenantId, () =>
      settlements.settleSale(saleId, { method: 'CASH' }),
    );

    const before = await counterOf(neighbour.tenantId);

    await runWithTenant(mine.tenantId, () => prisma.$transaction((tx) => allocateReceiptNumber(tx)));

    expect(await counterOf(neighbour.tenantId)).toEqual(before);
    expect(await counterOf(mine.tenantId)).toEqual({ nextValue: 2 });
  });
});
