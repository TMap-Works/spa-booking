import { Module } from '@nestjs/common';

import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PublicPaymentsController } from './public-payments.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { InProcessWebhookQueue, WEBHOOK_QUEUE } from './stripe-webhook.queue';
import { StripeWebhookRepository } from './stripe-webhook.repository';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeHttpGateway } from './stripe/stripe-http.gateway';
import { StripeWebhookConfig } from './stripe/stripe-webhook.config';
import { StripeConfig } from './stripe/stripe.config';
import { STRIPE_GATEWAY } from './stripe/stripe.gateway';

/**
 * Module `payments` — encaissement et tokenisation (CDC §2.3).
 *
 * ## Ce qu'il contient
 *
 * | Ticket | Ce qu'il pose |
 * |---|---|
 * | #57 | L'intention de paiement Stripe et la clé publiable — la tokenisation côté client, donc le périmètre SAQ A |
 * | #58 | La réception des webhooks Stripe : signature sur corps brut, idempotence, et le passage du rendez-vous en `CONFIRMED` |
 *
 * Les deux moitiés se répondent : #57 crée une intention et ne confirme rien,
 * #58 est le seul à faire passer un encaissement en `SUCCEEDED` et le
 * rendez-vous en `CONFIRMED` (payments-stripe §2).
 *
 * Restent à venir : le montage d'Elements côté tunnel (#59), le POS et ses
 * lignes de vente (#60, #62), les remboursements initiés au comptoir (#63).
 *
 * ## Ce qu'il n'importe pas, et pourquoi
 *
 * **Aucun autre module métier.** Ni la route du tunnel public — on paie sans
 * compte, comme on réserve sans compte — ni la route de webhook — Stripe ne
 * présente aucun jeton, c'est la signature qui l'authentifie — ne sont gardées,
 * si bien qu'`IdentityModule` n'a rien à y monter. Le jour où le POS ouvrira sa
 * surface de back-office (#60), l'import viendra avec elle et pas avant :
 * importer un module pour des gardes qu'aucune route n'utilise serait un
 * couplage gratuit.
 *
 * `AppointmentsModule` n'est pas importé non plus, et c'est une dette assumée
 * vis-à-vis d'api-module §3, pour deux raisons distinctes :
 *
 * - à la création de l'intention, le montant à encaisser est le prix figé à la
 *   réservation, et `AppointmentsService` n'expose aujourd'hui aucune lecture
 *   par identifiant à appeler. Le repository lit donc la ligne directement,
 *   bornée à trois colonnes non personnelles ;
 * - à la réception du webhook, la confirmation du rendez-vous est une
 *   transition de statut écrite dans la **même transaction** que
 *   l'encaissement, et la déléguer à un service d'un autre module la sortirait
 *   de cette transaction — un paiement abouti pourrait alors coexister avec un
 *   rendez-vous resté `PENDING`.
 *
 * Une issue de suivi porte cette dette.
 *
 * `PRISMA`, `PRISMA_UNSCOPED`, `StructuredLogger` et `TenantContextService`
 * viennent de modules `@Global()` : il n'y a rien à importer pour eux.
 *
 * ## Pourquoi la passerelle et la file passent par un jeton
 *
 * `STRIPE_GATEWAY` et `WEBHOOK_QUEUE` sont des `Symbol`, et `StripeHttpGateway`
 * comme `InProcessWebhookQueue` n'en sont que des implémentations. C'est ce qui
 * permet aux suites de substituer un double en mémoire — aucun test n'atteint
 * l'environnement live (payments-stripe §7) —, ce qui laissera `stripe-node`
 * entrer derrière la première frontière le jour où Terminal le rendra
 * nécessaire, et la chaîne EventBridge → SQS → Lambda du CDC §2.2 derrière la
 * seconde, sans qu'une ligne du service ni du contrôleur ne bouge.
 *
 * ## Ce qu'il exporte
 *
 * `PaymentsService`, la porte du module — c'est par elle que #60 ouvrira une
 * vente au comptoir. `StripeConfig`, parce qu'il vaut mieux une seule porte de
 * configuration Stripe que deux. `WEBHOOK_QUEUE`, pour la seule raison qui
 * vaille : les suites d'intégration doivent pouvoir attendre que la file se
 * vide avant d'asserter sur la base.
 *
 * `PaymentsRepository` et `StripeWebhookRepository` ne sont **pas** exportés :
 * un module n'importe jamais le repository d'un autre (api-module §3).
 */
@Module({
  controllers: [PublicPaymentsController, StripeWebhookController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    StripeWebhookService,
    StripeWebhookRepository,
    // `useFactory` et non `useClass` : le paramètre de ces deux fournisseurs de
    // configuration est un `NodeJS.ProcessEnv`, une interface.
    // `emitDecoratorMetadata` ne peut en émettre que `Object`, que Nest
    // chercherait alors — en vain — parmi ses fournisseurs. La fabrique nomme la
    // source explicitement et laisse le constructeur exerçable avec un
    // environnement fabriqué.
    { provide: StripeConfig, useFactory: () => new StripeConfig(process.env) },
    { provide: StripeWebhookConfig, useFactory: () => new StripeWebhookConfig(process.env) },
    { provide: STRIPE_GATEWAY, useClass: StripeHttpGateway },
    { provide: WEBHOOK_QUEUE, useClass: InProcessWebhookQueue },
  ],
  exports: [PaymentsService, StripeConfig, WEBHOOK_QUEUE],
})
export class PaymentsModule {}
