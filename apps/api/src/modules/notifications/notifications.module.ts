import { Module } from '@nestjs/common';

import { AppointmentsModule } from '../appointments/appointments.module';
import { IdentityModule } from '../identity/identity.module';
import { BookingConfirmationListener } from './booking-confirmation.listener';
import { DeliveryEventRepository } from './delivery-event.repository';
import { DeliveryEventService } from './delivery-event.service';
import { NotificationDispatchService } from './notification-dispatch.service';
import { AppointmentNotificationRenderer, NOTIFICATION_RENDERER } from './notification-renderer';
import { NOTIFICATION_SENDER, UnconfiguredNotificationSender } from './notification-sender';
import { NotificationTemplatesController } from './notification-templates.controller';
import { NotificationTemplatesRepository } from './notification-templates.repository';
import { NotificationTemplatesService } from './notification-templates.service';
import { InternalCallerGuard } from './internal-caller.guard';
import { NotificationsConfig } from './notifications.config';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { ReminderSweepRepository } from './reminder-sweep.repository';
import { ReminderSweepService } from './reminder-sweep.service';

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
  controllers: [NotificationsController, NotificationTemplatesController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationDispatchService,
    BookingConfirmationListener,
    // Les modèles par établissement (#69). Le dépôt sert **deux** appelants qui
    // n'ont rien en commun : le service, pour le back-office, et le renderer,
    // juste avant chaque envoi. C'est la raison pour laquelle il est un provider
    // à part entière et non un détail du service — la chaîne d'expédition ne doit
    // pas dépendre d'un service dont l'objet est un écran de configuration.
    NotificationTemplatesRepository,
    NotificationTemplatesService,
    // Le rappel J-1 (#71) : sa sélection, ses lectures, et la garde de la route
    // interne qui la déclenche. `NotificationsConfig` lit `process.env` à la
    // construction — même régime que `StripeConfig`, et pour la même raison :
    // une variable de notifications n'a pas à conditionner le démarrage des
    // sept autres modules.
    ReminderSweepRepository,
    ReminderSweepService,
    // Le traitement des rebonds et des plaintes (#73). Il partage la garde et la
    // configuration du balayage — même frontière de confiance, même jeton — et
    // confine sa propre dérogation au client non scopé dans
    // `DeliveryEventRepository`, comme le balayage le fait dans le sien.
    DeliveryEventRepository,
    DeliveryEventService,
    // `useFactory` et non la classe nue, exactement comme `StripeConfig` : le
    // seul paramètre du constructeur est l'environnement, que Nest chercherait
    // sinon à résoudre comme une dépendance.
    { provide: NotificationsConfig, useFactory: () => new NotificationsConfig(process.env) },
    InternalCallerGuard,
    // Le port de rendu. Depuis #69 il résout le modèle du salon avant celui de
    // la plateforme — et le reste du module n'a pas bougé, ce qui est
    // exactement l'intérêt d'avoir nommé la frontière plutôt que d'appeler les
    // fonctions de rendu en dur.
    { provide: NOTIFICATION_RENDERER, useClass: AppointmentNotificationRenderer },
    // Le port d'expédition. Un ticket ultérieur remplacera ce fournisseur par
    // les passerelles SES et SNS ; rien d'autre du module n'aura à changer, et
    // c'est tout l'intérêt d'avoir nommé la frontière.
    { provide: NOTIFICATION_SENDER, useClass: UnconfiguredNotificationSender },
  ],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
