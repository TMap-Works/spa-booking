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

/**
 * Le TTL du bail que cette suite se donne (#523).
 *
 * Sa valeur n'a aucune importance, et c'est tout l'intérêt : la péremption
 * s'obtient en avançant l'horloge de `LEASE_MS + 1`, jamais en attendant que
 * `LEASE_MS` s'écoule. Une durée d'une seconde et une durée d'une heure
 * produiraient donc exactement le même temps d'exécution — et le même verdict.
 *
 * Elle est prise loin du calendrier de production (60 s) pour qu'aucun lecteur
 * ne la confonde avec lui : ce qui est éprouvé ici est la mécanique du bail, pas
 * le réglage qu'`DEFAULT_SWEEP_SCHEDULE` en fait.
 */
const LEASE_MS = 30_000;

/**
 * L'horloge que la suite pilote — la moitié gauche du prédicat de bail (#523).
 *
 * Elle est **figée** : deux lectures sans `advance` rendent le même instant.
 * C'est la propriété qui rend les cas de reprise décidables, parce qu'elle
 * supprime la seule chose dont ils dépendaient encore — le temps que la machine
 * met à passer d'une ligne à la suivante.
 *
 * Elle rend un `Date` neuf à chaque lecture : l'appelant qui le mute — Prisma
 * n'en fait rien, mais rien ne l'en empêcherait — ne déplace pas l'horloge de
 * tout le monde.
 */
class SteerableClock {
  private instant = new Date();

  public readonly now = (): Date => new Date(this.instant);

  /** Repart de l'instant réel, au début de chaque cas. */
  public reset(): void {
    this.instant = new Date();
  }

  /** Fait passer le temps sans en laisser passer — aucun `sleep`, jamais. */
  public advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

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
  let tenants: TenantContextService;
  let log: ReturnType<typeof recordingLogger>;
  /** L'horloge injectée au dépôt — c'est la suite qui décide de l'heure (#523). */
  const clock = new SteerableClock();

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
    repository = new StripeWebhookRepository(scoped, prismaUnscoped, clock.now);
    log = recordingLogger();
    tenants = new TenantContextService();
    service = new StripeWebhookService(repository, tenants, log.logger);

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
      // Le témoin d'intégrité est un établissement **à ce cas** (#555). `b` est
      // partagé, et d'autres cas de cette suite l'encaissent délibérément : ce
      // qu'on lirait alors chez lui ne dirait plus rien de la frontière, mais de
      // l'ordre d'exécution. Un voisin que personne d'autre ne touche est le
      // seul témoin dont le `PENDING` prouve quelque chose.
      const voisin = await seedTenant('voisin-intact');

      await service.process(succeeded(a.paymentIntentId));

      expect(await paymentOf(a)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await appointmentOf(a)).toMatchObject({ status: 'CONFIRMED' });

      // Le voisin est intact, dans les deux tables.
      expect(await paymentOf(voisin)).toMatchObject({ status: 'PENDING', capturedAt: null });
      expect(await appointmentOf(voisin)).toMatchObject({ status: 'PENDING' });
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

    it('ne résout pas une indication qui ne désigne aucun établissement', async () => {
      // La confrontation que `tenantHint` annonce depuis le premier jour. Elle
      // ne coûtait rien tant que le tenant résolu n'ouvrait qu'une portée de
      // lecture ; depuis #409 il sert à **écrire** la livraison, et un
      // établissement inexistant ferait violer la clé étrangère pendant la
      // requête HTTP — 500 rendu, et Stripe redélivrant trois jours durant un
      // événement que rien ne rendra jamais inscriptible.
      const absent = randomUUID();

      await expect(
        service.resolveTenant(succeeded(`pi_${randomUUID()}`, { tenantHint: absent })),
      ).resolves.toBeNull();
    });

    it('ne résout pas une indication qui n’est même pas un identifiant', async () => {
      // La métadonnée est recopiée telle quelle depuis une intention que
      // n'importe qui peut créer dans le tableau de bord Stripe. PostgreSQL
      // refuse la comparaison avec un `uuid` — ce refus vaut « introuvable », il
      // ne doit pas remonter comme une panne.
      await expect(
        service.resolveTenant(succeeded(`pi_${randomUUID()}`, { tenantHint: 'pas-un-uuid' })),
      ).resolves.toBeNull();
    });

