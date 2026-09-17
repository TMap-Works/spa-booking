import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationsConfig, type QueueSettings } from './notifications.config';
import type { NotificationMessage } from './notifications.types';

/**
 * Le **port de publication** — ce que font les abonnés du bus d'`appointments`
 * une fois qu'ils ont composé une enveloppe (#799).
 *
 * ## Ce que ce port corrige, et c'est le septième critère d'acceptation
 *
 * Jusqu'ici, `BookingConfirmationListener` et `CancellationNoticeListener`
 * appelaient `NotificationDispatchService.dispatch()` **en direct** : le rendu,
 * l'appel au fournisseur et les trois écritures avaient lieu dans le processus
 * qui venait de servir `POST /appointments`. Le README du module Terraform
 * décrit pourtant l'inverse — « API (POST /appointments) publie, puis rend la
 * main » — et le CDC §4.8 en donne la raison en une phrase : « une réservation
 * ne doit jamais échouer parce qu'un e-mail n'est pas parti ».
 *
 * Publier découple les deux. L'abonné écrit un message dans la file et rend la
 * main ; ce qui suit est le métier de la Lambda d'envoi, qui rappelle l'API par
 * la route interne. Une panne de SES cesse d'être une latence sur le tunnel de
 * réservation, et un envoi raté devient un message que SQS rejoue au lieu d'une
 * ligne `FAILED` que personne ne reprend — le bus est en mémoire, il n'a aucun
 * rejeu.
 *
 * ## Ce qu'il ne change pas, et c'est délibéré
 *
 * « L'ordre `PENDING → fournisseur → SENT` et son index d'idempotence restent
 * dans l'API, inchangés » : la prise de droit est à l'**autre** bout de la file,
 * dans `NotificationDispatchService`. Publier n'écrit aucune ligne de
 * `notifications`. C'est ce qui rend l'idempotence indifférente au nombre de
 * publications — deux enveloppes de même `dedupeKey` se disputent la place à
 * l'arrivée, et PostgreSQL tranche, comme il le fait déjà pour le balayage
 * horaire (#71).
 *
 * ## Les deux implémentations, et pourquoi il en faut deux
 *
 * | Environnement | Implémentation | Ce qui se passe |
 * |---|---|---|
 * | `NOTIFICATION_QUEUE_URL` posée | {@link SqsNotificationPublisher} | l'enveloppe part dans la file, l'abonné rend la main |
 * | file absente | {@link InProcessNotificationPublisher} | l'expédition a lieu dans le processus, exactement comme avant #799 |
 *
 * Le repli n'est pas une commodité de confort : c'est ce qui tient le
 * **troisième** critère d'acceptation. « Sans configuration SES/SNS, le
 * comportement actuel est conservé : refus en 503, ligne `FAILED`, message
 * reprenable. » Un repli qui n'aurait rien fait du tout aurait supprimé la ligne
 * `FAILED` avec elle — c'est-à-dire la seule chose qui, aujourd'hui, prouve au
 * back-office qu'une confirmation aurait dû partir. Sur un poste local et dans
 * les suites d'intégration, la chaîne se comporte donc comme elle le faisait,
 * et le journal d'envois reste peuplé.
 */

/** Jeton d'injection du port — une interface n'existe pas à l'exécution. */
export const NOTIFICATION_PUBLISHER = Symbol('NOTIFICATION_PUBLISHER');

export interface NotificationPublisher {
  /**
   * Remet l'enveloppe à la chaîne d'envoi.
   *
   * **Contrat** : rendre, ou lever. Un appelant qui verrait une promesse tenue
   * sans que rien n'ait été remis croirait son message en route.
   */
  publish(message: NotificationMessage): Promise<void>;
}

/**
 * La frontière avec SQS, réduite à ce que la publication demande.
 *
 * Même forme et mêmes raisons que `EmailGateway` et `SmsGateway` : une
 * interface d'une méthode, parce qu'un double qui l'implémente reproduit *tout*
 * ce que la vraie sait faire, là où un faux `SQSClient` reproduirait ce qu'on a
 * pensé à reproduire. C'est ce qui permet à cette chaîne d'être exercée sans
 * qu'aucun test du dépôt n'ouvre de connexion vers AWS (notifications §8).
 */
export interface QueueGateway {
  /** Publie le corps, et rend l'identifiant SQS de la livraison s'il y en a un. */
  send(body: string): Promise<string | null>;
}

