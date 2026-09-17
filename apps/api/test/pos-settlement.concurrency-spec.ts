import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

import { runWithTenant } from '../src/common/tenant';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import {
  SaleAlreadySettledError,
  SaleOverpaymentError,
} from '../src/modules/payments/payments.errors';
import type { SaleDraft } from '../src/modules/payments/pos.types';
import { SettlementRepository } from '../src/modules/payments/settlement.repository';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Règlements concurrents d'un même ticket — contre un vrai PostgreSQL (#817,
 * neuvième critère).
 *
 * ## Ce qui ne se prouve qu'ici
 *
 * `settlement.rules.spec.ts` exerce l'arithmétique du règlement centime par
 * centime, et elle ne dit rien de ce qui compte le plus : que **deux règlements
 * simultanés de la même vente n'en fassent qu'un**. Cet invariant-là n'est pas
 * tenu par du code applicatif — il ne peut pas l'être — mais par deux
 * mécanismes de la base, et il faut la base pour les exercer :
 *
 * - `sales_settled_amount_minor_check`, qui rend l'écriture de trop
 *   **impossible**. Un double en mémoire l'ignorerait, et ferait passer pour
 *   sûr un service qui ne l'est pas ;
 * - le `SELECT … FOR UPDATE` sur la ligne `sales`, qui sérialise les
 *   concurrents. Sans lui, huit transactions liraient toutes « rien
 *   d'encaissé » et inscriraient huit encaissements — c'est exactement le
 *   double encaissement que CLAUDE.md range au même rang que la double
 *   réservation.
 *
 * C'est aussi ici que se vérifie que la migration a bien posé `payments.sale_id`
 * et les deux colonnes de solde : une suite qui monterait un double n'aurait
 * rien à dire du schéma.
 *
 * ## Le service n'est pas monté, le dépôt l'est
 *
 * L'objet du test est la transaction, pas la traduction HTTP des refus. Le
 * dépôt est donc exercé directement, avec le client **scopé**, dans une portée
 * de tenant — comme derrière le middleware. Les refus qu'il rend
 * (`already-settled`, `overpayment`) sont ceux que `SettlementService` traduit
 * en 409 et 422 ; les deux classes d'erreur sont importées pour que le lien
 * soit visible et qu'un renommage casse ici aussi.
 *
 * Chaque cas sème son propre établissement : aucun ne dépend de ce que le
 * précédent a laissé en base.
 */

/**
 * Le nombre de règlements lancés de front, aligné sur les autres suites de
 * concurrence : deux requêtes peuvent se sérialiser par hasard sur un pool de
 * connexions, et un test qui passe par chance ne prouve rien.
 */
const CONCURRENT_ATTEMPTS = 8;

/** Le ticket du quatrième critère — 78,00 €. */
const TICKET_MINOR = 7800;

interface SeededSale {
  readonly tenantId: string;
  readonly saleId: string;
  readonly cashierUserId: string;
}

