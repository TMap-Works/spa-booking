import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import { TenantContextService } from '../src/common/tenant/tenant-context.service';
import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { StripeWebhookRepository } from '../src/modules/payments/stripe-webhook.repository';
import { StripeWebhookService } from '../src/modules/payments/stripe-webhook.service';
import type { StripeWebhookEvent } from '../src/modules/payments/stripe-webhook.types';
import { recordingLogger } from '../src/modules/payments/__tests__/webhook.doubles';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';

/**
 * Le traitement d'un webhook **contre un vrai moteur PostgreSQL** — isolation
 * inter-tenant et idempotence.
 *
 * Les suites en mémoire prouvent la mécanique du contrôleur et de la file.
 * Elles ne peuvent rien prouver de ce qui compte ici, parce que ce sont des
 * propriétés de la **base** :
 *
 * 1. **l'idempotence est une contrainte d'unicité**, pas une condition écrite
 *    dans le service. Un double en mémoire rendrait « déjà vu » parce qu'on
 *    l'aurait programmé pour, ce qui ne dit rien de `ON CONFLICT DO NOTHING` ni
 *    de la transaction qui l'entoure ;
 * 2. **la frontière du tenant est tenue par l'extension Prisma**, pas par le
 *    repository. Le seul moyen de le vérifier est de placer deux
 *    établissements dans la même base et de regarder ce qu'une écriture
 *    atteint ;
 * 3. **la transaction annule la marque quand l'effet échoue.** Sans cela, un
 *    incident laisserait un événement marqué traité et jamais appliqué — le
 *    pire des états, puisque Stripe ne le rejouerait plus ;
 * 4. **la marque enregistre ce qui a été appliqué, pas ce qui a été reçu**
 *    (#410). Un événement dont aucune ligne `payments` ne porte la référence
 *    n'en laisse aucune, et son renvoi manuel s'applique — ce qui ne se voit
 *    qu'en comptant les lignes réellement inscrites.
 *
 * ## Le scénario de traversée
 *
 * Il n'est pas celui du protocole habituel de tenant-isolation §6 — « créer
 * chez A, lire chez B par identifiant, attendre 404 » : cette route n'expose
 * aucun identifiant de ressource, et l'appelant n'a pas de tenant. La
 * traversée possible est autre, et elle est plus insidieuse : **un événement
 * dont les métadonnées désignent le voisin**. Signé par Stripe, donc
 * authentique ; et pourtant l'écriture doit atterrir chez le propriétaire réel
 * de l'encaissement, sans qu'une seule ligne du voisin ne bouge.
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre : la suite démarre son propre
 * PostgreSQL 16 et s'y crée une base jetable, migrée puis détruite
 * (`utils/disposable-database.ts`). Ni `DATABASE_URL`, ni `docker compose`, ni
 * `prisma migrate deploy` ne sont des prérequis.
 */

/** Charge utile de création **sans** le tenant — même conversion que les repositories. */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

const PRICE = { amountMinor: 7000, currency: 'EUR' } as const;

/** Ce qu'un établissement de cette suite porte : un rendez-vous et son encaissement. */
interface SeededTenant {
  readonly id: string;
  readonly appointmentId: string;
  readonly paymentId: string;
  readonly paymentIntentId: string;
}

function succeeded(
  paymentIntentId: string,
  overrides: Partial<StripeWebhookEvent> = {},
): StripeWebhookEvent {
  return {
    eventId: `evt_${randomUUID()}`,
    eventType: 'payment_intent.succeeded',
    tenantHint: null,
    fact: { kind: 'payment-succeeded', paymentIntentId, chargeId: `ch_${randomUUID()}` },
    ...overrides,
  };
}

