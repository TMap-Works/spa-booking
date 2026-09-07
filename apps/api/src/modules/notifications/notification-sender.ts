import { Injectable } from '@nestjs/common';

import { NotificationSenderNotConfiguredError } from './notifications.errors';
import type {
  NotificationChannel,
  NotificationType,
  RenderedNotification,
} from './notifications.types';

/**
 * Le **port** d'expédition — la frontière entre ce module et AWS.
 *
 * ## Pourquoi une interface, et pourquoi maintenant
 *
 * L'ordre d'écriture que #68 fige — inscrire `PENDING`, appeler le fournisseur,
 * passer à `SENT` — n'a de sens que s'il y a un « appeler le fournisseur » à
 * placer entre les deux écritures. Sans port, l'ordre ne serait qu'une intention
 * dans un commentaire, et aucune suite ne pourrait prouver qu'un rejeu n'appelle
 * pas deux fois : c'est très exactement ce que compte le test du rejeu.
 *
 * Le port a une seconde vertu, celle qu'exige notifications §8 : « en test, SES
 * et SNS sont bouchonnés — aucun test n'envoie de vrai message ». Une frontière
 * nommée rend cela structurel plutôt que discipliné.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il ne **compose** pas le message : il le reçoit rendu. Les modèles vivent dans
 * `notification-content.ts` et le rendu dans `NOTIFICATION_RENDERER` ; une
 * passerelle SES n'a pas à savoir ce qu'est une confirmation de réservation, et
 * la garder ignorante est ce qui permettra d'en écrire une seule pour les trois
 * messages du MVP.
 *
 * Il ne connaît pas davantage l'**adresse** de destination : il reçoit
 * l'identifiant du compte et relit dessus l'adresse ou le numéro au moment
 * d'envoyer. C'est la règle de notifications §7 — une coordonnée ne se recopie
 * pas, sans quoi une demande RGPD devrait l'effacer à deux endroits, et c'est
 * toujours la seconde copie qu'on oublie.
 */

/**
 * Ce que l'expéditeur reçoit — la désignation, plus le contenu rendu.
 *
 * ## Pourquoi le contenu est ici et pas dans `NotificationMessage`
 *
 * `NotificationMessage` est ce qui transite par SQS, et il ne porte rien qui
 * puisse dériver : un message de file peut être rejoué une heure plus tard, et
 * un contenu figé à la publication annoncerait un rendez-vous qui n'existe plus.
 * `NotificationSendRequest`, lui, ne quitte jamais le processus — il est
 * composé après la prise de droit, à l'instant d'appeler le fournisseur. Le
 * contenu y est donc frais par construction, et il n'a nulle part où persister.
 */
export interface NotificationSendRequest {
  /** La ligne réservée, en `PENDING`. Sert de corrélation dans les journaux. */
  readonly notificationId: string;
  readonly type: NotificationType;
  readonly channel: NotificationChannel;
  /** Le compte destinataire ; l'expéditeur y relit l'adresse ou le numéro. */
  readonly recipientUserId: string | null;
  readonly appointmentId: string | null;
  /** Le message, rendu à l'instant, dans le fuseau de l'établissement. */
  readonly content: RenderedNotification;
}

/** Ce que l'expéditeur rend quand l'appel a abouti. */
export interface NotificationReceipt {
  /**
   * Le `MessageId` de SES ou de SNS. Opaque, non personnel, et la seule
   * référence par laquelle une livraison se retrouve chez AWS.
   */
  readonly providerMessageId: string;
}

/**
 * Expédie un message sur son canal.
 *
 * **Contrat** : rendre un accusé, ou lever. Une implémentation qui avalerait son
 * erreur ferait passer la ligne en `SENT` sans que rien ne soit parti — le pire
 * des deux mondes, puisque l'index d'idempotence interdirait alors tout renvoi.
 */
export interface NotificationSender {
  send(request: NotificationSendRequest): Promise<NotificationReceipt>;
}

/**
 * Jeton d'injection du port. Un `Symbol`, comme `PRISMA` : une interface
 * TypeScript n'existe pas à l'exécution et ne peut donc pas servir de jeton.
 */
export const NOTIFICATION_SENDER = Symbol('NOTIFICATION_SENDER');

/**
 * L'expéditeur par défaut : celui qui refuse, bruyamment.
 *
 * Le module doit pouvoir démarrer sans SES ni SNS — ils n'existent pas encore au
 * périmètre de #68 — sans pour autant qu'un envoi silencieusement ignoré passe
 * pour un envoi réussi. Défaut fermé, comme partout ailleurs dans ce dépôt : ce
 * qui n'est pas configuré échoue, il ne retombe pas sur « ne rien faire ».
 *
 * La conséquence est celle qu'on veut : la ligne finit en `FAILED`, donc **hors**
 * de `notifications_live_once`, et le message redevient envoyable dès qu'un
 * expéditeur réel est branché. Un faux `SENT` aurait au contraire condamné le
 * message pour de bon.
 */
@Injectable()
export class UnconfiguredNotificationSender implements NotificationSender {
  public send(request: NotificationSendRequest): Promise<NotificationReceipt> {
    return Promise.reject(new NotificationSenderNotConfiguredError(request.channel));
  }
}
