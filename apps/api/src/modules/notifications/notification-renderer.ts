import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import {
  cancellationUrl,
  renderBookingConfirmationEmail,
  renderBookingConfirmationSms,
  renderReminderEmail,
  renderReminderSms,
} from './notification-content';
import { NotificationContextGoneError, UnrenderableNotificationError } from './notifications.errors';
import { NotificationsRepository } from './notifications.repository';
import type { NotificationMessage, RenderedNotification } from './notifications.types';

/**
 * Le **port de rendu** — ce qui transforme la désignation d'un message en un
 * message.
 *
 * ## Pourquoi le rendu est un temps de l'expédition, et pas du producteur
 *
 * `NotificationMessage` ne porte que des identifiants, et son commentaire dit
 * pourquoi : « un message de file survit à sa file — il peut être rejoué une
 * heure plus tard, après une annulation — et un contenu figé au moment de la
 * publication annoncerait alors un rendez-vous qui n'existe plus ».
 *
 * La conséquence est que quelqu'un doit rendre le contenu **après** la prise de
 * droit et **avant** l'appel au fournisseur, dans la portée de tenant ouverte
 * par le consommateur. C'est ce port.
 *
 * ## Pourquoi un port et non une fonction
 *
 * Parce qu'il lit la base — l'établissement, la cliente, la prestation, le
 * praticien — et que `NotificationDispatchService` ne doit pas savoir comment.
 * Les modèles eux-mêmes, qui sont la partie qu'on relit et qu'on teste, restent
 * des fonctions pures dans `notification-content.ts`.
 */
export interface NotificationRenderer {
  /**
   * Rend le message désigné, dans la portée de tenant courante.
   *
   * @throws {NotificationContextGoneError} le rendez-vous a disparu sous la
   * livraison — il n'y a plus rien à annoncer.
   * @throws {UnrenderableNotificationError} aucun modèle n'existe encore pour ce
   * type de message.
   */
  render(message: NotificationMessage): Promise<RenderedNotification>;
}

/**
 * Jeton d'injection du port — un `Symbol`, comme `NOTIFICATION_SENDER` : une
 * interface TypeScript n'existe pas à l'exécution.
 */
export const NOTIFICATION_RENDERER = Symbol('NOTIFICATION_RENDERER');

/**
 * Le rendu des messages rattachés à un rendez-vous.
 *
 * ## Ce qu'il couvre, et ce qu'il refuse
 *
 * `BOOKING_CONFIRMATION` (#70) et `REMINDER_24H` (#71). `CANCELLATION` est le
 * troisième message du MVP (CDC §1.4) et a son issue (#72) ; ce renderer **lève**
 * plutôt que de lui servir un autre modèle, parce qu'un avis d'annulation qui
 * dirait « nous vous attendons » serait pire qu'un avis absent. Le refus laisse
 * la ligne en `FAILED`, donc reprenable dès que le modèle manquant existe
 * (notifications §4) — c'est exactement le régime de
 * `UnconfiguredNotificationSender`.
 *
 * Le rappel a son propre modèle et ne réemploie pas celui de la confirmation :
 * ils affirment deux choses différentes, et un rappel qui annoncerait « votre
 * rendez-vous est confirmé » ne dirait pas à la cliente ce qu'on attend d'elle.
 *
 * ## Le lien d'annulation vient de la configuration, jamais d'une requête
 *
 * `AppConfigService.appUrl` est l'origine du front, validée au démarrage. La
 * composer ici plutôt que de la recevoir en argument évite qu'un en-tête `Host`
 * d'une requête entrante finisse dans un e-mail — le vecteur classique de
 * l'empoisonnement de lien. Un consommateur de file n'a de toute façon aucune
 * requête à interroger.
 */
@Injectable()
export class AppointmentNotificationRenderer implements NotificationRenderer {
  public constructor(
    private readonly repository: NotificationsRepository,
    private readonly config: AppConfigService,
  ) {}

  public async render(message: NotificationMessage): Promise<RenderedNotification> {
    // `CANCELLATION` reste refusé : c'est #72, et lui servir le modèle du rappel
    // annoncerait un rendez-vous à qui vient de l'annuler.
    if (message.type !== 'BOOKING_CONFIRMATION' && message.type !== 'REMINDER_24H') {
      throw new UnrenderableNotificationError(message.type);
    }

    const context = await this.repository.loadAppointmentContext(message.appointmentId);

    if (context === null) {
      throw new NotificationContextGoneError(message.appointmentId);
    }

    if (message.type === 'REMINDER_24H') {
      return message.channel === 'SMS'
        ? renderReminderSms(context)
        : renderReminderEmail(context, cancellationUrl(this.config.appUrl, context.tenantSlug));
    }

    if (message.channel === 'SMS') {
      return renderBookingConfirmationSms(context);
    }

    return renderBookingConfirmationEmail(
      context,
      cancellationUrl(this.config.appUrl, context.tenantSlug),
    );
  }
}
