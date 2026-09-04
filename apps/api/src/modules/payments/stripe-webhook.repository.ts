import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ITXClientDenyList } from '@prisma/client/runtime/library';

import {
  PRISMA,
  PRISMA_UNSCOPED,
  type ScopedPrismaClient,
  type UnscopedPrismaClient,
} from '../../infrastructure/database/prisma-clients';
import type { StripeWebhookEvent, WebhookFact } from './stripe-webhook.types';

/**
 * Accès Prisma du point d'entrée des webhooks — le seul endroit du module qui
 * connaisse le schéma (api-module §2).
 *
 * Il porte deux responsabilités que rien d'autre ne peut porter à sa place.
 *
 * ## 1. Résoudre l'établissement, avant toute portée de tenant
 *
 * Un webhook Stripe n'arrive avec aucun jeton et sur aucun slug : il n'a ni
 * l'une ni l'autre des deux entrées de tenant décrites par
 * `tenant-scope.middleware.ts`. Il arrive avec `pi_…`, et le schéma dit
 * explicitement ce qu'il faut en faire — « `provider_payment_intent_id` est
 * unique **par tenant** […] le module `payments` devra donc résoudre le tenant
 * avant de chercher ».
 *
 * C'est la seule lecture légitimement inter-tenant de ce module, et elle passe
 * par `prismaUnscoped` avec les trois obligations de tenant-isolation §3 : le
 * nom, la justification, et un filtre écrit à la main. Elle ne rend **que** le
 * `tenant_id` — aucune ligne, aucun montant, aucune donnée personnelle ne sort
 * de cette porte.
 *
 * ## 2. Écrire l'effet et sa marque d'idempotence dans une seule transaction
 *
 * `processed_webhook_events` n'est pas un journal posé à côté du traitement :
 * c'est ce qui le rend rejouable sans dommage. La ligne s'insère **avant**
 * l'effet et **dans la même transaction**, si bien qu'un échec de l'effet
 * annule aussi la marque, et qu'une seconde livraison concurrente attend sur
 * l'unique plutôt que d'appliquer l'effet une seconde fois.
 *
 * `createMany({ skipDuplicates })` plutôt qu'un `create` sous `try` : un
 * `INSERT` en conflit avorte la transaction PostgreSQL entière, et tout ce qui
 * suivrait échouerait sur « current transaction is aborted ». `ON CONFLICT DO
 * NOTHING` — ce que `skipDuplicates` produit — prend le même verrou, attend la
 * concurrente de la même façon, et rend un compte de zéro sans rien casser.
 */

/**
 * Le client tel que `$transaction` le passe à son rappel — le client étendu
 * privé de ce qu'on ne peut pas appeler dans une transaction. La forme est
 * celle que Prisma documente ; l'écrire à la main dériverait du client généré.
 */
type ScopedTransaction = Omit<ScopedPrismaClient, ITXClientDenyList>;

/**
 * Charge utile de création **sans** le tenant.
 *
 * Même conversion, et pour la même raison, que dans `appointments.repository.ts` :
 * le type généré exige `tenantId` — la colonne est `NOT NULL` — alors que le
 * repository ne doit justement pas le fournir. C'est l'extension de scoping qui
 * le pose depuis le contexte, et qui écrase ce qui s'y trouverait.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

/** Ce qu'une livraison a réellement produit — matière du journal, et rien d'autre. */
export interface WebhookApplication {
  /** `false` quand l'événement avait déjà été traité : Stripe l'a rejoué. */
  readonly applied: boolean;
  /** Nombre de lignes `payments` touchées — 0 si l'intention nous est inconnue. */
  readonly paymentsTouched: number;
  /** Nombre de rendez-vous passés en `CONFIRMED` — 0 ou 1. */
  readonly appointmentsConfirmed: number;
}

