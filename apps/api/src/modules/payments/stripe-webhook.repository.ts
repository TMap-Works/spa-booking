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
 * Accès Prisma du point d'entrée des webhooks (api-module §2).
 *
 * ## Pourquoi il reste un dépôt à part (#410)
 *
 * C'est **le seul du module à recevoir `PRISMA_UNSCOPED`** — l'unique dérogation
 * inter-tenant de `payments`. Fondre cette classe dans `PaymentsRepository`,
 * comme la lecture paresseuse du critère « un seul repository » y invitait,
 * mettrait le client non scopé dans le constructeur qui sert le tunnel public et
 * le comptoir : la dérogation cesserait d'être une propriété qu'on peut relire
 * d'un seul tenant, ce que tenant-isolation §3 demande précisément de garder
 * nommé, justifié et confiné. Le confinement est vérifié, pas espéré —
 * `__tests__/payments.boundaries.spec.ts` échoue si un second fichier du module
 * cite ce jeton.
 *
 * Il porte deux responsabilités que rien d'autre ne peut porter à sa place, et
 * une règle d'idempotence que #410 a tranchée.
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
 *
 * ## 3. La marque enregistre ce qui a été **appliqué**, pas ce qui a été reçu (#410)
 *
 * C'est le point de conception que #58 avait laissé en suspens, faute de
 * connaître l'ordre d'écriture que #57 allait fixer. Cet ordre est maintenant
 * écrit noir sur blanc dans `PaymentsService.createIntentForAppointment` :
 * **l'intention est créée chez Stripe d'abord, la ligne `payments` est inscrite
 * ensuite**. Il existe donc un état — court, mais réel — où Stripe connaît un
 * `pi_…` dont nous n'avons aucune trace.
 *
 * | Comment on y arrive | Fréquence |
 * |---|---|
 * | l'API meurt, ou l'écriture échoue, entre l'appel à Stripe et `recordCardIntent` | rare, mais c'est une panne, pas une hypothèse |
 * | une intention créée hors de notre tunnel : tableau de bord, lien de paiement, Terminal | ordinaire |
 * | un `charge.refunded` émis à la main depuis le tableau de bord | ordinaire |
 *
 * Marquer un tel événement « traité » alors qu'il n'a rien touché serait la
 * **perte silencieuse d'une confirmation d'encaissement** : la file en mémoire
 * n'a aucune reprise automatique (`stripe-webhook.queue.ts`), le 200 est déjà
 * parti, et le renvoi manuel depuis le tableau de bord — le seul recours qui
 * reste — serait alors avalé comme un rejeu. Le rendez-vous ne serait jamais
 * confirmé, et rien ne le dirait.
 *
 * La règle est donc : **si aucune ligne `payments` ne porte la référence citée,
 * la transaction est annulée en entier** — pas de marque, pas d'effet, et un
 * renvoi ultérieur s'applique normalement. Deux garde-fous encadrent cette
 * règle, sans quoi elle ferait plus de mal que de bien :
 *
 * - **`dispute-opened` garde sa marque.** Son effet *est* l'alerte, et il n'a
 *   par nature aucune ligne à toucher (payments-stripe §6). L'annuler ferait
 *   ré-alerter l'équipe à chaque rejeu.
 * - **La ligne existe mais le garde décline** — un `payment_intent.payment_failed`
 *   arrivé après le succès, un `payment_intent.succeeded` sur un encaissement
 *   déjà remboursé — reste **appliqué**, et marqué. Ce n'est pas un événement
 *   sans destinataire, c'est une décision prise en connaissance de cause ;
 *   l'annuler ferait rejouer sans fin un événement dont la conduite juste est
 *   précisément de ne rien écrire.
 *
 * L'ordre d'écriture reste inchangé : la marque s'insère toujours **avant**
 * l'effet, parce que c'est ce qui sérialise deux livraisons concurrentes. C'est
 * l'annulation qui la retire, pas un test préalable — un test préalable aurait
 * relâché le verrou et laissé deux livraisons appliquer l'effet deux fois.
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

/**
 * Ce qu'une livraison a produit, du point de vue de l'idempotence.
 *
 * Trois issues et non deux : « appliqué » et « rejoué » laissent tous deux une
 * marque, `unmatched` n'en laisse aucune — c'est très exactement la distinction
 * que #410 avait à trancher, et elle décide si un renvoi manuel servira à
 * quelque chose.
 */
export type WebhookOutcome =
  /** L'événement a été traité, et la marque d'idempotence est posée. */
  | 'applied'
  /** Déjà traité : Stripe l'a rejoué, la marque était là. */
  | 'replayed'
  /**
   * Aucune ligne `payments` ne porte la référence citée. **Rien n'a été écrit,
   * marque comprise** : l'événement reste applicable, et un renvoi depuis le
   * tableau de bord Stripe l'appliquera.
   */
  | 'unmatched';

