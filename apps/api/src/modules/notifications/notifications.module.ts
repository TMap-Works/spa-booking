import { Module } from '@nestjs/common';

import { AppointmentsModule } from '../appointments/appointments.module';
import { IdentityModule } from '../identity/identity.module';
import { BookingConfirmationListener } from './booking-confirmation.listener';
import { NotificationDispatchService } from './notification-dispatch.service';
import { AppointmentNotificationRenderer, NOTIFICATION_RENDERER } from './notification-renderer';
import { NOTIFICATION_SENDER, UnconfiguredNotificationSender } from './notification-sender';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Module `notifications` — confirmations, rappels J-1, avis d'annulation
 * (CDC §2.3, §1.4).
 *
 * #68 en a posé le socle : la table, l'ordre d'écriture et l'idempotence des
 * envois. #70 y ajoute le **premier message** — la confirmation de réservation —
 * et avec lui les trois pièces qui manquaient : l'abonnement à l'événement de
 * domaine, le rendu du contenu, et la lecture du journal par le back-office.
 *
 * Restent à venir : les passerelles SES et SNS, la Lambda d'envoi, les modèles
 * par établissement, et le balayage horaire du rappel J-1.
 *
 * ## Il importe `AppointmentsModule`, et le sens compte
 *
 * C'est `notifications` qui dépend d'`appointments`, jamais l'inverse
 * (api-module §3). `AppointmentsModule` exporte `AppointmentEvents` depuis #37
 * précisément pour cela, et il n'importe rien d'ici — il n'y a donc pas de
 * cycle, et il ne peut pas s'en former sans qu'on le voie.
 *
 * L'import ne donne accès qu'au **bus**. Aucun service ni repository
 * d'`appointments` n'est injecté : ce qu'un message a besoin de lire, il le lit
 * par le client Prisma scopé, avec sa propre projection.
 *
 * `IdentityModule` fournit les gardes que monte `@AuthAtLeast` sur l'unique
 * route du module — même raison que chez `crm`, `reporting` et `catalog`.
 *
 * ## Il entre dans `app.module.ts` avec #70
 *
 * #68 l'avait laissé hors du graphe « faute de route à servir » — la conduite
 * qu'ont eue `availability` (#41) et `appointments` (#31). Ce n'est plus le cas :
 * `GET /notifications` en apporte une, et l'abonnement au bus a de toute façon
 * besoin que le module soit instancié pour que son `onModuleInit` s'exécute.
 *
 * ## Il n'exige toujours aucune variable d'environnement pour démarrer
 *
 * `NOTIFICATION_SENDER` reste branché sur `UnconfiguredNotificationSender`, qui
 * refuse tout envoi en 503 — le même régime que `payments` sans clés Stripe.
 * Sans passerelle AWS, une confirmation laisse donc une ligne `FAILED` assortie
 * de son motif, visible au back-office, et reprenable telle quelle le jour où un
 * expéditeur réel prend la place. C'est ce qu'un faux `SENT` aurait rendu
 * impossible.
 *
 * `AppConfigService`, dont le renderer tire l'origine du lien d'annulation, vient
 * d'un module `@Global()` déjà validé au démarrage : `APP_URL` est une variable
 * existante, pas une nouvelle exigence.
 */
@Module({
  imports: [IdentityModule, AppointmentsModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationDispatchService,
    BookingConfirmationListener,
    // Le port de rendu. Les modèles par établissement (notifications §6) le
    // remplaceront sans que le reste du module bouge — c'est l'intérêt d'avoir
    // nommé la frontière plutôt que d'appeler les fonctions de rendu en dur.
    { provide: NOTIFICATION_RENDERER, useClass: AppointmentNotificationRenderer },
    // Le port d'expédition. Un ticket ultérieur remplacera ce fournisseur par
    // les passerelles SES et SNS ; rien d'autre du module n'aura à changer, et
    // c'est tout l'intérêt d'avoir nommé la frontière.
    { provide: NOTIFICATION_SENDER, useClass: UnconfiguredNotificationSender },
  ],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
