import { Module } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { AppointmentsModule } from '../appointments/appointments.module';
import { IdentityModule } from '../identity/identity.module';
import { AwsNotificationSender } from './aws-notification.sender';
import { BookingConfirmationListener } from './booking-confirmation.listener';
import { CancellationNoticeListener } from './cancellation-notice.listener';
import { DeliveryEventRepository } from './delivery-event.repository';
import { DeliveryEventService } from './delivery-event.service';
import { NotificationDispatchController } from './notification-dispatch.controller';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NOTIFICATION_PUBLISHER, notificationPublisherFactory } from './notification-publisher';
import { AppointmentNotificationRenderer, NOTIFICATION_RENDERER } from './notification-renderer';
import { NOTIFICATION_SENDER } from './notification-sender';
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
 * #72 y ajoute le **troisième et dernier** message du CDC §1.4 — l'avis
 * d'annulation — et avec lui le second abonné du module au bus d'`appointments`.
 *
 * #799 **ferme la chaîne** : les passerelles SES et SNS prennent la place du
 * refus en 503, les deux abonnés publient dans la file au lieu d'expédier en
 * processus, et `POST /api/v1/interne/notifications/dispatch` sert le contrat
 * que la Lambda d'envoi appelle depuis #67. Les trois messages du CDC §1.4
 * partent réellement.
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
 * C'est vrai après #799 comme avant, et c'est ce qui a demandé le plus de soin.
 * `NOTIFICATION_SENDER` est désormais `AwsNotificationSender`, mais il ne lit
 * `SES_FROM_EMAIL` ni `SNS_SMS_SENDER_ID` qu'au **premier envoi** — quatrième
 * critère d'acceptation — et il refuse alors en 503, canal par canal, si rien
 * n'est configuré. La conduite observable est donc exactement celle
 * d'`UnconfiguredNotificationSender` : une ligne `FAILED` assortie de son motif,
 * visible au back-office, reprenable telle quelle le jour où la passerelle est
 * branchée. C'est ce qu'un faux `SENT` aurait rendu impossible.
 *
 * `AppConfigService`, dont le renderer tire l'origine du lien d'annulation, vient
 * d'un module `@Global()` déjà validé au démarrage : `APP_URL` est une variable
 * existante, pas une nouvelle exigence.
 *
 * ## Les deux fabriques, et pourquoi elles ne se ressemblent pas
 *
 * `NOTIFICATION_SENDER` est un **objet unique** qui décide par canal, au moment
 * d'envoyer : il doit l'être, puisque la lecture de sa configuration est
 * différée. `NOTIFICATION_PUBLISHER`, lui, est choisi à l'amorçage — la file est
 * là ou elle ne l'est pas, et ce choix détermine l'objet injecté dans deux
 * écouteurs qui s'abonnent au bus dès `onModuleInit`. Voir l'en-tête de
 * `notification-publisher.ts`.
 */
@Module({
  imports: [IdentityModule, AppointmentsModule],
  controllers: [
    NotificationsController,
    NotificationTemplatesController,
    // La route d'envoi interne (#799). Un contrôleur à part parce que son chemin
    // l'est — `interne/notifications`, ce que `dispatch_url` désigne — et non
    // parce qu'on aurait voulu ranger. Un contrôleur oublié ici compile, passe
    // ses tests unitaires, et rend 404 en vrai.
    NotificationDispatchController,
  ],
  providers: [
    NotificationsRepository,
    NotificationsService,
    NotificationDispatchService,
    BookingConfirmationListener,
    // L'avis d'annulation (#72). Second abonné du module au bus d'`appointments`,
    // et le dernier : les trois messages du CDC §1.4 sont servis. Il s'abonne à
    // un autre événement que le premier, si bien qu'aucun des deux ne voit
    // passer ce qui ne le regarde pas.
    CancellationNoticeListener,
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
    // Le port d'expédition, désormais tenu par les passerelles SES et SNS
    // (#799). La promesse de #68 est tenue au pied de la lettre : « rien
    // d'autre du module n'aura à changer », et rien d'autre n'a changé — ni
    // l'ordre d'écriture, ni l'index d'idempotence, ni le rendu.
    //
    // `useFactory` et non `useClass` : les deux derniers paramètres du
    // constructeur sont les fabriques de passerelles, que Nest chercherait
    // sinon à résoudre comme des dépendances. Leur défaut est la vraie
    // passerelle ; une suite passe un double, et aucun test du dépôt n'ouvre de
    // connexion vers AWS (notifications §8).
    {
      provide: NOTIFICATION_SENDER,
      useFactory: (
        config: NotificationsConfig,
        repository: NotificationsRepository,
        logger: StructuredLogger,
      ) => new AwsNotificationSender(config, repository, logger),
      inject: [NotificationsConfig, NotificationsRepository, StructuredLogger],
    },
    // Le port de publication (#799). C'est lui que les deux abonnés du bus
    // appellent désormais : ils composent une enveloppe, la remettent, et
    // rendent la main — « une réservation ne doit jamais échouer parce qu'un
    // e-mail n'est pas parti » (CDC §4.8). Sans `NOTIFICATION_QUEUE_URL`, la
    // fabrique retombe sur l'expédition en processus, exactement comme avant.
    {
      provide: NOTIFICATION_PUBLISHER,
      useFactory: notificationPublisherFactory,
      inject: [NotificationsConfig, NotificationDispatchService, StructuredLogger],
    },
  ],
  exports: [NotificationDispatchService],
})
export class NotificationsModule {}