/** Ce qu'une livraison a réellement produit — matière du journal, et rien d'autre. */
export interface WebhookApplication {
  readonly outcome: WebhookOutcome;
  /** Nombre de lignes `payments` touchées — 0 quand le garde de statut a décliné. */
  readonly paymentsTouched: number;
  /** Nombre de rendez-vous passés en `CONFIRMED` — 0 ou 1. */
  readonly appointmentsConfirmed: number;
}

/** L'effet d'un fait sur la base, ou `null` quand aucune ligne ne porte sa référence. */
type WebhookEffect = Omit<WebhookApplication, 'outcome'> | null;

const ALREADY_PROCESSED: WebhookApplication = {
  outcome: 'replayed',
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

const UNMATCHED: WebhookApplication = {
  outcome: 'unmatched',
  paymentsTouched: 0,
  appointmentsConfirmed: 0,
};

/**
 * Sentinelle interne : le seul moyen d'annuler une transaction Prisma est d'en
 * faire échouer le rappel.
 *
 * Elle ne quitte jamais ce fichier — `apply` la rattrape immédiatement et la
 * traduit en `unmatched`. La laisser filer ferait passer pour une panne ce qui
 * est une décision : la file journaliserait une erreur, et un lecteur du journal
 * chercherait un incident inexistant.
 */
class UnmatchedWebhookEvent extends Error {}

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
    try {
      return await this.prisma.$transaction(async (tx) => {
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

        const effect = await this.applyFact(tx, event.fact);

        if (effect === null) {
          // Aucune ligne ne porte la référence : on annule tout, marque
          // comprise. C'est ce qui laisse un renvoi manuel s'appliquer plutôt
          // que d'être avalé comme un rejeu (voir l'en-tête, §3).
          throw new UnmatchedWebhookEvent();
        }

        return { outcome: 'applied' as const, ...effect };
      });
    } catch (error) {
      if (error instanceof UnmatchedWebhookEvent) {
        return UNMATCHED;
      }
      throw error;
    }
  }

  /**
   * L'effet du fait sur la base, ou `null` si aucune ligne ne porte sa
   * référence.
   *
   * La recherche de la ligne est faite **une fois, ici**, et non répétée dans
   * chaque branche : c'est elle qui distingue « événement sans destinataire »
   * — qui annule la transaction — de « le garde de statut a décliné » — qui la
   * valide. Les trois branches qui suivent opèrent donc sur un identifiant de
   * ligne connu, jamais sur une référence de prestataire.
   */
  private async applyFact(tx: ScopedTransaction, fact: WebhookFact): Promise<WebhookEffect> {
    if (fact.kind === 'dispute-opened') {
      // Aucune écriture, et pourtant appliqué : un litige déclenche une alerte
      // vers l'équipe et n'est pas traité automatiquement au MVP
      // (payments-stripe §6). L'alerte **est** l'effet, et la ligne de
      // `processed_webhook_events` est ce qui évite qu'un rejeu ne la réémette.
      // Un litige peut d'ailleurs porter sur une charge dont nous n'avons aucune
      // ligne : l'exiger ici ferait ré-alerter à chaque livraison.
      return { paymentsTouched: 0, appointmentsConfirmed: 0 };
    }

    // `findFirst` et non `findUnique` : l'extension injecte `tenantId` dans le
    // `where`, et le couple `(tenant_id, provider_payment_intent_id)` est unique.
    // Une intention d'un autre établissement est donc simplement introuvable.
    const payment = await tx.payment.findFirst({
      where: { providerPaymentIntentId: fact.paymentIntentId },
      select: { id: true, appointmentId: true },
    });

    if (payment === null) {
      return null;
    }

    switch (fact.kind) {
      case 'payment-succeeded':
        return this.settle(tx, fact, payment);

      case 'payment-failed': {
        // Seul un encaissement encore en attente devient `FAILED`. Une carte
        // refusée après un succès — Stripe peut livrer dans le désordre —
        // n'annule pas un paiement déjà abouti. Le compte de zéro qui en résulte
        // n'est **pas** un événement sans destinataire : la ligne est là, la
        // conduite juste est de ne rien écrire, et la marque reste posée.
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id, status: 'PENDING' },
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
          where: { id: payment.id },
          data: {
            refundedAmountMinor: fact.refundedAmountMinor,
            status: fact.fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            ...(fact.chargeId === null ? {} : { providerChargeId: fact.chargeId }),
          },
        });
        return { paymentsTouched: count, appointmentsConfirmed: 0 };
      }
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
    payment: { readonly id: string; readonly appointmentId: string | null },
  ): Promise<Omit<WebhookApplication, 'outcome'>> {
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
