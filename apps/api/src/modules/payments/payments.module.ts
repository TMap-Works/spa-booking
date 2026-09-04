import { Module } from '@nestjs/common';

import { PaymentsRepository } from './payments.repository';
import { PaymentsService } from './payments.service';
import { PublicPaymentsController } from './public-payments.controller';
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
 *
 * Restent à venir : les webhooks signés et idempotents (#58), le POS et ses
 * lignes de vente (#60, #62), les remboursements (#63).
 *
 * ## Ce qu'il n'importe pas, et pourquoi
 *
 * **Aucun autre module métier.** La route du tunnel public n'est pas gardée —
 * on paie sans compte, comme on réserve sans compte —, si bien que
 * `IdentityModule` n'a rien à y monter. Le jour où le POS ouvrira sa surface de
 * back-office (#60), l'import viendra avec elle et pas avant : importer un
 * module pour des gardes qu'aucune route n'utilise serait un couplage gratuit.
 *
 * `AppointmentsModule` n'est pas importé non plus, et c'est une dette assumée
 * plutôt qu'un choix : le montant à encaisser est le prix figé à la
 * réservation, et `AppointmentsService` n'expose aujourd'hui aucune lecture par
 * identifiant à appeler (api-module §3 demanderait un appel de service). Le
 * repository lit donc la ligne directement, bornée à trois colonnes non
 * personnelles — voir l'en-tête de `payments.repository.ts` et l'issue de suivi
 * qui porte la dette.
 *
 * `PRISMA` vient de `DatabaseModule`, `StructuredLogger` de `LoggingModule` et
 * `TenantContextService` de `TenantContextModule` : les trois sont `@Global()`,
 * il n'y a rien à importer pour eux.
 *
 * ## Pourquoi la passerelle passe par un jeton
 *
 * `STRIPE_GATEWAY` est un `Symbol`, et `StripeHttpGateway` n'en est qu'une
 * implémentation. C'est ce qui permet aux suites de substituer un double en
 * mémoire — aucun test n'atteint l'environnement live (payments-stripe §7) — et
 * ce qui laissera `stripe-node` entrer derrière cette frontière, le jour où
 * Terminal ou la vérification de signature de webhook (#58) le rendront
 * nécessaire, sans qu'une ligne du service ne bouge.
 *
 * ## Ce qu'il exporte
 *
 * `PaymentsService`, la porte du module — c'est par elle que #58 fera passer un
 * paiement en `SUCCEEDED` sur réception d'un webhook, et que #60 ouvrira une
 * vente au comptoir. `PaymentsRepository` n'est **pas** exporté : un module
 * n'importe jamais le repository d'un autre (api-module §3).
 *
 * `StripeConfig` l'est en revanche, parce que #58 aura besoin du secret de
 * webhook au même endroit que les deux clés — et qu'il vaut mieux une seule
 * porte de configuration Stripe que deux.
 */
@Module({
  controllers: [PublicPaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    // `useFactory` et non `useClass` : le paramètre de `StripeConfig` est un
    // `NodeJS.ProcessEnv`, une interface. `emitDecoratorMetadata` ne peut en
    // émettre que `Object`, que Nest chercherait alors — en vain — parmi ses
    // fournisseurs. La fabrique nomme la source explicitement et laisse le
    // constructeur testable avec un environnement fabriqué.
    { provide: StripeConfig, useFactory: () => new StripeConfig(process.env) },
    { provide: STRIPE_GATEWAY, useClass: StripeHttpGateway },
  ],
  exports: [PaymentsService, StripeConfig],
})
export class PaymentsModule {}
