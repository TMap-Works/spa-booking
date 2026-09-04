import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PosRepository } from './pos.repository';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PublicPaymentsController } from './public-payments.controller';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
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
 * | #60 | Le POS de base : le rayon retail, le ticket de caisse et ses lignes, le total recalculé côté serveur |
 *
 * Les deux premières moitiés se répondent : #57 crée une intention et ne
 * confirme rien, #58 est le seul à faire passer un encaissement en `SUCCEEDED`
 * et le rendez-vous en `CONFIRMED` (payments-stripe §2).
 *
 * #60 est d'une autre nature : il **compose une addition, il n'encaisse rien**.
 * Un ticket existe avant d'être réglé, ce qui est exactement ce qu'un comptoir
 * fait — et le règlement, espèces comprises, est l'affaire de #62.
 *
 * Restent à venir : le montage d'Elements côté tunnel (#59), le paiement en
 * espèces et l'historique des ventes (#62), les remboursements initiés au
 * comptoir (#63).
 *
 * ## Ce qu'il importe, et pourquoi
 *
 * `IdentityModule`, et seulement pour ses **gardes** : les cinq routes du POS
 * sont gardées par `@AuthAtLeast(...)`, qui monte `JwtAuthGuard` et
 * `RolesGuard` — deux gardes qui ont des dépendances à injecter. C'est ce que
 * l'en-tête de ce fichier annonçait avant #60 : « le jour où le POS ouvrira sa
 * surface de back-office, l'import viendra avec elle et pas avant ». Les deux
 * routes de #57 et #58 restent, elles, sans garde — on paie sans compte comme
 * on réserve sans compte, et Stripe s'authentifie par sa signature.
 *
 * `CatalogModule`, pour `ServicesService` : c'est lui qui dit ce que coûte une
 * prestation, et le ticket a besoin de ce prix. C'est la voie prévue par
 * api-module §3 — un appel de service, jamais l'import du dépôt d'un autre
 * module. Un second avis sur le prix d'une prestation aurait fini par diverger
 * du premier.
 *
 * `AppointmentsModule` n'est pas importé, et c'est une dette assumée
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
 * `PaymentsService`, la porte de l'encaissement en ligne. `SalesService`, celle
 * de la caisse — c'est par elle que #62 réglera un ticket en espèces, et que
 * `reporting` lira le chiffre d'affaires du comptoir. `StripeConfig`, parce
 * qu'il vaut mieux une seule porte de configuration Stripe que deux.
 * `WEBHOOK_QUEUE`, pour la seule raison qui vaille : les suites d'intégration
 * doivent pouvoir attendre que la file se vide avant d'asserter sur la base.
 *
 * `ProductsService` n'est **pas** exporté : le rayon retail n'intéresse aucun
 * autre module du périmètre MVP, et un `exports` posé « au cas où » ouvrirait
 * une porte que personne ne franchit et qu'il faudrait pourtant maintenir.
 *
 * `PaymentsRepository`, `StripeWebhookRepository` et `PosRepository` ne sont
 * pas exportés non plus : un module n'importe jamais le repository d'un autre
 * (api-module §3).
 */
@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [
    PublicPaymentsController,
    StripeWebhookController,
    ProductsController,
    SalesController,
  ],
  providers: [
    PaymentsService,
    PaymentsRepository,
    ProductsService,
    SalesService,
    PosRepository,
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
  exports: [PaymentsService, SalesService, StripeConfig, WEBHOOK_QUEUE],
})
export class PaymentsModule {}