describe('Règlements concurrents d’un ticket — contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /** La racine non scopée : elle **observe** la base, sans le filtre du tenant. */
  let prismaUnscoped: PrismaClient;
  let settlements: SettlementRepository;

  beforeAll(async () => {
    database = await createDisposableDatabase();
    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });

    try {
      await prismaUnscoped.$connect();
      // Une requête réelle sur les colonnes que la migration vient de poser :
      // c'est elle qui prouve que le schéma est en place.
      await prismaUnscoped.sale.count({ where: { settledAt: null } });
      await prismaUnscoped.payment.count({ where: { saleId: null } });
    } catch (error: unknown) {
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      database = undefined;
      throw error;
    }

    settlements = new SettlementRepository(createScopedPrismaClient(prismaUnscoped));
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

  /** Sème un établissement, un opérateur et un ticket ouvert du montant donné. */
  const seedSale = async (totalAmountMinor = TICKET_MINOR): Promise<SeededSale> => {
    const tenant = await prismaUnscoped.tenant.create({
      data: {
        slug: `i817-${randomUUID()}`,
        name: 'Spa Lumière',
        timezone: 'Europe/Paris',
        defaultCurrency: 'EUR',
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

    const sale = await prismaUnscoped.sale.create({
      data: {
        tenantId: tenant.id,
        appointmentId: null,
        cashierUserId: cashier.id,
        subtotalAmountMinor: totalAmountMinor,
        taxAmountMinor: 0,
        tipAmountMinor: 0,
        totalAmountMinor,
        currency: 'EUR',
      },
      select: { id: true },
    });

    return { tenantId: tenant.id, saleId: sale.id, cashierUserId: cashier.id };
  };

  /** L'état du ticket en base, tel qu'un observateur non scopé le voit. */
  const readSale = (saleId: string) =>
    prismaUnscoped.sale.findUniqueOrThrow({
      where: { id: saleId },
      select: { settledAmountMinor: true, totalAmountMinor: true, settledAt: true },
    });

  const paymentsOf = (saleId: string) =>
    prismaUnscoped.payment.findMany({
      where: { saleId },
      select: { amountMinor: true, method: true, status: true, appointmentId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  it('un seul règlement aboutit sur N tentatives simultanées du même ticket', async () => {
    const { tenantId, saleId } = await seedSale();

    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        runWithTenant(tenantId, () => settlements.settleSale(saleId, { method: 'CASH' })),
      ),
    );

    const settled = outcomes.filter((outcome) => outcome.outcome === 'settled');
    const refused = outcomes.filter((outcome) => outcome.outcome === 'already-settled');

    // Un gagnant, et sept refus **propres** : aucun `40001`, aucune exception
    // remontée — le comptoir doit recevoir un 409, pas une panne.
    expect({ settled: settled.length, refused: refused.length }).toEqual({
      settled: 1,
      refused: CONCURRENT_ATTEMPTS - 1,
    });

    // Et la base le confirme : **un** encaissement, du montant du ticket.
    const written = await paymentsOf(saleId);
    expect(written).toEqual([
      { amountMinor: TICKET_MINOR, method: 'CASH', status: 'SUCCEEDED', appointmentId: null },
    ]);

    const sale = await readSale(saleId);
    expect(sale.settledAmountMinor).toBe(TICKET_MINOR);
    expect(sale.settledAt).not.toBeNull();
  });

  it('N versements partiels simultanés ne dépassent jamais le total', async () => {
    // La variante qui compte vraiment : ici, chaque tentative est *légitime*
    // prise isolément — 1 000 sur un ticket de 7 800 —, et c'est leur somme qui
    // ne l'est pas. Un contrôle applicatif « le montant tient dans le reste
    // dû » les laisserait toutes passer.
    const { tenantId, saleId } = await seedSale();
    const part = 1000;
    const attempts = 12;

    const outcomes = await Promise.all(
      Array.from({ length: attempts }, () =>
        runWithTenant(tenantId, () =>
          settlements.settleSale(saleId, { method: 'CASH', amountMinor: part }),
        ),
      ),
    );

    const applied = outcomes.filter((outcome) => outcome.outcome === 'settled').length;
    const sale = await readSale(saleId);

    // Sept versements de 1 000 passent, le huitième dépasserait — 7 800 n'est
    // pas un multiple de 1 000, et c'est délibéré : le ticket ne peut pas se
    // solder exactement par cette découpe, ce qui met le refus en évidence.
    expect(sale.settledAmountMinor).toBe(applied * part);
    expect(sale.settledAmountMinor).toBeLessThanOrEqual(TICKET_MINOR);
    expect(applied).toBe(Math.floor(TICKET_MINOR / part));
    // Le ticket n'est pas soldé : il reste 800 que cette découpe ne peut pas
    // atteindre.
    expect(sale.settledAt).toBeNull();

    const written = await paymentsOf(saleId);
    expect(written).toHaveLength(applied);
  });

  it('refuse en base ce que la règle laisserait passer — la contrainte est le filet', async () => {
    // On force l'écriture de trop **sans passer par le dépôt**, pour prouver que
    // l'invariant ne dépend pas de `settlement.rules.ts`. Si la contrainte
    // disparaissait de la migration, ce cas verdirait — et c'est exactement ce
    // qu'il faut voir rougir.
    const { saleId } = await seedSale();

    await expect(
      prismaUnscoped.sale.update({
        where: { id: saleId },
        data: { settledAmountMinor: TICKET_MINOR + 1 },
      }),
    ).rejects.toThrow(/sales_settled_amount_minor_check/u);
  });

  it('refuse en base une date de solde sur un ticket qui ne l’est pas', async () => {
    const { saleId } = await seedSale();

    await expect(
      prismaUnscoped.sale.update({
        where: { id: saleId },
        data: { settledAmountMinor: 1000, settledAt: new Date() },
      }),
    ).rejects.toThrow(/sales_settled_at_check/u);
  });

  it('exige une vente de tout encaissement neuf — `NOT VALID` ne dispense que l’existant', async () => {
    const { tenantId } = await seedSale();

    await expect(
      prismaUnscoped.payment.create({
        data: {
          tenantId,
          appointmentId: null,
          amountMinor: 1000,
          currency: 'EUR',
          method: 'CASH',
          status: 'SUCCEEDED',
          capturedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/payments_sale_required_check/u);
  });

  describe('le règlement mixte — le ticket de 78,00 € du quatrième critère', () => {
    it('se règle en 50,00 € d’espèces puis 28,00 € au terminal', async () => {
      const { tenantId, saleId } = await seedSale();

      const first = await runWithTenant(tenantId, () =>
        settlements.settleSale(saleId, { method: 'CASH', amountMinor: 5000 }),
      );
      const second = await runWithTenant(tenantId, () =>
        settlements.settleSale(saleId, { method: 'CARD', amountMinor: 2800 }),
      );

      expect(first.outcome).toBe('settled');
      expect(second.outcome).toBe('settled');

      if (first.outcome !== 'settled' || second.outcome !== 'settled') {
        throw new Error('les deux versements auraient dû aboutir');
      }

      expect(first.settlement.remaining.amountMinor).toBe(2800);
      expect(first.settlement.settledAt).toBeNull();
      expect(second.settlement.remaining.amountMinor).toBe(0);
      expect(second.settlement.settledAt).not.toBeNull();

      expect(await paymentsOf(saleId)).toEqual([
        { amountMinor: 5000, method: 'CASH', status: 'SUCCEEDED', appointmentId: null },
        { amountMinor: 2800, method: 'CARD', status: 'SUCCEEDED', appointmentId: null },
      ]);
    });

    it('refuse un versement qui dépasserait le reste dû, et dit ce qui reste', async () => {
      const { tenantId, saleId } = await seedSale();

      await runWithTenant(tenantId, () =>
        settlements.settleSale(saleId, { method: 'CASH', amountMinor: 5000 }),
      );
      const refused = await runWithTenant(tenantId, () =>
        settlements.settleSale(saleId, { method: 'CARD', amountMinor: 2801 }),
      );

      expect(refused).toEqual({ outcome: 'overpayment', remainingAmountMinor: 2800 });
      // Le refus du dépôt est celui que le service traduit en 422.
      expect(new SaleOverpaymentError(2800).status).toBe(422);
    });

    it('rend la monnaie d’un billet trop grand sans jamais l’encaisser', async () => {
      const { tenantId, saleId } = await seedSale();

      const outcome = await runWithTenant(tenantId, () =>
        settlements.settleSale(saleId, { method: 'CASH', tenderedAmountMinor: 10_000 }),
      );

      if (outcome.outcome !== 'settled') {
        throw new Error('le billet tendu aurait dû être accepté');
      }

      expect(outcome.settlement.change.amountMinor).toBe(2200);
      expect(outcome.settlement.settled.amountMinor).toBe(TICKET_MINOR);

      // L'excédent n'entre nulle part : la ligne inscrite vaut le ticket, pas
      // le billet.
      expect(await paymentsOf(saleId)).toEqual([
        { amountMinor: TICKET_MINOR, method: 'CASH', status: 'SUCCEEDED', appointmentId: null },
      ]);
    });
  });

  describe('l’encaissement d’un rendez-vous — deuxième critère', () => {
    /** Sème un rendez-vous honoré, et rend de quoi composer son ticket. */
    const seedAppointment = async (): Promise<{
      readonly tenantId: string;
      readonly appointmentId: string;
      readonly draft: SaleDraft;
    }> => {
      const tenant = await prismaUnscoped.tenant.create({
        data: {
          slug: `i817-rdv-${randomUUID()}`,
          name: 'Barber Tana',
          timezone: 'Europe/Paris',
          defaultCurrency: 'EUR',
        },
      });

      const client = await prismaUnscoped.user.create({
        data: {
          tenantId: tenant.id,
          email: `cliente-${randomUUID()}@example.test`,
          role: 'CLIENT',
          firstName: 'Alice',
          lastName: 'Martin',
        },
      });

      const staffAccount = await prismaUnscoped.user.create({
        data: {
          tenantId: tenant.id,
          email: `staff-${randomUUID()}@example.test`,
          role: 'STAFF',
          firstName: 'Camille',
          lastName: 'Praticien',
        },
      });
      const staff = await prismaUnscoped.staff.create({
        data: { tenantId: tenant.id, userId: staffAccount.id, displayName: 'Camille' },
      });

      const service = await prismaUnscoped.service.create({
        data: {
          tenantId: tenant.id,
          slug: `soin-${randomUUID().slice(0, 8)}`,
          name: 'Soin éclat 45 min',
          durationMinutes: 45,
          priceAmountMinor: TICKET_MINOR,
          priceCurrency: 'EUR',
        },
      });

      const startsAt = new Date('2026-09-17T09:00:00.000Z');
      const appointment = await prismaUnscoped.appointment.create({
        data: {
          tenantId: tenant.id,
          clientId: client.id,
          staffId: staff.id,
          serviceId: service.id,
          reference: `RDV-${randomUUID().slice(0, 4).toUpperCase()}-01`,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 45 * 60_000),
          status: 'COMPLETED',
          priceAmountMinor: TICKET_MINOR,
          priceCurrency: 'EUR',
        },
        select: { id: true },
      });

      // Ce que `SalesService.composeForAppointment` rend : la prestation au
      // **prix figé à la réservation**, et rien d'autre.
      const draft: SaleDraft = {
        appointmentId: appointment.id,
        cashierUserId: staffAccount.id,
        currency: 'EUR',
        subtotalAmountMinor: TICKET_MINOR,
        taxAmountMinor: 0,
        tipAmountMinor: 0,
        totalAmountMinor: TICKET_MINOR,
        items: [
          {
            kind: 'SERVICE',
            serviceId: service.id,
            productId: null,
            label: 'Soin éclat 45 min',
            quantity: 1,
            unitAmount: { amountMinor: TICKET_MINOR, currency: 'EUR' },
            lineAmount: { amountMinor: TICKET_MINOR, currency: 'EUR' },
            position: 0,
          },
        ],
      };

      return { tenantId: tenant.id, appointmentId: appointment.id, draft };
    };

    it('compose la vente puis la règle, en une seule transaction', async () => {
      const { tenantId, appointmentId, draft } = await seedAppointment();

      const outcome = await runWithTenant(tenantId, () =>
        settlements.settleAppointment(appointmentId, draft, { method: 'CASH' }),
      );

      if (outcome.outcome !== 'settled') {
        throw new Error(`le règlement aurait dû aboutir : ${outcome.outcome}`);
      }

      // La pièce existe, elle porte le rendez-vous, et elle est soldée — les
      // trois faits qu'aucun chemin ne produisait avant #817.
      const sale = await prismaUnscoped.sale.findUniqueOrThrow({
        where: { id: outcome.settlement.saleId },
        select: {
          appointmentId: true,
          totalAmountMinor: true,
          settledAmountMinor: true,
          settledAt: true,
          items: { select: { kind: true, lineAmountMinor: true } },
        },
      });

      expect(sale.appointmentId).toBe(appointmentId);
      expect(sale.totalAmountMinor).toBe(TICKET_MINOR);
      expect(sale.settledAmountMinor).toBe(TICKET_MINOR);
      expect(sale.settledAt).not.toBeNull();
      expect(sale.items).toEqual([{ kind: 'SERVICE', lineAmountMinor: TICKET_MINOR }]);

      // Le règlement porte sa vente, et **pas** le rendez-vous : c'est le ticket
      // qui le porte, et l'unique par rendez-vous refuserait un second
      // versement (schéma, `Payment.appointmentId`).
      expect(await paymentsOf(outcome.settlement.saleId)).toEqual([
        { amountMinor: TICKET_MINOR, method: 'CASH', status: 'SUCCEEDED', appointmentId: null },
      ]);
    });

    it('n’écrit qu’un ticket pour N encaissements simultanés du même rendez-vous', async () => {
      // Sans le verrou consultatif, chaque transaction lirait « pas de ticket »
      // et en écrirait un — puis le règlerait. La cliente paierait N fois, et
      // aucune contrainte ne l'en empêcherait : les tickets seraient distincts.
      const { tenantId, appointmentId, draft } = await seedAppointment();

      const outcomes = await Promise.all(
        Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
          runWithTenant(tenantId, () =>
            settlements.settleAppointment(appointmentId, draft, { method: 'CASH' }),
          ),
        ),
      );

      const settled = outcomes.filter((outcome) => outcome.outcome === 'settled');
      expect(settled).toHaveLength(1);

      const tickets = await prismaUnscoped.sale.count({ where: { appointmentId } });
      const payments = await prismaUnscoped.payment.count({
        where: { sale: { appointmentId } },
      });

      expect({ tickets, payments }).toEqual({ tickets: 1, payments: 1 });
    });
  });

  it('ne trouve pas le ticket du salon voisin — 404, jamais 403', async () => {
    const mine = await seedSale();
    const neighbour = await seedSale();

    // Le ticket existe, mais pas dans cet établissement : le dépôt ne le voit
    // pas, et le service lève `NotFoundError` (tenant-isolation §4).
    const outcome = await runWithTenant(mine.tenantId, () =>
      settlements.settleSale(neighbour.saleId, { method: 'CASH' }),
    );

    expect(outcome).toEqual({ outcome: 'sale-not-found' });

    // Et le ticket du voisin est resté intact.
    const untouched = await readSale(neighbour.saleId);
    expect(untouched.settledAmountMinor).toBe(0);
    expect(await paymentsOf(neighbour.saleId)).toEqual([]);
  });

  it('rend « déjà soldé » avec l’instant du solde — ce que 409 porte dans `details`', async () => {
    const { tenantId, saleId } = await seedSale();

    await runWithTenant(tenantId, () => settlements.settleSale(saleId, { method: 'CASH' }));
    const refused = await runWithTenant(tenantId, () =>
      settlements.settleSale(saleId, { method: 'CASH' }),
    );

    if (refused.outcome !== 'already-settled') {
      throw new Error('le second règlement aurait dû être refusé');
    }

    expect(refused.settledAt).toBeInstanceOf(Date);
    expect(new SaleAlreadySettledError(refused.settledAt).status).toBe(409);
  });
});