describe('Webhook Stripe — isolation et idempotence contre un vrai PostgreSQL', () => {
  let database: DisposableDatabase | undefined;
  /**
   * La racine non scopée : elle crée les établissements — qui n'ont par
   * définition aucun tenant courant — et **observe** la base sans le filtre dont
   * on teste justement l'effet. Une vérification faite avec le client scopé
   * serait filtrée par ce qu'elle prétend mesurer.
   */
  let prismaUnscoped: PrismaClient;
  let repository: StripeWebhookRepository;
  let service: StripeWebhookService;
  let log: ReturnType<typeof recordingLogger>;

  let a: SeededTenant;
  let b: SeededTenant;

  async function seedTenant(label: string): Promise<SeededTenant> {
    const tenant = await prismaUnscoped.tenant.create({
      data: {
        slug: `w58-${label}-${randomUUID()}`,
        name: `Établissement ${label}`,
        timezone: 'Europe/Paris',
        defaultCurrency: PRICE.currency,
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

    const practitioner = await prismaUnscoped.user.create({
      data: {
        tenantId: tenant.id,
        email: `praticienne-${randomUUID()}@example.test`,
        role: 'STAFF',
        firstName: 'Alix',
        lastName: 'Martin',
      },
    });

    const staff = await prismaUnscoped.staff.create({
      data: { tenantId: tenant.id, userId: practitioner.id, displayName: 'Alix' },
    });

    const service_ = await prismaUnscoped.service.create({
      data: {
        tenantId: tenant.id,
        slug: `massage-${randomUUID().slice(0, 8)}`,
        name: 'Massage 60 min',
        durationMinutes: 60,
        priceAmountMinor: PRICE.amountMinor,
        priceCurrency: PRICE.currency,
      },
    });

    const appointment = await prismaUnscoped.appointment.create({
      data: {
        tenantId: tenant.id,
        clientId: client.id,
        staffId: staff.id,
        serviceId: service_.id,
        startsAt: new Date('2026-10-01T09:00:00Z'),
        endsAt: new Date('2026-10-01T10:00:00Z'),
        priceAmountMinor: PRICE.amountMinor,
        priceCurrency: PRICE.currency,
      },
    });

    const paymentIntentId = `pi_${randomUUID()}`;
    const payment = await prismaUnscoped.payment.create({
      data: {
        tenantId: tenant.id,
        appointmentId: appointment.id,
        amountMinor: PRICE.amountMinor,
        currency: PRICE.currency,
        method: 'CARD',
        providerPaymentIntentId: paymentIntentId,
      },
    });

    return {
      id: tenant.id,
      appointmentId: appointment.id,
      paymentId: payment.id,
      paymentIntentId,
    };
  }

  beforeAll(async () => {
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });
    await prismaUnscoped.$connect();
    // Une requête réelle : elle prouve que le schéma est en place. Une base
    // joignable mais vide échouerait bien plus loin, sur un cas d'isolation, où
    // l'échec se lirait comme un défaut du traitement.
    await prismaUnscoped.tenant.count();

    // Le client scopé est construit **par la fabrique de l'application** : c'est
    // l'extension que `DatabaseModule` applique réellement qui est exercée.
    const scoped = createScopedPrismaClient(prismaUnscoped);
    repository = new StripeWebhookRepository(scoped, prismaUnscoped);
    log = recordingLogger();
    service = new StripeWebhookService(repository, new TenantContextService(), log.logger);

    a = await seedTenant('a');
    b = await seedTenant('b');
  });

  afterAll(async () => {
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  const paymentOf = async (tenant: SeededTenant) =>
    prismaUnscoped.payment.findUniqueOrThrow({ where: { id: tenant.paymentId } });

  const appointmentOf = async (tenant: SeededTenant) =>
    prismaUnscoped.appointment.findUniqueOrThrow({ where: { id: tenant.appointmentId } });

  describe('frontière entre établissements', () => {
    it('encaisse et confirme chez le propriétaire, sans toucher au voisin', async () => {
      await service.process(succeeded(a.paymentIntentId));

      expect(await paymentOf(a)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await appointmentOf(a)).toMatchObject({ status: 'CONFIRMED' });

      // Le voisin est intact, dans les deux tables.
      expect(await paymentOf(b)).toMatchObject({ status: 'PENDING', capturedAt: null });
      expect(await appointmentOf(b)).toMatchObject({ status: 'PENDING' });
    });

    it('ignore une métadonnée qui désigne le voisin', async () => {
      // Le scénario de traversée propre à cette route : un événement signé dont
      // les métadonnées annoncent l'autre établissement. La base fait autorité —
      // l'écriture reste chez le propriétaire réel de l'encaissement.
      const event = succeeded(b.paymentIntentId, { tenantHint: a.id });

      await service.process(event);

      expect(await paymentOf(b)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await appointmentOf(b)).toMatchObject({ status: 'CONFIRMED' });

      // Et la marque d'idempotence est inscrite chez `b`, pas chez `a`.
      const marks = await prismaUnscoped.processedWebhookEvent.findMany({
        where: { eventId: event.eventId },
        select: { tenantId: true },
      });
      expect(marks).toEqual([{ tenantId: b.id }]);
    });

    it('n’écrit rien quand aucun établissement ne se résout', async () => {
      const before = await prismaUnscoped.processedWebhookEvent.count();

      await service.process(succeeded(`pi_${randomUUID()}`));

      expect(await prismaUnscoped.processedWebhookEvent.count()).toBe(before);
      expect(log.warnings).toContain(
        'stripe webhook: établissement non résolu, événement ignoré',
      );
    });
  });

  describe('idempotence', () => {
    it('n’applique un rejeu qu’une fois — c’est l’unique qui tranche', async () => {
      const event = succeeded(a.paymentIntentId);

      await service.process(event);
      const captured = (await paymentOf(a)).capturedAt;

      await service.process(event);

      // `captured_at` n'a pas bougé : le second passage n'a rien réécrit.
      expect((await paymentOf(a)).capturedAt).toEqual(captured);
      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });

    it('annule la marque quand l’effet échoue — la transaction fait bloc', async () => {
      // Un remboursement supérieur à l'encaissement viole
      // `payments_refunded_amount_minor_check`. Ce qui est vérifié n'est pas la
      // contrainte : c'est que la marque d'idempotence disparaît avec l'effet.
      // Sans transaction commune, l'événement resterait marqué traité et jamais
      // appliqué — et Stripe ne le rejouerait plus.
      const event: StripeWebhookEvent = {
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.refunded',
        tenantHint: null,
        fact: {
          kind: 'charge-refunded',
          paymentIntentId: a.paymentIntentId,
          chargeId: 'ch_trop',
          refundedAmountMinor: PRICE.amountMinor * 10,
          fullyRefunded: false,
        },
      };

      // La borne est posée en base, pas dans le code : c'est PostgreSQL qui
      // refuse, et Prisma remonte le refus tel quel — sans code d'erreur dédié,
      // une violation de `CHECK` n'étant pas classée par le client.
      await expect(service.process(event)).rejects.toThrow(
        /check constraint|refunded_amount_minor/i,
      );

      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(0);
      expect(await paymentOf(a)).toMatchObject({ refundedAmountMinor: 0 });
    });

    it('ne marque rien quand aucun encaissement ne porte la référence (#410)', async () => {
      // Le point de conception que #58 avait laissé en suspens. `PaymentsService`
      // crée l'intention chez Stripe **avant** d'inscrire la ligne `payments` :
      // une livraison peut donc citer un `pi_…` dont nous n'avons encore aucune
      // trace. La métadonnée résout tout de même l'établissement, si bien que le
      // traitement va jusqu'au bout — et marquait l'événement traité pour rien.
      const before = await prismaUnscoped.processedWebhookEvent.count();
      const event = succeeded(`pi_${randomUUID()}`, { tenantHint: a.id });

      await service.process(event);

      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(0);
      expect(await prismaUnscoped.processedWebhookEvent.count()).toBe(before);
      expect(log.warnings).toContain(
        'stripe webhook: aucun encaissement ne porte cette référence — rien écrit, renvoi possible',
      );
    });

    it('applique le renvoi de cet événement une fois la ligne inscrite (#410)', async () => {
      // La conséquence utile, et la seule qui compte pour l'exploitation : le
      // renvoi depuis le tableau de bord Stripe — unique recours, la file en
      // mémoire n'ayant aucune reprise automatique — encaisse pour de bon.
      // Marquer la première livraison l'aurait avalé comme un rejeu, et le
      // rendez-vous ne serait jamais passé en `CONFIRMED`.
      const late = await seedTenant('tardif');
      const reference = `pi_${randomUUID()}`;
      const event = succeeded(reference, { tenantHint: late.id });

      await service.process(event);
      expect(await paymentOf(late)).toMatchObject({ status: 'PENDING' });

      // La ligne arrive après coup : c'est ce que fait `recordCardIntent` quand
      // l'écriture a été retardée, ou reprise à la main après un incident.
      await prismaUnscoped.payment.update({
        where: { id: late.paymentId },
        data: { providerPaymentIntentId: reference },
      });

      await service.process(event);

      expect(await paymentOf(late)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await appointmentOf(late)).toMatchObject({ status: 'CONFIRMED' });
      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });

    it('marque un litige orphelin — son effet est l’alerte, pas une écriture (#410)', async () => {
      // La borne de la règle : un litige n'a par nature aucune ligne à toucher
      // (payments-stripe §6). Le priver de marque ferait ré-alerter l'équipe à
      // chaque livraison.
      const event: StripeWebhookEvent = {
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.dispute.created',
        tenantHint: a.id,
        fact: {
          kind: 'dispute-opened',
          paymentIntentId: `pi_${randomUUID()}`,
          chargeId: null,
          disputeId: `dp_${randomUUID()}`,
        },
      };

      await service.process(event);

      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });

    it('marque un refus arrivé après le succès — la ligne existe, le garde décline (#410)', async () => {
      // L'autre borne, symétrique. `paymentsTouched` vaut zéro parce que le
      // filtre de statut a refusé d'écrire, pas parce que l'événement n'a pas de
      // destinataire. Annuler ici ferait rejouer sans fin un événement dont la
      // conduite juste est précisément de ne rien écrire.
      const settled = await seedTenant('refus-tardif');
      await service.process(succeeded(settled.paymentIntentId));

      const event: StripeWebhookEvent = {
        eventId: `evt_${randomUUID()}`,
        eventType: 'payment_intent.payment_failed',
        tenantHint: null,
        fact: { kind: 'payment-failed', paymentIntentId: settled.paymentIntentId },
      };

      await service.process(event);

      expect(await paymentOf(settled)).toMatchObject({ status: 'SUCCEEDED' });
      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });

    it('sérialise deux livraisons concurrentes du même événement', async () => {
      // Stripe n'exclut pas deux livraisons simultanées. L'une passe, l'autre
      // attend sur l'unique et repart sans rien appliquer.
      const event = succeeded(b.paymentIntentId, { eventId: `evt_${randomUUID()}` });

      const outcomes = await Promise.all([service.process(event), service.process(event)]);

      expect(outcomes).toHaveLength(2);
      expect(
        await prismaUnscoped.processedWebhookEvent.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });
  });

  describe('cycle de vie du rendez-vous', () => {
    it('ne ressuscite pas un rendez-vous annulé', async () => {
      // Le paiement aboutit après une annulation : l'encaissement est enregistré
      // — il faudra le rembourser — mais le créneau ne se reprend pas tout seul.
      const cancelled = await seedTenant('annule');
      await prismaUnscoped.appointment.update({
        where: { id: cancelled.appointmentId },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'CLIENT' },
      });

      await service.process(succeeded(cancelled.paymentIntentId));

      expect(await paymentOf(cancelled)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await appointmentOf(cancelled)).toMatchObject({ status: 'CANCELLED' });
    });

    it('n’écrase pas un encaissement remboursé par une livraison en retard', async () => {
      const refunded = await seedTenant('rembourse');
      await prismaUnscoped.payment.update({
        where: { id: refunded.paymentId },
        data: { status: 'REFUNDED', refundedAmountMinor: PRICE.amountMinor },
      });

      await service.process(succeeded(refunded.paymentIntentId));

      expect(await paymentOf(refunded)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountMinor: PRICE.amountMinor,
      });
      // Et le rendez-vous ne se confirme pas non plus. Le filtre de statut de
      // l'encaissement vaut pour les **deux** écritures : confirmer un créneau
      // sur un paiement déjà rendu le bloquerait pour rien. Stripe ne garantit
      // ni l'ordre des livraisons ni leur traitement séquentiel, un
      // `charge.refunded` appliqué avant son `payment_intent.succeeded` n'est
      // donc pas un cas d'école.
      expect(await appointmentOf(refunded)).toMatchObject({ status: 'PENDING' });
    });

    it('inscrit un remboursement total et le statut qui va avec', async () => {
      const target = await seedTenant('total');
      await service.process(succeeded(target.paymentIntentId));

      await service.process({
        eventId: `evt_${randomUUID()}`,
        eventType: 'charge.refunded',
        tenantHint: null,
        fact: {
          kind: 'charge-refunded',
          paymentIntentId: target.paymentIntentId,
          chargeId: 'ch_total',
          refundedAmountMinor: PRICE.amountMinor,
          fullyRefunded: true,
        },
      });

      expect(await paymentOf(target)).toMatchObject({
        status: 'REFUNDED',
        refundedAmountMinor: PRICE.amountMinor,
        providerChargeId: 'ch_total',
      });
    });
  });

  describe('type de création', () => {
    it('laisse l’extension poser le tenant, jamais le repository', () => {
      // Le témoin de la conversion : `withScopedTenant` retire `tenantId` du type
      // d'entrée. Si le repository le fournissait, l'extension l'écraserait — et
      // s'il ne le fournissait pas sans extension, la colonne `NOT NULL` ferait
      // échouer l'insertion. Les deux moitiés du filet sont en place.
      const data = withScopedTenant<Prisma.ProcessedWebhookEventUncheckedCreateInput>({
        eventId: 'evt_1',
        eventType: 'payment_intent.succeeded',
      });

      expect(Object.keys(data)).toEqual(['eventId', 'eventType']);
    });
  });
});