    it('résout une indication qui désigne un établissement réel', async () => {
      // L'autre moitié : la confrontation ne doit pas rejeter ce qui est
      // légitime. C'est ce cas-là qui rattrape un `pi_…` créé chez Stripe avant
      // que sa ligne `payments` n'existe.
      await expect(
        service.resolveTenant(succeeded(`pi_${randomUUID()}`, { tenantHint: a.id })),
      ).resolves.toBe(a.id);
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

  /**
   * La file durable, contre le moteur — #409.
   *
   * Les cas en mémoire de `__tests__/stripe-webhook.queue.spec.ts` prouvent
   * l'ordonnancement : le réessai borné, la file d'attente morte, la chaîne par
   * encaissement. Ils ne peuvent rien prouver de ce qui suit, parce que ce sont
   * des propriétés de la **base** :
   *
   * 1. **la ligne est écrite sous l'établissement de la portée**, par
   *    l'extension Prisma — le dépôt ne fournit jamais `tenant_id` ;
   * 2. **l'unique `(tenant_id, event_id)`** est ce qui distingue une
   *    redélivrance d'un second travail. Un double le simulerait ; seule la
   *    contrainte le décide sous concurrence ;
   * 3. **la prise est un `UPDATE` conditionnel** : de deux instances qui
   *    reprennent la même livraison orpheline, une seule voit `count = 1`.
   *    C'est la base qui tranche, pas une fenêtre de code (ADR 0002).
   * 4. **l'échéance d'une livraison est comparable à l'horloge du balayage**
   *    (#555). Le prédicat de reprise confronte `next_attempt_at` au `now` que
   *    l'appelant donne : si les deux ne viennent pas de la même horloge, une
   *    livraison inscrite à l'instant peut être jugée « pas encore échue ».
   *
   * ## Chaque cas repart d'une file vide (#555)
   *
   * Le `beforeEach` ci-dessous vide `stripe_webhook_deliveries`. Ce n'est pas de
   * l'hygiène décorative : sans lui, le verdict d'un cas dépend de ce que les
   * précédents ont laissé — l'ordre du lot que `claimAbandonedDeliveries` rend
   * est celui de `created_at`, et il est borné par `batchSize`. Cette
   * dépendance n'a jamais fait rougir la suite (le relevé de #555 montre au plus
   * quinze lignes et **un seul** candidat par balayage, très loin du plafond de
   * vingt), mais elle rendait chaque cas illisible seul : ce qu'il prouve ne
   * doit rien devoir à ce qui l'a précédé.
   *
   * ## Et le bail est **piloté**, jamais subi (#523)
   *
   * Voilà la cause de l'instabilité, écrite là où elle se lit : les trois cas de
   * reprise ci-dessous ne rougissaient pas parce que le moteur de file avait
   * tort, mais parce que leur verdict se jouait sur **l'écart entre deux
   * horloges** — celle qui pose le bail et celle qui le compare — et que cet
   * écart dépend de la charge de la machine. #568 a ramené les deux colonnes de
   * l'inscription sur l'horloge du processus, ce qui a supprimé l'écart ; il
   * restait que l'instant était *subi*, et qu'un cas ne pouvait périmer un bail
   * qu'en espérant que la machine irait assez vite.
   *
   * Cette suite injecte donc son horloge (`WEBHOOK_CLOCK`) et la déplace
   * elle-même : {@link LEASE_MS} est le TTL du bail, `expireLease()` avance
   * l'horloge juste au-delà. Le bail périme parce qu'on l'a décidé, à la
   * milliseconde près, et le verdict ne doit plus rien à l'ordonnanceur du
   * système d'exploitation. **Aucune attente n'a été ajoutée** : faire passer le
   * temps sans en laisser passer est très exactement ce qu'un `sleep` aurait
   * masqué au lieu de corriger.
   */
  describe('file durable des livraisons (#409)', () => {
    const spool = async (tenant: SeededTenant, event: StripeWebhookEvent) =>
      tenants.runWithTenant(tenant.id, async () =>
        repository.spool({ event, serializationKey: `pi_${event.eventId}` }),
      );

    const claimNow = async (leaseMs = LEASE_MS) =>
      repository.claimAbandonedDeliveries({ now: clock.now(), leaseMs, batchSize: 20 });

    /**
     * Périme le bail de tout ce qui est en file — ce qu'un `SIGKILL` laisse
     * derrière lui.
     *
     * L'horloge avance d'un TTL et d'une milliseconde ; rien n'attend. La
     * livraison devient donc reprenable par les **deux** moitiés du prédicat
     * d'un seul geste : son bail est périmé (`claimed_at < now - leaseMs`) et
     * son échéance est passée (`next_attempt_at <= now`), puisque l'inscription
     * a posé les deux colonnes au même instant.
     */
    const expireLease = () => {
      clock.advance(LEASE_MS + 1);
    };

    beforeEach(async () => {
      // `deleteMany` nu, et sans danger : la base est jetable et n'appartient
      // qu'à ce fichier (`utils/disposable-database.ts`). Les autres blocs de
      // cette suite n'inscrivent aucune livraison — ils passent par
      // `service.process`, qui n'a pas de file.
      await prismaUnscoped.stripeWebhookDelivery.deleteMany({});
      // L'horloge repart d'une origine propre : ce qu'un cas prouve ne doit rien
      // devoir au temps qu'un autre a fait passer.
      clock.reset();
    });

    it('inscrit une livraison à l’instant exact de l’horloge de la file', async () => {
      // Le piège que #555 a mis au jour, et la seule raison pour laquelle les
      // trois cas de reprise ci-dessous rougissaient une fois sur deux.
      //
      // `next_attempt_at` avait pour défaut le `now()` du **serveur** ; le
      // balayage le compare au `now` que son appelant lui donne. Entre les deux,
      // l'écart mesuré allait de 2 à 11 ms — et une livraison inscrite à
      // l'instant se retrouvait « pas encore échue » dès que l'écart passait du
      // mauvais côté.
      //
      // L'égalité est stricte, et c'est ce que l'horloge injectée permet
      // d'exiger (#523) : les deux colonnes portent l'instant que la file a lu,
      // et rien qui vienne du moteur. Une seule des deux qui retomberait sur un
      // `now()` PostgreSQL ferait échouer ce cas au lieu d'aller déstabiliser
      // les suivants.
      const spooledAt = clock.now();
      const delivery = await spool(a, succeeded(a.paymentIntentId));

      const row = await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery?.id ?? '' },
        select: { nextAttemptAt: true, claimedAt: true },
      });

      expect(row.claimedAt?.getTime()).toBe(spooledAt.getTime());
      expect(row.nextAttemptAt.getTime()).toBe(spooledAt.getTime());
    });

    it('inscrit la livraison sous l’établissement de la portée, jamais sous un autre', async () => {
      // Le dépôt ne fournit pas `tenant_id` — c'est l'extension qui le pose
      // depuis le contexte. Un événement dont la métadonnée désignerait le
      // voisin n'y changerait rien : c'est la portée ouverte qui décide.
      const event = succeeded(a.paymentIntentId, { tenantHint: b.id });

      const delivery = await spool(a, event);

      expect(delivery).not.toBeNull();
      expect(
        await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery?.id ?? '' },
          select: { tenantId: true, status: true, attempts: true, serializationKey: true },
        }),
      ).toMatchObject({ tenantId: a.id, status: 'PENDING', attempts: 0 });
    });

    it('ne conserve du payload que l’événement réduit — aucune donnée de carte', async () => {
      // La colonne porte ce que `readWebhookEvent` a produit, et ce type ne
      // déclare aucun champ de carte (payments-stripe §1). Ce qui n'est pas
      // déclaré n'est pas recopié, et ce qui n'est pas recopié ne peut pas être
      // conservé.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);

      const row = await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery?.id ?? '' },
        select: { payload: true },
      });

      expect(Object.keys(row.payload as object).sort()).toEqual([
        'eventId',
        'eventType',
        'fact',
        'tenantHint',
      ]);
    });

    it('rend null sur une redélivrance — l’unique tranche', async () => {
      const event = succeeded(a.paymentIntentId);

      const first = await spool(a, event);
      const second = await spool(a, event);

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(
        await prismaUnscoped.stripeWebhookDelivery.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
    });

    it('laisse deux établissements inscrire le même identifiant d’événement', async () => {
      // L'unique est composite. Deux établissements ne se bloquent pas l'un
      // l'autre sur un `evt_…` que Stripe n'attribuerait de toute façon jamais
      // deux fois — mais la frontière doit valoir même sur l'improbable.
      const event = succeeded(a.paymentIntentId);

      expect(await spool(a, event)).not.toBeNull();
      expect(await spool(b, event)).not.toBeNull();
    });

    it('ne reprend pas une livraison dont le bail est frais', async () => {
      // L'instance qui a inscrit la livraison la traite : la reprendre ferait
      // partir deux traitements de front.
      //
      // L'horloge n'a pas bougé depuis l'inscription : le bail est frais **par
      // construction**, et non parce que ce cas se serait exécuté en moins d'un
      // TTL (#523). C'est l'exact complément du cas suivant, à un
      // `expireLease()` près.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);

      expect((await claimNow()).map((taken) => taken.id)).not.toContain(delivery?.id);
    });

    it('reprend une livraison dont le bail est périmé, et la relit intacte', async () => {
      // Le troisième critère du ticket, contre le moteur : le processus est
      // mort, la ligne est restée `PENDING`, son bail a vieilli — et n'importe
      // quelle instance la reprend sans savoir qu'une autre est morte.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);
      expireLease();

      const claimed = await claimNow();
      const taken = claimed.find((candidate) => candidate.id === delivery?.id);

      expect(taken).toBeDefined();
      expect(taken?.tenantId).toBe(a.id);
      // Le `payload` a fait l'aller-retour par JSON : l'événement relu est
      // exactement celui qui a été inscrit.
      expect(taken?.event).toEqual(event);
    });

    it('ne laisse qu’une seule prise gagner sur deux balayages concurrents', async () => {
      // Deux instances ECS balaient en même temps. Sous `READ COMMITTED`,
      // PostgreSQL réévalue le prédicat après avoir pris le verrou de ligne :
      // une seule voit `count = 1`.
      //
      // Les deux balayages partagent l'horloge de la suite, donc le **même**
      // `now` : ce qui les départage est le verrou de ligne, jamais l'écart de
      // quelques millisecondes qui séparait autrefois leurs deux `new Date()`.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);
      expireLease();

      const [left, right] = await Promise.all([claimNow(), claimNow()]);
      const winners = [...left, ...right].filter((taken) => taken.id === delivery?.id);

      expect(winners).toHaveLength(1);
    });

    it('exclut du balayage une livraison enterrée', async () => {
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);
      await tenants.runWithTenant(a.id, async () =>
        repository.deadLetterDelivery(delivery?.id ?? '', {
          attempts: 4,
          lastError: 'Error: base injoignable',
        }),
      );

      expect(
        await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery?.id ?? '' },
          select: { status: true, claimedAt: true, lastError: true },
        }),
      ).toMatchObject({ status: 'DEAD', claimedAt: null });
      expect((await claimNow()).map((taken) => taken.id)).not.toContain(delivery?.id);
    });

    it('ressuscite une livraison enterrée quand Stripe la redélivre', async () => {
      // La file d'attente morte alerte « intervention humaine requise », et le
      // seul geste que cette alerte appelle est le renvoi de l'événement depuis
      // le tableau de bord Stripe. L'unique `(tenant_id, event_id)` avalerait ce
      // renvoi comme un rejeu si la ligne morte n'était pas remise au travail :
      // l'encaissement resterait `PENDING`, et l'alerte demanderait une action
      // qu'aucun chemin n'exécute.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);
      await tenants.runWithTenant(a.id, async () =>
        repository.deadLetterDelivery(delivery?.id ?? '', {
          attempts: 4,
          lastError: 'Error: base injoignable',
        }),
      );

      const revived = await spool(a, event);

      // La même ligne, remise à zéro — jamais une seconde.
      expect(revived?.id).toBe(delivery?.id);
      expect(revived?.attempts).toBe(0);
      expect(
        await prismaUnscoped.stripeWebhookDelivery.count({ where: { eventId: event.eventId } }),
      ).toBe(1);
      expect(
        await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery?.id ?? '' },
          select: { status: true, attempts: true, lastError: true },
        }),
      ).toMatchObject({ status: 'PENDING', attempts: 0, lastError: null });
    });

    it('ne ressuscite jamais la livraison enterrée d’un autre établissement', async () => {
      // La résurrection passe par le client scopé : une portée ouverte sur le
      // voisin ne voit pas la ligne, et n'a donc rien à remettre au travail.
      const event = succeeded(a.paymentIntentId);
      const delivery = await spool(a, event);
      await tenants.runWithTenant(a.id, async () =>
        repository.deadLetterDelivery(delivery?.id ?? '', {
          attempts: 4,
          lastError: 'Error: base injoignable',
        }),
      );

      // Chez `b`, l'unique ne s'oppose à rien : c'est une inscription neuve.
      expect(await spool(b, event)).not.toBeNull();
      expect(
        await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery?.id ?? '' },
          select: { status: true },
        }),
      ).toMatchObject({ status: 'DEAD' });
    });

    it('enterre sur place une ligne dont le payload ne se relit plus', async () => {
      // Le seul scénario réaliste : une ligne écrite par une version antérieure
      // du code. La rendre ferait tomber le traitement à chaque tour ; la
      // laisser telle quelle la ferait reprendre indéfiniment.
      const delivery = await spool(a, succeeded(a.paymentIntentId));
      await prismaUnscoped.stripeWebhookDelivery.update({
        where: { id: delivery?.id ?? '' },
        data: { payload: { forme: 'inconnue' } },
      });
      expireLease();

      expect((await claimNow()).map((taken) => taken.id)).not.toContain(delivery?.id);
      expect(
        await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
          where: { id: delivery?.id ?? '' },
          select: { status: true, claimedAt: true },
        }),
      ).toMatchObject({ status: 'DEAD', claimedAt: null });
    });

    it('replanifie sans relâcher le bail, et le repose depuis la même horloge', async () => {
      // Cette instance tient toujours la livraison et va la reprendre après le
      // délai. Relâcher le bail ferait partir une seconde tentative de front.
      const delivery = await spool(a, succeeded(a.paymentIntentId));
      // Le temps passe entre l'inscription et l'échec : c'est ce qui rend
      // observable que le bail est **reposé** et non laissé tel quel (#523).
      clock.advance(1_000);
      const rescheduledAt = clock.now();
      const nextAttemptAt = new Date(rescheduledAt.getTime() + 5_000);

      await tenants.runWithTenant(a.id, async () =>
        repository.rescheduleDelivery(delivery?.id ?? '', {
          attempts: 1,
          nextAttemptAt,
          lastError: 'Error: interblocage',
        }),
      );

      const row = await prismaUnscoped.stripeWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery?.id ?? '' },
        select: { attempts: true, nextAttemptAt: true, claimedAt: true, status: true },
      });
      expect(row).toMatchObject({ attempts: 1, status: 'PENDING' });
      expect(row.claimedAt?.getTime()).toBe(rescheduledAt.getTime());
      expect(row.nextAttemptAt.getTime()).toBe(nextAttemptAt.getTime());
    });

    it('ne reprend pas une livraison dont l’échéance n’est pas venue', async () => {
      const delivery = await spool(a, succeeded(a.paymentIntentId));
      // Bail relâché — donc prenable de ce côté-là — mais échéance dans le
      // futur de l'horloge de la file : c'est bien `next_attempt_at` seul qui
      // exclut la ligne, et le TTL n'y est pour rien.
      await prismaUnscoped.stripeWebhookDelivery.update({
        where: { id: delivery?.id ?? '' },
        data: { nextAttemptAt: new Date(clock.now().getTime() + 60_000), claimedAt: null },
      });

      expect((await claimNow()).map((taken) => taken.id)).not.toContain(delivery?.id);
    });

    it('efface la ligne quand la livraison a abouti', async () => {
      const delivery = await spool(a, succeeded(a.paymentIntentId));

      await tenants.runWithTenant(a.id, async () =>
        repository.completeDelivery(delivery?.id ?? ''),
      );

      expect(
        await prismaUnscoped.stripeWebhookDelivery.count({ where: { id: delivery?.id ?? '' } }),
      ).toBe(0);
    });

    it('n’efface jamais la ligne d’un autre établissement', async () => {
      // La frontière tenue par l'extension : `completeDelivery` est un
      // `deleteMany` scopé, et une portée ouverte sur le voisin n'atteint rien.
      const delivery = await spool(a, succeeded(a.paymentIntentId));

      await tenants.runWithTenant(b.id, async () =>
        repository.completeDelivery(delivery?.id ?? ''),
      );

      expect(
        await prismaUnscoped.stripeWebhookDelivery.count({ where: { id: delivery?.id ?? '' } }),
      ).toBe(1);
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
