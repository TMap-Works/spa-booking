import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { buildTemplateVariables, cancellationUrl, renderNotification } from './notification-content';
import { defaultTemplateFor } from './notification-default-templates';
import { NotificationTemplatesRepository } from './notification-templates.repository';
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
 * ## Le modèle du salon d'abord, celui de la plateforme sinon — #69
 *
 * C'est le seul choix que fait ce renderer, et il tient en une ligne : la
 * personnalisation de l'établissement si elle existe, le défaut versionné sinon.
 * Le repli n'est pas une commodité, c'est ce qui garantit qu'un salon qui n'a
 * jamais ouvert l'écran de personnalisation reçoit malgré tout des confirmations
 * — et qu'un salon qui efface la sienne y revient sans qu'aucun contenu n'ait été
 * recopié.
 *
 * La lecture a lieu **à chaque envoi**, et non une fois pour toutes : un modèle
 * corrigé à 14 h doit s'appliquer au message de 14 h 01. C'est une lecture
 * indexée sur l'unique `(tenant_id, type, channel)`, du même ordre que la
 * relecture d'éligibilité du rappel, et elle a lieu dans la portée de tenant
 * déjà ouverte par le consommateur — le modèle d'un salon ne peut donc pas partir
 * chez la cliente d'un autre.
 *
 * ## Ce qu'il refuse encore
 *
 * `CANCELLATION` n'a pas de modèle de plateforme : c'est le troisième message du
 * MVP (CDC §1.4) et il a son issue (#72). Le renderer **lève** plutôt que de lui
 * servir le modèle du rappel, parce qu'un avis d'annulation qui dirait « nous
 * vous attendons » serait pire qu'un avis absent. Le refus laisse la ligne en
 * `FAILED`, donc reprenable dès que le modèle manquant existe (notifications §4).
 *
 * Le refus n'est plus une liste de types en dur : il découle de l'absence de
 * modèle. Un salon qui écrit lui-même son avis d'annulation le voit donc partir,
 * ce qui est exactement ce que « personnaliser sans déploiement » veut dire — et
 * le jour où #72 livrera le défaut de plateforme, il n'y aura rien à changer ici.
 *
 * ## Le lien d'annulation vient de la configuration, jamais d'une requête
 *
 * `AppConfigService.appUrl` est l'origine du front, validée au démarrage. La
 * composer ici plutôt que de la recevoir en argument évite qu'un en-tête `Host`
 * d'une requête entrante finisse dans un e-mail — le vecteur classique de
 * l'empoisonnement de lien. Un consommateur de file n'a de toute façon aucune
 * requête à interroger.
 *
 * C'est aussi ce qui borne ce qu'un modèle personnalisé peut faire : il **nomme**
 * `{{lien_annulation}}`, il ne l'écrit pas. Un salon ne peut donc pas faire
 * pointer le lien d'annulation d'un e-mail signé de son nom vers un domaine qu'il
 * aurait choisi.
 */
@Injectable()
export class AppointmentNotificationRenderer implements NotificationRenderer {
  public constructor(
    private readonly repository: NotificationsRepository,
    private readonly templates: NotificationTemplatesRepository,
    private readonly config: AppConfigService,
  ) {}

  public async render(message: NotificationMessage): Promise<RenderedNotification> {
    const source =
      (await this.templates.find(message.type, message.channel))?.source ??
      defaultTemplateFor(message.type, message.channel);

    if (source === null) {
      throw new UnrenderableNotificationError(message.type);
    }

    // Le contexte se lit **après** le modèle : un message sans modèle n'a aucune
    // raison de coûter une jointure sur le rendez-vous, la cliente, la prestation
    // et le praticien.
    const context = await this.repository.loadAppointmentContext(message.appointmentId);

    if (context === null) {
      throw new NotificationContextGoneError(message.appointmentId);
    }

    const cancelUrl = cancellationUrl(this.config.appUrl, context.tenantSlug);

    return renderNotification(
      source,
      buildTemplateVariables(context, cancelUrl, message.channel),
      message.channel,
    );
  }
}