/**
 * La publication réelle — une enveloppe, un message SQS.
 *
 * ## Un envoi par message, et non `SendMessageBatch`
 *
 * Les deux abonnés composent au plus deux enveloppes par fait métier — un canal
 * e-mail, un canal SMS — et ils les traitent séquentiellement pour que l'ordre
 * des lignes du journal soit celui qu'affiche le back-office. Un lot de deux ne
 * paie pas sa complexité : `SendMessageBatch` rend un succès **partiel** qu'il
 * faut désassembler pour savoir laquelle des deux est partie. Le balayage du
 * rappel J-1, lui, publie par lots de dix — mais c'est la Lambda qui le fait,
 * et elle en a des centaines.
 *
 * ## Le client est construit avec la passerelle, et jamais sans file
 *
 * Un `SQSClient` tient une chaîne de résolution d'identifiants et un pool de
 * connexions. La fabrique n'en construit aucun tant que `NOTIFICATION_QUEUE_URL`
 * est absente — c'est-à-dire sur tout poste local et dans toutes les suites.
 */
export class SqsQueueGateway implements QueueGateway {
  private readonly client: SQSClient;

  private readonly queueUrl: string;

  public constructor(settings: QueueSettings) {
    this.queueUrl = settings.queueUrl;
    // Composé plutôt que déclaré d'un bloc, comme les deux passerelles : sous
    // `exactOptionalPropertyTypes`, un `region: undefined` explicite empêcherait
    // le SDK de la déduire de son environnement.
    this.client = new SQSClient(settings.region === null ? {} : { region: settings.region });
  }

  public async send(body: string): Promise<string | null> {
    const response = await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: body }),
    );

    return response.MessageId ?? null;
  }
}

/** Le publieur : il sérialise, il remet, il journalise. */
export class SqsNotificationPublisher implements NotificationPublisher {
  public constructor(
    private readonly gateway: QueueGateway,
    private readonly logger: StructuredLogger,
  ) {}

  public async publish(message: NotificationMessage): Promise<void> {
    // `NotificationMessage` ne porte que des identifiants — ni contenu, ni
    // coordonnée. C'est ce qui rend cette sérialisation sûre : le corps traverse
    // SQS, une Lambda et ses journaux (CDC §5.1, notifications §7).
    // `scheduledFor` devient l'ISO 8601 que la Lambda sait relire.
    const sqsMessageId = await this.gateway.send(JSON.stringify(message));

    // L'identifiant SQS, et rien d'autre : il est opaque, non personnel, et
    // c'est la seule référence par laquelle une publication se retrouve. Ni
    // l'URL de la file — elle porte l'identifiant du compte — ni le corps.
    this.logger.log('notification publiée sur la file', {
      sqsMessageId,
      dedupeKey: message.dedupeKey,
      type: message.type,
      channel: message.channel,
    });
  }
}

/**
 * Le repli — l'expédition en processus, telle qu'elle avait lieu avant #799.
 *
 * Il ne « simule » pas la file : il fait ce que faisaient les abonnés, à savoir
 * appeler l'expédition directement. Un poste local sans compte AWS garde donc
 * son journal d'envois peuplé de lignes `FAILED` motivées, et les suites
 * d'intégration du dépôt continuent de monter l'application sans parler à
 * Internet.
 *
 * Il n'avale rien : un échec remonte à l'abonné, qui le journalise sans le
 * propager — c'est ce qu'il faisait déjà, et ce que la garde du bus attend.
 */
export class InProcessNotificationPublisher implements NotificationPublisher {
  public constructor(private readonly dispatch: NotificationDispatchService) {}

  public async publish(message: NotificationMessage): Promise<void> {
    await this.dispatch.dispatch(message);
  }
}

/**
 * Le publieur à monter, selon ce que l'environnement fournit.
 *
 * Une fabrique et non deux fournisseurs conditionnels — même forme que
 * `reportExportStorageFactory` : les abonnés dépendent d'un seul jeton, et c'est
 * ce qui fait qu'ils n'ont pas à savoir qu'un déploiement sans file existe.
 *
 * `queueSettings` est lu **ici**, donc à l'amorçage du module, et c'est la seule
 * des quatre lectures de `NotificationsConfig` qui le soit : le choix du
 * publieur ne peut pas être différé, puisqu'il détermine quel objet est injecté
 * dans deux écouteurs qui s'abonnent au bus dès `onModuleInit`. Une URL de file
 * mal formée fait donc échouer l'amorçage — c'est assumé, et ce n'est pas le
 * régime des passerelles : une file absente est un mode de marche normal, une
 * file mal écrite est une faute de déploiement qui rendrait toute la chaîne
 * muette sans qu'aucune ligne n'apparaisse nulle part.
 */
export function notificationPublisherFactory(
  config: NotificationsConfig,
  dispatch: NotificationDispatchService,
  logger: StructuredLogger,
): NotificationPublisher {
  const settings = config.queueSettings;

  return settings === null
    ? new InProcessNotificationPublisher(dispatch)
    : new SqsNotificationPublisher(new SqsQueueGateway(settings), logger);
}
