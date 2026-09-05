import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { TenantContextService } from '../../../common/tenant/tenant-context.service';
import {
  PaymentNotRefundableError,
  PaymentProviderRefusedError,
  PaymentProviderUnavailableError,
  RefundExceedsCapturedError,
} from '../payments.errors';
import { RefundsService } from '../refunds.service';
import type { RefundsRepository } from '../refunds.repository';
import { FakeStripeGateway } from './payments.doubles';
import { FakeRefundsRepository } from './refunds.doubles';
import { recordingLogger, type RecordingLogger } from './webhook.doubles';

/**
 * Le remboursement au comptoir, exercé sans HTTP ni base (#63).
 *
 * Ce que cette suite couvre, critère par critère :
 *
 * | Critère de #63 | Ce qui l'exerce ici |
 * |---|---|
 * | remboursement **total** et **partiel** via l'API du prestataire | « ordonne au prestataire » |
 * | le cumul ne dépasse **jamais** le montant capturé | « le cumul, vérifié côté serveur » |
 * | traçabilité : **qui, quand, pourquoi** | « la trace du geste » |
 *
 * Les deux autres critères — le statut écrit par le webhook `charge.refunded`,
 * l'alerte de litige — sont ceux de #58 et sont exercés par
 * `stripe-webhook.service.spec.ts` et `payments-webhook.isolation-spec.ts`.
 * Cette suite prouve l'autre moitié : que ce service **n'y touche pas**.
 *
 * S'y ajoutent trois propriétés que le ticket ne nomme pas mais dont il dépend :
 * l'ordre « réserver puis ordonner », le relâchement de la réservation sur
 * échec du prestataire, et la frontière du tenant.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const MANAGER = '44444444-4444-4444-8444-444444444444';

describe('RefundsService', () => {
  let repository: FakeRefundsRepository;
  let stripe: FakeStripeGateway;
  let logs: RecordingLogger;
  let service: RefundsService;

  beforeEach(() => {
    repository = new FakeRefundsRepository();
    stripe = new FakeStripeGateway();
    logs = recordingLogger();
    service = new RefundsService(
      repository as unknown as RefundsRepository,
      new TenantContextService(),
      stripe,
      logs.logger,
    );
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);

  /**
   * Le refus levé par un appel, pour l'inspecter.
   *
   * `rejects.toBeInstanceOf` dit *quelle* erreur ; il ne donne pas de quoi
   * comparer deux corps de refus entre eux, ce dont le protocole de fuite a
   * besoin (tenant-isolation §6). Le succès est une faute de test et se signale
   * comme telle.
   */
  const refusalOf = async (fn: () => Promise<unknown>): Promise<NotFoundError> => {
    try {
      await inTenantA(fn);
    } catch (error) {
      return error as NotFoundError;
    }

    throw new Error('attendu : un refus, obtenu un succès');
  };

  describe('ordonne au prestataire — premier critère', () => {
    it('rembourse la totalité du solde quand aucun montant n’est donné', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'prestation annulée' }, MANAGER),
      );

      expect(refund.amount).toEqual({ amountMinor: 7000, currency: 'EUR' });
      // Le montant est **envoyé explicitement**, y compris pour un
      // remboursement total : l'omettre laisserait le prestataire décider d'une
      // somme que notre contrôle de cumul n'a pas examinée.
      expect(stripe.refundCommands).toHaveLength(1);
      expect(stripe.refundCommands[0]?.amountMinor).toBe(7000);
      expect(stripe.refundCommands[0]?.paymentIntentId).toBe(payment.providerPaymentIntentId);
    });

    it('rembourse le montant demandé quand il est partiel', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { amountMinor: 2500, reason: 'geste commercial' }, MANAGER),
      );

      expect(refund.amount.amountMinor).toBe(2500);
      expect(stripe.refundCommands[0]?.amountMinor).toBe(2500);
    });

    it('conclut la réservation sur la référence rendue par le prestataire', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'soin interrompu' }, MANAGER),
      );

      expect(refund.status).toBe('SUCCEEDED');
      expect(refund.providerRefundId).toMatch(/^re_/);
    });

    it('dérive la clé d’idempotence de la ligne réservée, jamais d’un aléa', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'erreur de saisie' }, MANAGER),
      );

      // La clé est posée **avant** l'appel et vaut l'identifiant de la ligne :
      // c'est ce qui fait qu'un renvoi après coupure réseau rend le
      // remboursement déjà créé au lieu d'en émettre un second — le seul appel
      // du module où l'idempotence protège une sortie d'argent.
      expect(stripe.refundCommands[0]?.idempotencyKey).toBe(refund.id);
    });

    it('refuse un encaissement en espèces — il n’y a pas d’ordre à envoyer', async () => {
      const payment = repository.seedPayment({
        tenantId: TENANT_A,
        method: 'CASH',
        providerPaymentIntentId: null,
      });

      await expect(
        inTenantA(() => service.refund(payment.id, { reason: 'rendu en caisse' }, MANAGER)),
      ).rejects.toBeInstanceOf(PaymentNotRefundableError);

      expect(stripe.refundCommands).toHaveLength(0);
    });

    it.each(['PENDING', 'FAILED', 'REFUNDED'] as const)(
      'refuse un encaissement au statut %s',
      async (status) => {
        const payment = repository.seedPayment({ tenantId: TENANT_A, status });

        await expect(
          inTenantA(() => service.refund(payment.id, { reason: 'peu importe' }, MANAGER)),
        ).rejects.toBeInstanceOf(PaymentNotRefundableError);

        expect(stripe.refundCommands).toHaveLength(0);
      },
    );

    it('accepte un encaissement déjà partiellement remboursé', async () => {
      const payment = repository.seedPayment({
        tenantId: TENANT_A,
        amountMinor: 7000,
        status: 'PARTIALLY_REFUNDED',
        refundedAmountMinor: 2000,
      });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'complément' }, MANAGER),
      );

      // Le solde, et non le montant capturé : 7000 − 2000.
      expect(refund.amount.amountMinor).toBe(5000);
    });
  });

  describe('le cumul, vérifié côté serveur — deuxième critère', () => {
    it('refuse un montant supérieur à ce qui reste, sans rien envoyer', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });

      await expect(
        inTenantA(() => service.refund(payment.id, { amountMinor: 7001, reason: 'trop' }, MANAGER)),
      ).rejects.toBeInstanceOf(RefundExceedsCapturedError);

      // Le refus tombe **avant** l'appel : le prestataire le refuserait aussi,
      // mais en faire un incident de prestataire aurait rendu 503 là où le
      // comptoir a simplement demandé trop.
      expect(stripe.refundCommands).toHaveLength(0);
    });

    it('dit ce qu’il restait, pour que l’écran n’ait pas à retâtonner', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      repository.seedRefund({ tenantId: TENANT_A, paymentId: payment.id, amountMinor: 4500 });

      const refusal = await refusalOf(() =>
        service.refund(payment.id, { amountMinor: 3000, reason: 'trop' }, MANAGER),
      );

      expect(refusal.details).toEqual({ remainingAmountMinor: 2500, currency: 'EUR' });
    });

    it('compte les réservations encore en vol — le webhook n’a pas à être arrivé', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      // `PENDING` : l'ordre est parti, `charge.refunded` n'est pas encore
      // revenu. Sans cette réservation dans le cumul, deux comptoirs simultanés
      // rendraient deux fois la même somme.
      repository.seedRefund({
        tenantId: TENANT_A,
        paymentId: payment.id,
        amountMinor: 7000,
        status: 'PENDING',
      });

      await expect(
        inTenantA(() => service.refund(payment.id, { amountMinor: 100, reason: 'second' }, MANAGER)),
      ).rejects.toBeInstanceOf(RefundExceedsCapturedError);
    });

    it('ne compte pas une réservation relâchée — la somme reste remboursable', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      repository.seedRefund({
        tenantId: TENANT_A,
        paymentId: payment.id,
        amountMinor: 7000,
        status: 'FAILED',
      });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'nouvelle tentative' }, MANAGER),
      );

      expect(refund.amount.amountMinor).toBe(7000);
    });

    it('retient le cumul du webhook quand il dépasse le nôtre', async () => {
      // Un remboursement fait à la main dans le tableau de bord du prestataire :
      // aucune ligne chez nous, mais `charge.refunded` l'a inscrit. C'est
      // l'angle mort que nos propres réservations ne couvrent pas.
      const payment = repository.seedPayment({
        tenantId: TENANT_A,
        amountMinor: 7000,
        refundedAmountMinor: 6000,
      });

      await expect(
        inTenantA(() =>
          service.refund(payment.id, { amountMinor: 2000, reason: 'ignorant' }, MANAGER),
        ),
      ).rejects.toBeInstanceOf(RefundExceedsCapturedError);
    });

    it('refuse un remboursement total sur un solde déjà épuisé', async () => {
      const payment = repository.seedPayment({
        tenantId: TENANT_A,
        amountMinor: 7000,
        status: 'PARTIALLY_REFUNDED',
        refundedAmountMinor: 7000,
      });

      await expect(
        inTenantA(() => service.refund(payment.id, { reason: 'encore' }, MANAGER)),
      ).rejects.toBeInstanceOf(RefundExceedsCapturedError);
    });
  });

  describe('la trace du geste — troisième critère', () => {
    it('inscrit qui, quand et pourquoi sur la ligne', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'prestation non conforme' }, MANAGER),
      );

      expect(refund.requestedByUserId).toBe(MANAGER);
      expect(refund.reason).toBe('prestation non conforme');
      expect(refund.createdAt).toBeInstanceOf(Date);
    });

    it('journalise le geste sans le motif — il peut nommer la cliente', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });

      await inTenantA(() =>
        service.refund(payment.id, { reason: 'Madame Dupont mécontente' }, MANAGER),
      );

      const entry = logs.entries.find((candidate) =>
        candidate.message.includes('remboursement ordonné'),
      );

      expect(entry?.meta).toMatchObject({ operatorUserId: MANAGER });
      expect(JSON.stringify(entry?.meta)).not.toContain('Dupont');
    });

    it('n’envoie au prestataire que des identifiants opaques', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'Madame Dupont mécontente' }, MANAGER),
      );

      // Le champ `reason` de Stripe n'accepte que trois valeurs énumérées, et
      // le motif du comptoir est un texte libre : il ne part pas (CDC §5.1).
      expect(stripe.refundCommands[0]?.metadata).toEqual({
        tenantId: TENANT_A,
        paymentId: payment.id,
        refundId: refund.id,
      });
      expect(JSON.stringify(stripe.refundCommands[0])).not.toContain('Dupont');
    });
  });

  describe('réserver avant d’ordonner', () => {
    it('relâche la réservation sur un refus définitif du prestataire', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      // Un refus **définitif** : la requête a été reçue, comprise et rejetée.
      // Rien n'est sorti, donc la somme peut redevenir remboursable.
      stripe.failWith = new PaymentProviderRefusedError();

      await expect(
        inTenantA(() => service.refund(payment.id, { reason: 'montant refusé' }, MANAGER)),
      ).rejects.toBeInstanceOf(PaymentProviderRefusedError);

      expect(repository.allRefunds().map((row) => row.status)).toEqual(['FAILED']);

      stripe.failWith = null;
      const retried = await inTenantA(() =>
        service.refund(payment.id, { reason: 'nouvelle tentative' }, MANAGER),
      );

      expect(retried.amount.amountMinor).toBe(7000);
    });

    it('conserve la réservation quand le sort de l’ordre est inconnu', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      // Délai dépassé, coupure, panne : l'ordre a peut-être abouti. Relâcher
      // ici ferait repartir une reprise avec une **autre** clé d'idempotence,
      // que le prestataire ne reconnaîtrait pas comme un doublon — donc
      // l'argent rendu deux fois.
      stripe.failWith = new PaymentProviderUnavailableError();

      await expect(
        inTenantA(() => service.refund(payment.id, { reason: 'coupure réseau' }, MANAGER)),
      ).rejects.toBeInstanceOf(PaymentProviderUnavailableError);

      expect(repository.allRefunds().map((row) => row.status)).toEqual(['PENDING']);

      // Et la somme reste immobilisée : le second geste se heurte au cumul
      // plutôt que de rendre une seconde fois.
      stripe.failWith = null;
      await expect(
        inTenantA(() => service.refund(payment.id, { reason: 'seconde tentative' }, MANAGER)),
      ).rejects.toBeInstanceOf(RefundExceedsCapturedError);

      expect(logs.errors).toContain(
        'remboursement au sort inconnu — réservation conservée, rapprochement requis',
      );
    });

    it.each(['failed', 'canceled'])(
      'relâche la réservation sur un remboursement né %s',
      async (status) => {
        const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
        // Un 2xx n'est pas une acceptation : le conclure `SUCCEEDED`
        // immobiliserait son montant à jamais alors qu'aucun centime n'est sorti.
        stripe.refundStatus = status;

        await expect(
          inTenantA(() => service.refund(payment.id, { reason: 'banque refusante' }, MANAGER)),
        ).rejects.toBeInstanceOf(PaymentProviderRefusedError);

        expect(repository.allRefunds().map((row) => row.status)).toEqual(['FAILED']);
      },
    );

    it('conclut `SUCCEEDED` un remboursement encore `pending` chez le prestataire', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A, amountMinor: 7000 });
      // Le mouvement est engagé, seule sa confirmation tarde — c'est
      // `charge.refunded` qui la portera sur la ligne `payments`.
      stripe.refundStatus = 'pending';

      const refund = await inTenantA(() =>
        service.refund(payment.id, { reason: 'virement en cours' }, MANAGER),
      );

      expect(refund.status).toBe('SUCCEEDED');
    });

    it('inscrit la ligne avant d’appeler — la trace survit à l’échec', async () => {
      const payment = repository.seedPayment({ tenantId: TENANT_A });
      stripe.failWith = new PaymentProviderUnavailableError();

      await inTenantA(() =>
        service.refund(payment.id, { reason: 'panne réseau' }, MANAGER).catch(() => undefined),
      );

      // L'ordre inverse — ordonner puis inscrire — laisserait, sur un arrêt du
      // processus entre les deux, un remboursement sorti que notre cumul
      // ignore, donc rendu une seconde fois au clic suivant.
      expect(repository.allRefunds()).toHaveLength(1);
      expect(repository.allRefunds()[0]?.reason).toBe('panne réseau');
      expect(repository.allRefunds()[0]?.requestedByUserId).toBe(MANAGER);
    });
  });

  describe('la frontière du tenant', () => {
    it('rend introuvable l’encaissement du salon voisin, jamais interdit', async () => {
      const neighbour = repository.seedPayment({ tenantId: TENANT_B, amountMinor: 7000 });

      const refusal = await refusalOf(() =>
        service.refund(neighbour.id, { reason: 'essai' }, MANAGER),
      );

      // 404 et non 403 : un refus qui distingue les deux confirme l'existence
      // de la ressource (tenant-isolation §4).
      expect(refusal).toBeInstanceOf(NotFoundError);
      expect(stripe.refundCommands).toHaveLength(0);
      expect(repository.allRefunds()).toHaveLength(0);
    });

    it('rend le même refus pour l’inconnu et pour le voisin, octet pour octet', async () => {
      const neighbour = repository.seedPayment({ tenantId: TENANT_B });

      const unknown = await refusalOf(() =>
        service.refund('99999999-9999-4999-8999-999999999999', { reason: 'essai' }, MANAGER),
      );
      const foreign = await refusalOf(() =>
        service.refund(neighbour.id, { reason: 'essai' }, MANAGER),
      );

      expect({ message: foreign.message, details: foreign.details }).toEqual({
        message: unknown.message,
        details: unknown.details,
      });
    });
  });

  describe('ce que ce service n’écrit pas — quatrième critère de #63', () => {
    it('ne touche ni le statut de l’encaissement ni son cumul remboursé', () => {
      // La garantie n'est pas qu'on s'abstient : c'est que le dépôt des
      // remboursements n'expose aucune écriture sur `payments`. Le passage de
      // l'encaissement en `REFUNDED` ou `PARTIALLY_REFUNDED` est l'affaire du
      // webhook `charge.refunded`, et de lui seul (payments-stripe §6).
      const port = Object.getOwnPropertyNames(FakeRefundsRepository.prototype);

      expect(port).toEqual(
        expect.arrayContaining(['findRefundable', 'reserve', 'markAccepted', 'markFailed']),
      );
      expect(port.filter((name) => /payment(Status|Refunded)/i.test(name))).toEqual([]);
    });
  });
});
