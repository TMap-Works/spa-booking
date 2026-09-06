import { Inject, Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import {
  NOTIFICATION_SENDER,
  type NotificationReceipt,
  type NotificationSender,
} from './notification-sender';
import { NotificationsRepository } from './notifications.repository';
import type {
  DispatchOutcome,
  NotificationMessage,
  NotificationRecord,
} from './notifications.types';

/**
 * L'expédition d'un message de notification — l'ordre d'écriture de #68.
 *
 * ## Les trois temps, et pourquoi cet ordre-là
 *
 * ```
 * 1. inscrire la ligne en PENDING     ← la prise de droit ; la base tranche
 * 2. appeler le fournisseur           ← le seul effet irréversible
 * 3. passer la ligne à SENT           ← avec l'accusé du fournisseur
 * ```
 *
 * C'est l'ordre que notifications §2 impose, et aucune permutation ne tient :
 *
 * - **inscrire après l'appel** rouvrirait exactement la fenêtre que l'index
 *   d'idempotence est là pour fermer. Deux consommateurs SQS simultanés — le cas
 *   nominal, puisque la file garantit au-moins-une-fois — appelleraient tous
 *   deux SES avant que l'un des deux ne s'aperçoive du doublon. La cliente
 *   recevrait deux messages, et la base en enregistrerait un. La marque doit
 *   précéder l'effet, sans quoi elle n'est qu'un journal ;
 * - **passer à `SENT` avant l'appel** ferait passer pour envoyé un message qui
 *   ne partirait jamais si l'appel échouait. Pire que de ne rien envoyer : plus
 *   aucun rejeu ne pourrait le rattraper, puisque `SENT` occupe la place dans
 *   `notifications_live_once`.
 *
 * ## Ce que devient un rejeu
 *
 * Rien. `claim()` rend `already-live`, aucun appel fournisseur n'a lieu, et le
 * message est acquitté auprès de SQS comme s'il avait été traité — ce qu'il a
 * été, la première fois. C'est le quatrième critère d'acceptation de #68, et
 * c'est ce que mesure `__tests__/notification-dispatch.service.spec.ts` en
 * comptant les appels à l'expéditeur.
 *
 * ## Ce qui n'est pas fait ici, délibérément
 *
 * **Aucune reprise maison.** Un échec d'expédition remonte à l'appelant, donc à
 * SQS, qui réessaie avec son backoff natif avant la DLQ (notifications §4).
 * Boucler ici doublerait la file et masquerait la profondeur de DLQ sur laquelle
 * repose l'alarme CloudWatch — un rappel non envoyé se traduit en no-show, donc
 * en perte de chiffre d'affaires.
 *
 * **Aucun appel depuis un chemin de requête HTTP.** « L'API ne parle jamais
 * directement à SES ou SNS » (notifications §1) : ce service est destiné au
 * consommateur de file, pas à un contrôleur. Une réservation ne doit pas échouer
 * parce qu'un e-mail n'est pas parti.
 *
 * **Aucune revérification du rendez-vous.** Le rappel J-1 doit ne pas partir si
 * le rendez-vous a été annulé entre la sélection et l'envoi (notifications §3) :
 * c'est une règle du **producteur** de messages, qui n'existe pas encore, et la
 * poser ici ferait lire `appointments` à un module qui ne le possède pas
 * (api-module §3). Elle a sa place dans le ticket de la Lambda de rappel.
 */
@Injectable()
export class NotificationDispatchService {
  public constructor(
    private readonly repository: NotificationsRepository,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Expédie le message, ou constate qu'il l'a déjà été.
   *
   * @throws ce que l'expéditeur a levé, une fois l'échec inscrit — c'est ce qui
   * rend la main à SQS pour qu'il réessaie.
   */
  public async dispatch(message: NotificationMessage): Promise<DispatchOutcome> {
    const claim = await this.repository.claim(message);

    if (claim.outcome === 'already-live') {
      // Ni erreur ni anomalie : c'est la file faisant ce qu'elle promet, et
      // l'index faisant ce pour quoi il a été posé.
      this.logger.log('notification déjà traitée, rejeu ignoré', {
        notificationId: claim.notificationId,
        type: message.type,
        channel: message.channel,
      });
      return 'skipped';
    }

    const { notification } = claim;
    const receipt = await this.send(notification);

    const closed = await this.repository.markSent(notification.id, receipt.providerMessageId);

    if (!closed) {
      // La ligne n'était plus `PENDING` au moment de la clore. Le message est
      // parti — on ne peut pas le reprendre — mais l'état en base ne le dit pas.
      // Le signaler est tout ce qu'il reste à faire, et c'est mieux que de le
      // taire : c'est la seule trace qui permettra de comprendre un doublon
      // constaté côté cliente.
      this.logger.warn('notification expédiée mais déjà close par ailleurs', {
        notificationId: notification.id,
        channel: notification.channel,
      });
    }

    this.logger.log('notification expédiée', {
      notificationId: notification.id,
      type: notification.type,
      channel: notification.channel,
      // L'accusé du fournisseur est opaque et non personnel : c'est le seul
      // identifiant que notifications §7 autorise au journal. Ni destinataire,
      // ni contenu.
      providerMessageId: receipt.providerMessageId,
    });

    return 'sent';
  }

  /**
   * Le seul temps irréversible : l'appel au fournisseur.
   *
   * L'échec y est **inscrit avant d'être relevé**, et c'est indispensable : sans
   * cela la ligne resterait `PENDING`, donc vivante dans
   * `notifications_live_once`, et le rejeu que SQS s'apprête à faire serait pris
   * pour un doublon. Le message ne repartirait jamais — un échec transitoire
   * deviendrait définitif.
   */
  private async send(notification: NotificationRecord): Promise<NotificationReceipt> {
    try {
      return await this.sender.send({
        notificationId: notification.id,
        type: notification.type,
        channel: notification.channel,
        recipientUserId: notification.recipientUserId,
        appointmentId: notification.appointmentId,
      });
    } catch (error) {
      await this.repository.markFailed(notification.id, describe(error));

      this.logger.error("échec d'expédition de notification", {
        notificationId: notification.id,
        channel: notification.channel,
        attemptCount: notification.attemptCount,
      });

      throw error;
    }
  }
}

/**
 * Le motif d'échec, tel qu'il s'inscrit en base.
 *
 * Le **message** de l'erreur, jamais sa pile : `failure_reason` est relu par un
 * humain qui diagnostique, et une pile de 4 Ko tronquée à 500 caractères ne dit
 * rien. Une valeur levée qui n'est pas une `Error` est décrite par son type
 * plutôt que sérialisée — un objet de pilote peut porter la charge utile de la
 * requête, donc l'adresse du destinataire, et cette colonne n'a pas à la
 * recevoir (notifications §7).
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : `erreur non standard (${typeof error})`;
}
