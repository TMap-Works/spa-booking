import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { IdentityModule } from '../identity/identity.module';
import { CashPaymentsService } from './cash-payments.service';
import { CounterPaymentsController } from './counter-payments.controller';
import { PaymentsHistoryService } from './payments-history.service';
import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PosRepository } from './pos.repository';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PublicPaymentsController } from './public-payments.controller';
import { RefundsRepository } from './refunds.repository';
import { RefundsService } from './refunds.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { StripeWebhookController } from './stripe-webhook.controller';
import { InProcessWebhookQueue, WEBHOOK_QUEUE } from './stripe-webhook.queue';
import { StripeWebhookRepository } from './stripe-webhook.repository';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeHttpGateway } from './stripe/stripe-http.gateway';
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
 * | #62 | Le règlement en espèces, l'historique des ventes et celui des transactions — la matière du rapprochement |
 * | #63 | Le remboursement total et partiel : l'ordre au prestataire, le cumul borné côté serveur, et la trace « qui, quand, pourquoi » |
 * | #410 | La consolidation : une seule `StripeConfig`, un seul fichier d'erreurs, et un critère de découpage des dépôts |
 *
 * Les deux premières moitiés se répondent : #57 crée une intention et ne
 * confirme rien, #58 est le seul à faire passer un encaissement **carte** en
 * `SUCCEEDED` et le rendez-vous en `CONFIRMED` (payments-stripe §2).
 *
 * #60 est d'une autre nature : il **compose une addition, il n'encaisse rien**.
 * Un ticket existe avant d'être réglé, ce qui est exactement ce qu'un comptoir
 * fait.
 *
 * #62 referme la boucle par l'autre bout : il encaisse **sans prestataire**.
 * `CashPaymentsService` n'injecte ni `StripeConfig` ni `STRIPE_GATEWAY`, et
 * c'est ce qui rend son quatrième critère vrai par construction — il n'y a rien
 * à appeler depuis ce chemin-là. C'est aussi pourquoi il est un service à part
 * plutôt qu'une méthode de `PaymentsService`, qui les injecte tous deux.
 *
 * #63 est le pendant exact de #57 : il **sort** de l'argent là où l'autre en
 * fait entrer. `RefundsService` et `RefundsRepository` sont donc à part de
 * `PaymentsService` et `PaymentsRepository`, pour une raison de forme et non de
 * taille — le contrôle du cumul est un « lire, décider, écrire » qui doit se
 * sérialiser, et le loger dans un dépôt qui sert aussi des lectures ordinaires
 * aurait laissé croire qu'une lecture hors transaction suffisait.
 *
 * Reste à venir : le montage d'Elements côté tunnel (#59).
 *
 * ## Ce qui décide du découpage — un critère, pas un ordre de merge (#410)
 *
 * #57 et #58 ont été écrites en parallèle et ont laissé le module en deux
 * moitiés qui ne se connaissaient pas : deux fournisseurs de configuration
 * Stripe, deux fichiers d'erreurs, deux dépôts. Deux de ces trois duplications
 * n'avaient aucune raison d'être et ont été fondues — il n'y a plus qu'une
 * `StripeConfig`, portant les trois valeurs, et qu'un `payments.errors.ts`.
 *
 * Le découpage des **dépôts**, lui, survit à la consolidation, parce qu'un
 * critère le porte et non l'historique :
 *
 * | Dépôt | Ce qui le sépare des autres |
 * |---|---|
 * | `StripeWebhookRepository` | le **seul** à recevoir `PRISMA_UNSCOPED` — l'unique dérogation inter-tenant du module (tenant-isolation §3) |
 * | `RefundsRepository` | un « lire, décider, écrire » qui doit se sérialiser : le loger avec des lectures ordinaires laisserait croire qu'une lecture hors transaction suffit |
 * | `PosRepository` | le ticket et ses lignes, écrits d'un seul geste transactionnel |
 * | `PaymentsRepository` | tout le reste, et **rien qui ne soit scopé** |
 *
 * La première ligne est celle qui compte. Fondre le dépôt du webhook dans
 * `PaymentsRepository` mettrait le client non scopé dans le constructeur qui
 * sert le tunnel public et le comptoir — c'est-à-dire exactement ce que
 * tenant-isolation §3 demande de garder nommé, justifié et confiné. Le confinement
 * est vérifié plutôt qu'espéré : `__tests__/payments.boundaries.spec.ts` échoue
 * si un second fichier du module cite `PRISMA_UNSCOPED`.
 *
 * ## Ce qu'il importe, et pourquoi
 *
 * `IdentityModule`, et seulement pour ses **gardes** : les routes du POS et du
 * comptoir sont gardées par `@AuthAtLeast(...)`, qui monte `JwtAuthGuard` et
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
 * `ProductsService`, `CashPaymentsService`, `PaymentsHistoryService` et
 * `RefundsService` ne sont **pas** exportés : le rayon retail, l'encaissement au comptoir et la lecture
 * de rapprochement n'intéressent aucun autre module du périmètre MVP, et un
 * `exports` posé « au cas où » ouvrirait une porte que personne ne franchit et
 * qu'il faudrait pourtant maintenir. Le jour où `reporting` lira le chiffre
 * d'affaires, c'est `SalesService` — déjà exporté — qui le sert.
 *
 * `PaymentsRepository`, `StripeWebhookRepository`, `PosRepository` et
 * `RefundsRepository` ne sont pas exportés non plus : un module n'importe jamais le repository d'un autre
 * (api-module §3).
 */
@Module({
  imports: [IdentityModule, CatalogModule],
  controllers: [
    PublicPaymentsController,
    StripeWebhookController,
    ProductsController,
    SalesController,
    CounterPaymentsController,
  ],
  providers: [
    PaymentsService,
    CashPaymentsService,
    PaymentsHistoryService,
    RefundsService,
    RefundsRepository,
    PaymentsRepository,
    ProductsService,
    SalesService,
    PosRepository,
    StripeWebhookService,
    StripeWebhookRepository,
    // `useFactory` et non `useClass` : le paramètre de ce fournisseur de
    // configuration est un `NodeJS.ProcessEnv`, une interface.
    // `emitDecoratorMetadata` ne peut en émettre que `Object`, que Nest
    // chercherait alors — en vain — parmi ses fournisseurs. La fabrique nomme la
    // source explicitement et laisse le constructeur exerçable avec un
    // environnement fabriqué.
    { provide: StripeConfig, useFactory: () => new StripeConfig(process.env) },
    { provide: STRIPE_GATEWAY, useClass: StripeHttpGateway },
    { provide: WEBHOOK_QUEUE, useClass: InProcessWebhookQueue },
  ],
  exports: [PaymentsService, SalesService, StripeConfig, WEBHOOK_QUEUE],
})
export class PaymentsModule {}
