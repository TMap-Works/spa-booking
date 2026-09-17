import { normalizeToE164 } from '@spa/shared';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { NotificationsConfig, type SesSettings, type SnsSettings } from './notifications.config';
import {
  NotificationRecipientUnreachableError,
  NotificationSenderNotConfiguredError,
} from './notifications.errors';
import type {
  NotificationReceipt,
  NotificationSender,
  NotificationSendRequest,
} from './notification-sender';
import { NotificationsRepository } from './notifications.repository';
import { SesEmailGateway, type EmailGateway } from './ses-email.gateway';
import { SnsSmsGateway, type SmsGateway } from './sns-sms.gateway';

/**
 * L'expéditeur réel — celui qui remplace `UnconfiguredNotificationSender`
 * derrière `NOTIFICATION_SENDER` (#799).
 *
 * ```
 * NotificationDispatchService ──► NOTIFICATION_SENDER
 *                                        │
 *                                  ce fichier : quel canal ? quelle coordonnée ?
 *                                        │
 *                                 ┌──────┴──────┐
 *                                 ▼             ▼
 *                        SesEmailGateway   SnsSmsGateway
 * ```
 *
 * #68 avait nommé la frontière et laissé derrière elle un refus en 503, avec
 * cette promesse : « un ticket ultérieur remplacera ce fournisseur par les
 * passerelles SES et SNS ; **rien d'autre du module n'aura à changer**, et c'est
 * tout l'intérêt d'avoir nommé la frontière ». Elle est tenue : l'ordre
 * d'écriture, l'index d'idempotence, le rendu et la reprise après échec ne
 * bougent pas d'une ligne.
 *
 * ## Ce qu'il fait, dans cet ordre
 *
 * 1. **choisit le canal** sur `NotificationSendRequest.channel`, jamais sur le
 *    contenu ni sur ce que le destinataire possède : le producteur a déjà
 *    tranché, canal par canal, et une seconde décision ici ferait partir un
 *    e-mail sous la ligne `SMS` du journal ;
 * 2. **relit la coordonnée** sur `recipientUserId` — l'adresse et le numéro ne
 *    voyagent nulle part, c'est la règle de notifications §7 et la raison d'être
 *    du port : « il ne connaît pas l'adresse de destination : il reçoit
 *    l'identifiant du compte et relit dessus » ;
 * 3. **appelle la passerelle**, et rend son `MessageId` dans
 *    `providerMessageId`.
 *
 * ## Le défaut reste fermé, canal par canal
 *
 * Sans `SES_FROM_EMAIL`, l'e-mail est refusé en 503 ; sans `SNS_SMS_SENDER_ID`,
 * le SMS l'est. Exactement le comportement de `UnconfiguredNotificationSender`,
 * et exactement la même conséquence : la ligne finit en `FAILED`, donc **hors**
 * de `notifications_live_once`, et le message redevient envoyable le jour où la
 * passerelle est branchée. Jamais un `SENT` silencieux — c'est le troisième
 * critère d'acceptation de #799.
 *
 * Le refus est **par canal** et non global, parce que les deux capacités
 * s'acquièrent séparément : SES se vérifie par DNS et sort du bac à sable, SNS
 * demande un plafond de dépense et un sender ID enregistré. Un environnement où
 * l'e-mail part et le SMS pas est l'état normal d'une mise en service, et un
 * refus global y aurait supprimé les confirmations qui, elles, fonctionnent.
 *
 * ## Pourquoi la configuration est lue **ici** et pas à l'amorçage
 *
 * `NotificationsConfig` la résout au premier accès (quatrième critère
 * d'acceptation), et ce fichier ne l'accède qu'en expédiant. Il en découle qu'un
 * `SES_FROM_EMAIL` mal formé ne fait pas échouer le démarrage de l'API mais le
 * premier e-mail — en `FAILED`, avec son motif, donc reprenable. Les clients AWS
 * sont construits au même moment et **une seule fois** : ils tiennent une chaîne
 * de résolution d'identifiants et un pool de connexions qu'on ne veut payer ni à
 * chaque message, ni sur une API qui n'enverra jamais rien.
 *
 * ## Rien de ce qu'il lit n'atteint un journal
 *
 * Ni l'adresse, ni le numéro, ni le contenu, ni l'adresse d'expéditeur, ni le
 * sender ID. Ce qui est journalisé est ce que notifications §7 autorise :
 * l'identifiant de la notification, le canal, et l'accusé opaque du fournisseur
 * — et ce dernier l'est déjà par `NotificationDispatchService`, qui n'a pas
 * besoin qu'on le redise.
 */

/** Comment fabriquer la passerelle e-mail — substituée en test. */
export type EmailGatewayFactory = (settings: SesSettings) => EmailGateway;

/** Comment fabriquer la passerelle SMS — substituée en test. */
export type SmsGatewayFactory = (settings: SnsSettings) => SmsGateway;

export class AwsNotificationSender implements NotificationSender {
  /** `null` tant qu'aucun e-mail n'est parti ; jamais reconstruite ensuite. */
  private email: EmailGateway | null = null;

  private sms: SmsGateway | null = null;