const ALREADY_PROCESSED: WebhookApplication = {
  applied: false,
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

@Injectable()
export class StripeWebhookRepository {
  public constructor(
    @Inject(PRISMA) private readonly prisma: ScopedPrismaClient,
    // Résolution de l'établissement **avant** qu'une portée de tenant existe :
    // un webhook n'arrive ni avec un jeton ni avec un slug, seulement avec la
    // référence opaque de l'intention. Le filtre par référence est écrit à la
    // main ci-dessous, et la projection est réduite au seul `tenant_id`
    // (tenant-isolation §3).
    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,
  ) {}

  /**
   * L'établissement propriétaire de l'encaissement désigné, ou `null`.
   *
   * Interrogé **avant** l'indication portée par les métadonnées, et c'est
   * délibéré : la base est ce qui fait autorité sur nos propres lignes. Une
   * métadonnée qui désignerait un autre établissement que celui de la ligne
   * ferait écrire la marque d'idempotence sous le mauvais tenant, et laisserait
   * l'encaissement réel sans effet — un désaccord silencieux, dans le sens le
   * plus difficile à diagnostiquer.
   */
  public async findTenantIdByProviderReference(reference: {
    readonly paymentIntentId: string | null;
    readonly chargeId: string | null;
  }): Promise<string | null> {
    const candidates: Prisma.PaymentWhereInput[] = [];
    if (reference.paymentIntentId !== null) {
      candidates.push({ providerPaymentIntentId: reference.paymentIntentId });
    }
    if (reference.chargeId !== null) {
      candidates.push({ providerChargeId: reference.chargeId });
    }
    if (candidates.length === 0) {
      return null;
    }

    // Les deux références sont opaques et uniques à l'échelle du compte Stripe :
    // au plus une ligne, tous établissements confondus, peut les porter.
    const found = await this.prismaUnscoped.payment.findFirst({
      where: { OR: candidates },
      select: { tenantId: true },
    });

    return found?.tenantId ?? null;
  }

  /**
   * Applique l'événement, une fois et une seule.
   *
   * À appeler **dans une portée de tenant déjà résolue** : tout ce qui suit
   * passe par le client scopé, et l'extension refuse la moindre opération sans
   * contexte. C'est ce qui garantit qu'un événement d'un établissement ne peut
   * pas toucher la ligne d'un autre, même si sa référence était falsifiée.
   */
  public async apply(event: StripeWebhookEvent): Promise<WebhookApplication> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.processedWebhookEvent.createMany({
        data: [
          withScopedTenant<Prisma.ProcessedWebhookEventUncheckedCreateInput>({
            eventId: event.eventId,
            eventType: event.eventType,
          }),
        ],
        skipDuplicates: true,
      });

      if (claimed.count === 0) {
        return ALREADY_PROCESSED;
      }

      return { applied: true, ...(await this.applyFact(tx, event.fact)) };
    });
  }

  private async applyFact(
    tx: ScopedTransaction,
    fact: WebhookFact,
  ): Promise<Omit<WebhookApplication, 'applied'>> {
    switch (fact.kind) {
      case 'payment-succeeded':
        return this.settle(tx, fact);

      case 'payment-failed': {
        // Seul un encaissement encore en attente devient `FAILED`. Une carte
        // refusée après un succès — Stripe peut livrer dans le désordre —
        // n'annule pas un paiement déjà abouti.
        const { count } = await tx.payment.updateMany({
          where: { providerPaymentIntentId: fact.paymentIntentId, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        // Le rendez-vous reste `PENDING` : la cliente peut présenter une autre
        // carte, et l'annuler ici lui prendrait son créneau pour un refus de
        // banque (payments-stripe §2).
        return { paymentsTouched: count, appointmentsConfirmed: 0 };
      }

      case 'charge-refunded': {
        // Le montant vient de Stripe, qui fait foi (payments-stripe §6). Il n'est
        // pas plafonné ici : `payments_refunded_amount_minor_check` refuse en
        // base un remboursement supérieur à l'encaissement, la transaction est
        // annulée et l'événement n'est pas marqué traité — rien de faux n'est
        // écrit. La reprise, elle, est **manuelle** : le 200 est déjà parti,
        // Stripe ne rejouera pas de lui-même, et c'est l'alerte de niveau
        // `error` de `InProcessWebhookQueue` qui doit amener quelqu'un à
        // renvoyer l'événement une fois l'incident de réconciliation tranché.
        const { count } = await tx.payment.updateMany({
          where: { providerPaymentIntentId: fact.paymentIntentId },
          data: {
            refundedAmountMinor: fact.refundedAmountMinor,
            status: fact.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            ...(fact.chargeId === null ? {} : { providerChargeId: fact.chargeId }),
          },
        });
        return { paymentsTouched: count, appointmentsConfirmed: 0 };
      }

      case 'dispute-opened':
        // Aucune écriture : un litige déclenche une alerte vers l'équipe et
        // n'est pas traité automatiquement au MVP (payments-stripe §6). La
        // ligne de `processed_webhook_events` reste posée — c'est elle qui
        // évite qu'un rejeu ne réémette l'alerte.
        return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }
  }

  /**
   * Le succès de paiement — le seul événement qui fasse avancer le rendez-vous.
   *
   * « C'est le webhook, et lui seul, qui fait passer le rendez-vous en
   * `confirmed` » (payments-stripe §2). Les deux écritures sont dans la même
   * transaction que la marque d'idempotence : jamais un encaissement abouti
   * sans son rendez-vous confirmé, jamais l'inverse.
   */
  private async settle(
    tx: ScopedTransaction,
    fact: Extract<WebhookFact, { kind: 'payment-succeeded' }>,
  ): Promise<Omit<WebhookApplication, 'applied'>> {
    // `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
    // `where`, et le couple `(tenant_id, provider_payment_intent_id)` est unique.
    // Une intention d'un autre établissement est donc simplement introuvable.
    const payment = await tx.payment.findFirst({
      where: { providerPaymentIntentId: fact.paymentIntentId },
      select: { id: true, appointmentId: true },
    });

    if (payment === null) {
      // Encaissement inconnu de cet établissement : une intention créée hors de
      // notre tunnel, ou dont la ligne n'a jamais été écrite. Rien à mettre à
      // jour, et rien à corriger par un rejeu.
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    // Le filtre de statut est un test-et-pose atomique : un encaissement déjà
    // remboursé ne redevient pas abouti parce qu'une livraison arrive en retard.
    const settled = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['PENDING', 'FAILED'] } },
      data: {
        status: 'SUCCEEDED',
        capturedAt: new Date(),
        ...(fact.chargeId === null ? {} : { providerChargeId: fact.chargeId }),
      },
    });

    if (payment.appointmentId === null || settled.count === 0) {
      // Deux sorties sans confirmation, pour deux raisons distinctes :
      //
      // - vente au comptoir sans rendez-vous — le modèle l'accepte depuis #19 ;
      // - l'encaissement n'a **pas** transité vers `SUCCEEDED`, parce qu'il
      //   était déjà `REFUNDED` ou `PARTIALLY_REFUNDED` quand cette livraison
      //   est arrivée. Stripe ne garantit ni l'ordre des livraisons, ni leur
      //   traitement séquentiel : un `charge.refunded` appliqué avant le
      //   `payment_intent.succeeded` correspondant laisse la ligne remboursée.
      //   Confirmer le rendez-vous à ce moment-là bloquerait le créneau sur un
      //   paiement qui a été rendu — le filtre de statut de l'encaissement doit
      //   valoir pour les deux écritures, pas pour la première seulement.
      return { paymentsTouched: settled.count, appointmentsConfirmed: 0 };
    }

    // `PENDING` seulement : un rendez-vous annulé entre-temps ne ressuscite pas
    // parce que le paiement aboutit. Le remboursement se traite alors au
    // comptoir, il ne se devine pas ici.
    const confirmed = await tx.appointment.updateMany({
      where: { id: payment.appointmentId, status: 'PENDING' },
      data: { status: 'CONFIRMED' },
    });

    return { paymentsTouched: settled.count, appointmentsConfirmed: confirmed.count };
  }
}
