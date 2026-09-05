import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { CashPaymentsService } from '../cash-payments.service';
import { AppointmentNotSettleableError, PaymentAlreadySettledError } from '../payments.errors';
import type { PaymentsRepository } from '../payments.repository';
import { FakePaymentsRepository } from './payments.doubles';
import { recordingLogger, type RecordingLogger } from './webhook.doubles';

/**
 * Le règlement en espèces, exercé sans HTTP ni base (#62).
 *
 * Ce que cette suite couvre en propre :
 *
 * - **le quatrième critère, sur la forme du module** : le chemin espèces
 *   n'importe rien de Stripe, et le service se construit avec deux dépendances
 *   dont aucune n'est la passerelle. Ce n'est pas une observation, c'est une
 *   assertion qui casse si quelqu'un rebranche l'un sur l'autre ;
 * - **d'où vient le montant** — du rendez-vous relu, jamais de l'appelant ;
 * - **ce que la ligne porte** : `CASH`, `SUCCEEDED`, un instant de capture, et
 *   *aucune* référence de prestataire ;
 * - **la rejouabilité** — le deuxième clic rend le premier reçu, il n'encaisse
 *   pas deux fois, et la course perdue en base se rattrape ;
 * - **les refus** : rendez-vous annulé, encaissement carte déjà en place ;
 * - **la frontière du tenant** — le rendez-vous du voisin est *introuvable*.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '44444444-4444-4444-8444-444444444444';

describe('CashPaymentsService', () => {
  let repository: FakePaymentsRepository;
  let logs: RecordingLogger;
  let service: CashPaymentsService;

  beforeEach(() => {
    repository = new FakePaymentsRepository();
    logs = recordingLogger();
    service = new CashPaymentsService(
      repository as unknown as PaymentsRepository,
      logs.logger,
    );
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  /**
   * Le refus levé par un appel, pour l'inspecter.
   *
   * `rejects.toBeInstanceOf` dit *quelle* erreur ; il ne donne pas de quoi
   * comparer deux corps de refus entre eux, ce dont le protocole de fuite a
   * besoin (tenant-isolation §6). Le succès est une faute de test, et se signale
   * comme telle plutôt que de rendre un `undefined` sur lequel l'assertion
   * suivante passerait.
   */
  const refusalOf = async (fn: () => Promise<unknown>): Promise<NotFoundError> => {
    try {
      await inTenantA(fn);
    } catch (error) {
      return error as NotFoundError;
    }

    throw new Error('attendu : un refus, obtenu un succès');
  };

  describe('aucun appel Stripe sur ce chemin — quatrième critère de #62', () => {
    it('n’importe rien de la passerelle ni de sa configuration', () => {
      const source = readFileSync(join(__dirname, '..', 'cash-payments.service.ts'), 'utf8');
      const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

      // La garantie n'est pas qu'on s'abstient d'appeler : c'est qu'il n'y a
      // rien à appeler. Un `import` du module `stripe/` ferait échouer ceci
      // avant même qu'une ligne de service ne l'utilise.
      expect(specifiers.filter((specifier) => specifier.includes('stripe'))).toHaveLength(0);
    });

    it('se construit avec deux dépendances, dont aucune n’est la passerelle', () => {
      // Le service vient d'être instancié dans `beforeEach` avec le dépôt et le
      // journal, et rien d'autre. S'il exigeait `STRIPE_GATEWAY`, ce montage
      // n'existerait pas.
      expect(CashPaymentsService.length).toBe(2);
    });

    it('encaisse sans qu’aucune référence de prestataire n’apparaisse', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A, amountMinor: 7000 });

      const settled = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      expect(settled.providerPaymentIntentId).toBeNull();
      expect(settled.providerChargeId).toBeNull();
    });
  });

  describe('ce que la ligne porte', () => {
    it('relit le montant au rendez-vous, jamais dans la requête', async () => {
      const appointment = repository.seedAppointment({
        tenantId: TENANT_A,
        amountMinor: 7000,
        currency: 'EUR',
      });

      const settled = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      expect(settled.amount).toEqual({ amountMinor: 7000, currency: 'EUR' });
    });

    it('naît abouti et horodaté — la caisse fait foi, il n’y a rien à attendre', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      const settled = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      expect(settled.method).toBe('CASH');
      expect(settled.status).toBe('SUCCEEDED');
      expect(settled.capturedAt).toBeInstanceOf(Date);
      expect(settled.refunded).toEqual({ amountMinor: 0, currency: 'EUR' });
    });

    it('journalise l’opérateur, faute de colonne où l’écrire', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      const settled = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      // La trace de payments-stripe §4 en attendant `payments.operator_user_id`,
      // qui est une migration — hors de l'empreinte de ce ticket.
      expect(logs.entries).toContainEqual(
        expect.objectContaining({
          level: 'log',
          meta: expect.objectContaining({ operatorUserId: OPERATOR, paymentId: settled.id }),
        }),
      );
    });

    it('n’écrit aucune donnée personnelle au journal', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      await inTenantA(() => service.settle(appointment.id, OPERATOR));

      const [entry] = logs.entries;
      expect(Object.keys(entry?.meta as Record<string, unknown>).sort()).toEqual([
        'amountMinor',
        'appointmentId',
        'currency',
        'operatorUserId',
        'paymentId',
      ]);
    });
  });

  describe('la route est rejouable, et n’encaisse jamais deux fois', () => {
    it('rend le même encaissement au deuxième appel', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      const first = await inTenantA(() => service.settle(appointment.id, OPERATOR));
      const second = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      expect(second.id).toBe(first.id);
      expect(repository.allPayments()).toHaveLength(1);
    });

    it('rattrape la course perdue en base plutôt que de la rendre en erreur', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      // La concurrente inscrit sa ligne entre notre lecture et notre écriture :
      // c'est exactement ce que `recordCashPayment` rend par un `null`.
      const concurrent = jest
        .spyOn(repository, 'recordCashPayment')
        .mockImplementationOnce(async () => {
          repository.seedPayment({
            tenantId: TENANT_A,
            appointmentId: appointment.id,
            method: 'CASH',
            status: 'SUCCEEDED',
            providerPaymentIntentId: null,
            capturedAt: new Date(),
          });

          return null;
        });

      const settled = await inTenantA(() => service.settle(appointment.id, OPERATOR));

      expect(concurrent).toHaveBeenCalledTimes(1);
      expect(settled.method).toBe('CASH');
      expect(repository.allPayments()).toHaveLength(1);
    });
  });

  describe('les refus', () => {
    it('refuse un rendez-vous annulé — plus de prestation à vendre', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A, status: 'CANCELLED' });

      await expect(inTenantA(() => service.settle(appointment.id, OPERATOR))).rejects.toBeInstanceOf(
        AppointmentNotSettleableError,
      );
      expect(repository.allPayments()).toHaveLength(0);
    });

    it.each(['PENDING', 'CONFIRMED', 'COMPLETED', 'NO_SHOW'])(
      'encaisse un rendez-vous « %s » — le comptoir accepte ce que le tunnel refuse',
      async (status) => {
        const appointment = repository.seedAppointment({ tenantId: TENANT_A, status });

        await expect(
          inTenantA(() => service.settle(appointment.id, OPERATOR)),
        ).resolves.toMatchObject({ method: 'CASH' });
      },
    );

    it('refuse quand une carte a déjà encaissé ce rendez-vous', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
        method: 'CARD',
        status: 'SUCCEEDED',
      });

      await expect(inTenantA(() => service.settle(appointment.id, OPERATOR))).rejects.toBeInstanceOf(
        PaymentAlreadySettledError,
      );
      expect(repository.allPayments()).toHaveLength(1);
    });

    it('refuse aussi une intention carte encore en cours — elle n’est pas à écraser', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
        method: 'CARD',
        status: 'PENDING',
      });

      await expect(inTenantA(() => service.settle(appointment.id, OPERATOR))).rejects.toBeInstanceOf(
        PaymentAlreadySettledError,
      );
    });
  });

  describe('la frontière du tenant', () => {
    it('rend introuvable le rendez-vous du salon voisin — 404, jamais 403', async () => {
      const chezB = repository.seedAppointment({ tenantId: TENANT_B });

      await expect(inTenantA(() => service.settle(chezB.id, OPERATOR))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(repository.allPayments()).toHaveLength(0);
    });

    it('ne laisse rien filtrer du refus — `details` vide, message indistinct', async () => {
      const chezB = repository.seedAppointment({ tenantId: TENANT_B });

      const refusVoisin = await refusalOf(() => service.settle(chezB.id, OPERATOR));
      const refusInconnu = await refusalOf(() =>
        service.settle('55555555-5555-4555-8555-555555555555', OPERATOR),
      );

      // Les deux refus doivent être indiscernables : une différence servirait de
      // sonde d'existence (tenant-isolation §4).
      expect(refusVoisin.message).toBe(refusInconnu.message);
      expect(refusVoisin.details).toEqual(refusInconnu.details);
      expect(refusVoisin.details).toEqual({});
    });
  });
});