  public constructor(
    private readonly config: NotificationsConfig,
    private readonly repository: NotificationsRepository,
    private readonly logger: StructuredLogger,
    /**
     * Les deux fabriques sont des **paramètres**, et c'est ce qui tient
     * notifications §8 : une suite passe un double, et aucun test du dépôt
     * n'ouvre de connexion vers AWS. Leur valeur par défaut est la vraie
     * passerelle, si bien que le câblage du module n'a rien à en dire.
     */
    private readonly emailGateway: EmailGatewayFactory = (settings) =>
      new SesEmailGateway(settings),
    private readonly smsGateway: SmsGatewayFactory = (settings) => new SnsSmsGateway(settings),
  ) {}

  public async send(request: NotificationSendRequest): Promise<NotificationReceipt> {
    const providerMessageId =
      request.channel === 'EMAIL' ? await this.sendEmail(request) : await this.sendSms(request);

    return { providerMessageId };
  }

  /** L'e-mail : l'adresse relue, l'objet, les deux corps. */
  private async sendEmail(request: NotificationSendRequest): Promise<string> {
    const gateway = this.emailFor(request);
    const contact = await this.recipient(request);

    // La colonne est `NOT NULL`, mais une chaîne vide n'est pas une adresse — et
    // c'est exactement ce que `findRecipientContact` refuse déjà de compter comme
    // un canal, côté producteur.
    if (contact.email.trim() === '') {
      // Symétrique du refus de numéro : l'identifiant du compte, et rien qui
      // ressemble à une adresse (notifications §7). Sans cette ligne, l'échec
      // remonterait au journal d'expédition sans dire *pourquoi* — et « 422 »
      // seul ne distingue pas une adresse vide d'un compte disparu.
      this.logger.warn('e-mail non expédié, aucune adresse sur le compte', {
        notificationId: request.notificationId,
        recipientUserId: request.recipientUserId,
      });

      throw new NotificationRecipientUnreachableError(request.channel);
    }

    return gateway.send({
      to: contact.email.trim(),
      subject: request.content.subject,
      html: request.content.html,
      text: request.content.text,
    });
  }

  /**
   * Le SMS : le numéro relu **et normalisé**, le corps texte.
   *
   * `normalizeToE164` vient du contrat partagé, et c'est là qu'il doit venir :
   * la règle est écrite une fois, pour la saisie comme pour l'envoi. Un numéro
   * qu'il refuse est un échec **permanent** (`NotificationRecipientUnreachableError`,
   * 422) et non un rejeu : SNS ne connaît pas le pays d'où il serait composé, et
   * cinq tentatives ne le lui apprendront pas (notifications §4, §5).
   *
   * Le corps est `content.text` : un SMS n'a ni objet ni HTML, et le moteur de
   * modèles a déjà mesuré son coût en segments GSM-7 ou UCS-2 à l'écriture (#69).
   */
  private async sendSms(request: NotificationSendRequest): Promise<string> {
    const gateway = this.smsFor(request);
    const contact = await this.recipient(request);
    const number = contact.phone === null ? null : normalizeToE164(contact.phone);

    if (number === null) {
      // Ni le numéro, ni sa longueur, ni ce qu'il avait de fautif : le canal
      // suffit à savoir quoi regarder, et l'identifiant de la notification est
      // déjà au journal de l'expédition (notifications §7).
      this.logger.warn('SMS non expédié, numéro non normalisable en E.164', {
        notificationId: request.notificationId,
        recipientUserId: request.recipientUserId,
      });

      throw new NotificationRecipientUnreachableError(request.channel);
    }

    return gateway.send({ to: number, text: request.content.text });
  }

  /**
   * La coordonnée du destinataire, relue à l'instant d'envoyer.
   *
   * Un `recipientUserId` nul — la colonne l'autorise, une anonymisation RGPD le
   * produit — et un compte introuvable donnent le même verdict : il n'y a
   * personne à qui écrire, et c'est définitif. Le distinguer n'apprendrait rien
   * à qui lit, et les deux se réparent au même endroit : nulle part.
   */
  private async recipient(
    request: NotificationSendRequest,
  ): Promise<{ email: string; phone: string | null }> {
    const contact =
      request.recipientUserId === null
        ? null
        : await this.repository.findRecipientAddress(request.recipientUserId);

    if (contact === null) {
      throw new NotificationRecipientUnreachableError(request.channel);
    }

    return contact;
  }

  /** La passerelle e-mail, ou le refus fermé si aucune n'est configurée. */
  private emailFor(request: NotificationSendRequest): EmailGateway {
    if (this.email === null) {
      const settings = this.config.sesSettings;

      if (settings === null) {
        throw new NotificationSenderNotConfiguredError(request.channel);
      }

      this.email = this.emailGateway(settings);
    }

    return this.email;
  }

  /** La passerelle SMS, ou le refus fermé si aucune n'est configurée. */
  private smsFor(request: NotificationSendRequest): SmsGateway {
    if (this.sms === null) {
      const settings = this.config.snsSettings;

      if (settings === null) {
        throw new NotificationSenderNotConfiguredError(request.channel);
      }

      this.sms = this.smsGateway(settings);
    }

    return this.sms;
  }
}
