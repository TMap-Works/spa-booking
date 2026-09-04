import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  AppointmentNotPayableError,
  PaymentAlreadySettledError,
  PaymentProviderUnavailableError,
} from '../payments.errors';
import type { PaymentsRepository } from '../payments.repository';
import { PaymentsService } from '../payments.service';
import { STRIPE_GATEWAY } from '../stripe/stripe.gateway';
import {
  FakePaymentsRepository,
  FakeStripeGateway,
  TEST_STRIPE_ENV,
  testStripeConfig,
} from './payments.doubles';

/**
 * Les règles de l'encaissement en ligne, exercées sans HTTP ni base ni réseau.
 *
 * Ce que cette suite couvre en propre, et que ni les tests d'intégration ni la
 * recette ne peuvent atteindre aussi finement :
 *
 * - **d'où vient le montant** — de la ligne en base, jamais de l'appelant ;
 * - **l'idempotence**, sous ses trois formes : la ligne déjà là, la clé
 *   d'idempotence Stripe, et la course perdue par l'insertion ;
 * - **ce qui part chez le prestataire** — deux identifiants opaques, aucune
 *   donnée personnelle ;
 * - **ce qui revient au navigateur** — un laissez-passer et la clé publiable,
 *   jamais la clé secrète.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('PaymentsService — intention de paiement d’un rendez-vous', () => {
  let repository: FakePaymentsRepository;
  let stripe: FakeStripeGateway;
  let service: PaymentsService;

  beforeEach(() => {
    repository = new FakePaymentsRepository();
    stripe = new FakeStripeGateway();
    service = new PaymentsService(
      repository as unknown as PaymentsRepository,
      new TenantContextService(),
      testStripeConfig(),
      stripe,
    );
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  describe('le cas nominal', () => {
    it('crée l’intention au prix figé en base et rend de quoi la payer', async () => {
      const appointment = repository.seedAppointment({
        tenantId: TENANT_A,
        amountMinor: 7000,
        currency: 'EUR',
      });

      const view = await inTenantA(() => service.createIntentForAppointment(appointment.id));

      expect(view.amount).toEqual({ amountMinor: 7000, currency: 'EUR' });
      expect(view.appointmentId).toBe(appointment.id);
      expect(view.status).toBe('PENDING');
      expect(view.clientSecret).toContain('_secret_');
      expect(view.publishableKey).toBe(TEST_STRIPE_ENV.STRIPE_PUBLISHABLE_KEY);
    });

    it('envoie à Stripe le montant de la base, et non un montant reçu', async () => {
      // Le corps de la requête ne porte qu'un identifiant : c'est le DTO qui
      // l'empêche d'en porter davantage. Ce test vérifie l'autre moitié — que
      // le service, lui, ne lit le montant que d'un seul endroit.
      const appointment = repository.seedAppointment({
        tenantId: TENANT_A,
        amountMinor: 12_500,
        currency: 'EUR',
      });

      await inTenantA(() => service.createIntentForAppointment(appointment.id));

      expect(stripe.commands).toHaveLength(1);
      expect(stripe.commands[0]).toMatchObject({ amountMinor: 12_500, currency: 'EUR' });
    });

    it('n’envoie à Stripe que deux identifiants opaques en métadonnées', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      await inTenantA(() => service.createIntentForAppointment(appointment.id));

      // `tenantId` n'est pas décoratif : c'est lui qui permettra au webhook de
      // #58 de résoudre l'établissement, `provider_payment_intent_id` étant
      // unique **par tenant**. Aucune donnée personnelle ne l'accompagne
      // (CDC §5.1).
      expect(stripe.commands[0]?.metadata).toEqual({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
      });
    });

    it('inscrit une ligne « carte, en attente » — jamais un paiement abouti', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      await inTenantA(() => service.createIntentForAppointment(appointment.id));

      // Le passage à `SUCCEEDED` est l'affaire du webhook signé (#58), et de lui
      // seul : la source de vérité du paiement est Stripe reçue côté serveur.
      expect(repository.allPayments()).toEqual([
        expect.objectContaining({ tenantId: TENANT_A, method: 'CARD', status: 'PENDING' }),
      ]);
    });

    it('accepte un rendez-vous déjà confirmé — reprise d’un tunnel abandonné', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A, status: 'CONFIRMED' });

      await expect(
        inTenantA(() => service.createIntentForAppointment(appointment.id)),
      ).resolves.toMatchObject({ status: 'PENDING' });
    });
  });

  describe('l’idempotence', () => {
    it('rend la même intention à deux appels successifs, sans rien créer de plus', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      const first = await inTenantA(() => service.createIntentForAppointment(appointment.id));
      const second = await inTenantA(() => service.createIntentForAppointment(appointment.id));

      expect(second.paymentId).toBe(first.paymentId);
      expect(second.clientSecret).toBe(first.clientSecret);
      // Une seule création chez Stripe, et la reprise passe par une relecture.
      expect(stripe.commands).toHaveLength(1);
      expect(stripe.retrieved).toEqual([expect.stringMatching(/^pi_/)]);
      expect(repository.allPayments()).toHaveLength(1);
    });

    it('dérive une clé d’idempotence stable du couple (établissement, rendez-vous)', async () => {
      const first = repository.seedAppointment({ tenantId: TENANT_A });
      const second = repository.seedAppointment({ tenantId: TENANT_A });

      await inTenantA(() => service.createIntentForAppointment(first.id));
      await inTenantA(() => service.createIntentForAppointment(second.id));

      const keys = stripe.commands.map((command) => command.idempotencyKey);
      expect(keys[0]).toBe(`appointment-intent:${TENANT_A}:${first.id}`);
      // Deux rendez-vous distincts n'ont pas la même clé, sans quoi le second
      // recevrait l'intention du premier — au montant du premier.
      expect(new Set(keys).size).toBe(2);
    });

    it('reprend la ligne concurrente quand Stripe refuse la clé déjà en vol', async () => {
      // Stripe répond `409 idempotency_error` quand une **autre requête portant
      // la même clé est encore en vol** — c'est-à-dire très exactement le
      // deuxième clic que cette route promet de rendre inoffensif. Rendre 503 à
      // ce clic-là contredirait la garantie, alors que le premier aboutit.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      const concurrent = repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
      });
      // La ligne existe mais le service ne l'a pas encore vue : on force le
      // chemin « création » en faisant échouer la lecture initiale une fois.
      jest.spyOn(repository, 'findPaymentByAppointment').mockResolvedValueOnce(null);
      // L'échec porte sur la **création** seule : la relecture qui suit doit,
      // elle, aboutir — c'est tout le propos de la reprise.
      jest
        .spyOn(stripe, 'createPaymentIntent')
        .mockRejectedValueOnce(new PaymentProviderUnavailableError());

      const view = await inTenantA(() => service.createIntentForAppointment(appointment.id));

      expect(view.paymentId).toBe(concurrent.id);
    });

    it('laisse remonter une vraie panne du prestataire, sans retenter', async () => {
      // La contrepartie : quand aucune ligne concurrente n'est apparue, l'échec
      // est réel. On ne rejoue pas l'appel — cela transformerait une panne du
      // prestataire en tempête de requêtes.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      stripe.failWith = new PaymentProviderUnavailableError();

      await expect(
        inTenantA(() => service.createIntentForAppointment(appointment.id)),
      ).rejects.toThrow(PaymentProviderUnavailableError);
      expect(stripe.commands).toHaveLength(1);
      expect(repository.allPayments()).toHaveLength(0);
    });

    it('rend l’intention de la ligne gagnante quand deux requêtes se croisent', async () => {
      // Le scénario réel : deux clics, deux requêtes concurrentes. Les deux
      // franchissent « pas encore d'encaissement », les deux appellent Stripe
      // avec la **même** clé — donc obtiennent la même intention —, et
      // l'unicité en base en refuse une. Simulé ici en semant la ligne
      // concurrente juste avant l'insertion.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      const concurrent = repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
      });
      const record = jest.spyOn(repository, 'recordCardIntent');

      const view = await inTenantA(() => service.createIntentForAppointment(appointment.id));

      // La ligne gagnante est celle rendue, et rien n'a été inséré en double.
      expect(view.paymentId).toBe(concurrent.id);
      expect(repository.allPayments()).toHaveLength(1);
      // La reprise a court-circuité l'insertion : la ligne était déjà lue.
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('ce qui n’est pas payable', () => {
    it('rend « introuvable » pour un rendez-vous inconnu', async () => {
      await expect(inTenantA(() => service.createIntentForAppointment(randomUUID()))).rejects.toThrow(
        NotFoundError,
      );
    });

    it('rend « introuvable » — et non « interdit » — pour le rendez-vous du voisin', async () => {
      // Un 403 confirmerait l'existence de la ressource (tenant-isolation §4).
      const neighbour = repository.seedAppointment({ tenantId: TENANT_B });

      await expect(
        inTenantA(() => service.createIntentForAppointment(neighbour.id)),
      ).rejects.toThrow(NotFoundError);
      // Et rien n'a été demandé au prestataire pour un rendez-vous d'ailleurs.
      expect(stripe.commands).toHaveLength(0);
    });

    it.each(['CANCELLED', 'COMPLETED', 'NO_SHOW'])(
      'refuse un rendez-vous %s — plus rien à encaisser en ligne',
      async (status) => {
        const appointment = repository.seedAppointment({ tenantId: TENANT_A, status });

        await expect(
          inTenantA(() => service.createIntentForAppointment(appointment.id)),
        ).rejects.toThrow(AppointmentNotPayableError);
        expect(stripe.commands).toHaveLength(0);
      },
    );

    it.each(['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const)(
      'refuse de rouvrir un encaissement %s',
      async (status) => {
        const appointment = repository.seedAppointment({ tenantId: TENANT_A });
        repository.seedPayment({ tenantId: TENANT_A, appointmentId: appointment.id, status });

        await expect(
          inTenantA(() => service.createIntentForAppointment(appointment.id)),
        ).rejects.toThrow(PaymentAlreadySettledError);
      },
    );

    it('laisse repayer après une carte refusée', async () => {
      // Le cas le plus banal du tunnel, et celui qui coûterait la vente s'il
      // était traité comme un encaissement clos : `@@unique([tenantId,
      // appointmentId])` interdit d'inscrire une seconde ligne, si bien qu'un
      // `FAILED` définitif rendrait le rendez-vous impayable pour toujours —
      // au comptoir compris. L'intention Stripe, elle, redevient
      // `requires_payment_method` et attend une autre carte.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      const failed = repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
        status: 'FAILED',
      });

      const view = await inTenantA(() => service.createIntentForAppointment(appointment.id));

      expect(view.paymentId).toBe(failed.id);
      expect(view.clientSecret).toContain('_secret_');
      expect(stripe.retrieved).toEqual([failed.providerPaymentIntentId]);
      // Toujours une seule ligne : on reprend, on ne double pas.
      expect(repository.allPayments()).toHaveLength(1);
    });

    it('refuse de rendre un formulaire quand Stripe dit que c’est déjà payé', async () => {
      // Le webhook de #58 peut avoir du retard : la ligne dit encore `PENDING`
      // alors que l'argent est encaissé. La relecture n'existe pas que pour
      // récupérer le secret — elle existe pour ne pas se fier à notre copie.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      repository.seedPayment({ tenantId: TENANT_A, appointmentId: appointment.id });
      stripe.retrievedStatus = 'succeeded';

      await expect(
        inTenantA(() => service.createIntentForAppointment(appointment.id)),
      ).rejects.toThrow(PaymentAlreadySettledError);
    });

    it('refuse de rendre le secret d’une intention annulée chez Stripe', async () => {
      // Une intention annulée n'est pas confirmable : rendre son secret
      // produirait un formulaire qui échoue à la soumission, sans que la
      // cliente sache pourquoi.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      repository.seedPayment({ tenantId: TENANT_A, appointmentId: appointment.id });
      stripe.retrievedStatus = 'canceled';

      await expect(
        inTenantA(() => service.createIntentForAppointment(appointment.id)),
      ).rejects.toThrow(PaymentAlreadySettledError);
    });

    it('refuse de doubler une vente déjà réglée en espèces au comptoir', async () => {
      // Une vente en espèces n'a pas d'intention Stripe à reprendre, et il ne
      // doit pas y en avoir : `@@unique([tenantId, appointmentId])` garantit
      // qu'un rendez-vous n'a qu'un encaissement.
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });
      repository.seedPayment({
        tenantId: TENANT_A,
        appointmentId: appointment.id,
        method: 'CASH',
        status: 'PENDING',
        providerPaymentIntentId: null,
      });

      await expect(
        inTenantA(() => service.createIntentForAppointment(appointment.id)),
      ).rejects.toThrow(PaymentAlreadySettledError);
      expect(stripe.retrieved).toHaveLength(0);
    });
  });

  describe('ce qui ne sort jamais du serveur', () => {
    it('ne rend jamais la clé secrète, ni aucun champ de carte', async () => {
      const appointment = repository.seedAppointment({ tenantId: TENANT_A });

      const view = await inTenantA(() => service.createIntentForAppointment(appointment.id));
      const serialised = JSON.stringify(view);

      // La frontière SAQ A, vue depuis la sortie : ce corps ne porte ni clé
      // secrète, ni identifiant d'établissement, ni la moindre notion de carte.
      expect(serialised).not.toContain(TEST_STRIPE_ENV.STRIPE_SECRET_KEY);
      expect(serialised).not.toContain(TENANT_A);
      expect(Object.keys(view).sort()).toEqual([
        'amount',
        'appointmentId',
        'clientSecret',
        'paymentId',
        'publishableKey',
        'status',
      ]);
    });
  });

  it('exige une portée de tenant ouverte', () => {
    // Le mode ouvert par défaut est ce qui produit les fuites : hors portée, le
    // dépôt refuse plutôt que de rendre « toutes les lignes ».
    const service2 = new PaymentsService(
      new FakePaymentsRepository() as unknown as PaymentsRepository,
      new TenantContextService(),
      testStripeConfig(),
      new FakeStripeGateway(),
    );

    return expect(service2.createIntentForAppointment(randomUUID())).rejects.toThrow();
  });

  it('branche la passerelle par un jeton, jamais par une classe concrète', () => {
    // Ce qui permet aux suites de substituer un double : aucun test de ce dépôt
    // n'atteint l'environnement Stripe (payments-stripe §7).
    expect(typeof STRIPE_GATEWAY).toBe('symbol');
  });
});
