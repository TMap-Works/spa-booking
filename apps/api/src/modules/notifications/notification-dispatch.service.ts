import { Inject, Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { isAppointmentStatus, occupiesSlot } from '../appointments/appointment-status';
import { NOTIFICATION_RENDERER, type NotificationRenderer } from './notification-renderer';
import { reminderTiming } from './reminder-window';
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
  RenderedNotification,
} from './notifications.types';

/**
 * L'expédition d'un message de notification — l'ordre d'écriture de #68.
 *
 * ## Les trois temps, et pourquoi cet ordre-là
 *
 * ```
 * 1. inscrire la ligne en PENDING     ← la prise de droit ; la base tranche
 * 2. rendre le message                ← lecture seule, dans la portée du tenant
 * 3. appeler le fournisseur           ← le seul effet irréversible
 * 4. passer la ligne à SENT           ← avec l'accusé du fournisseur
 * ```
 *
 * ## Où le rendu s'insère, et pourquoi là (#70)
 *
 * **Après** la prise de droit : rendre avant aurait fait lire la base à chaque
 * rejeu, alors que le rejeu nominal ne doit rien faire du tout. **Avant** l'appel
 * au fournisseur, évidemment — il n'y aurait rien à envoyer.
 *
 * Un échec de rendu est traité **exactement** comme un échec d'expédition :
 * inscrit en `FAILED`, puis relevé. C'est ce qui rend la ligne reprenable. Le
 * cas n'est pas théorique — le modèle d'un type de message peut ne pas exister
 * encore (`UnrenderableNotificationError`), et le rendez-vous a pu disparaître
 * entre la publication et la consommation (`NotificationContextGoneError`). Si
 * le rendu échouait en laissant la ligne `PENDING`, elle resterait vivante dans
 * `notifications_live_once` et le rejeu que SQS s'apprête à faire serait pris
 * pour un doublon : le message ne repartirait jamais.
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
 * ## Ce que #71 y a ajouté, et pour ce seul type de message
 *
 * Une **revérification du rendez-vous au moment de l'envoi**, et uniquement pour
 * `REMINDER_24H` — voir `reminderStillDue`. #68 la renvoyait au « producteur » et
 * au ticket de la Lambda de rappel ; l'instruire là-bas se serait révélé faux,
 * parce que le producteur, c'est le balayage horaire, et que l'écart entre sa
 * sélection et l'envoi est précisément ce que notifications §3 demande de
 * couvrir. Une décision d'envoi se prend à l'envoi.
 *
 * Elle ne concerne ni la confirmation — émise dans la seconde qui suit la
 * réservation — ni l'avis d'annulation, dont l'objet même est un rendez-vous qui
 * n'occupe plus rien.
 *
 * Le rendu, lui, ne juge toujours pas du statut : il lit le rendez-vous pour son
 * heure et sa prestation, c'est une lecture d'affichage.
 *
 * ## Ce que #73 y a ajouté, et pour le seul canal e-mail
 *
 * Une **relecture de la suppression au moment de l'envoi** — voir
 * `emailSuppressed`. Même raisonnement que ci-dessus, appliqué à une autre
 * donnée : les producteurs consultent la suppression au moment de composer, un
 * rebond peut tomber entre-temps, et « n'est plus jamais sollicitée » ne se tient
 * qu'ici.
 *
 * Les deux contrôles sont indépendants et se cumulent : le premier borne
 * *à qui* on écrit, le second *si le message a encore un objet*.
 */
@Injectable()
export class NotificationDispatchService {
  public constructor(
    private readonly repository: NotificationsRepository,
    @Inject(NOTIFICATION_RENDERER) private readonly renderer: NotificationRenderer,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Expédie le message, ou constate qu'il l'a déjà été.
   *
   * @throws ce que l'expéditeur a levé, une fois l'échec inscrit — c'est ce qui
   * rend la main à SQS pour qu'il réessaie.
   */
  public async dispatch(message: NotificationMessage, now: Date = new Date()): Promise<DispatchOutcome> {
    if (message.channel === 'EMAIL' && (await this.emailSuppressed(message))) {
      return 'skipped';
    }

    if (message.type === 'REMINDER_24H' && !(await this.reminderStillDue(message, now))) {
      return 'skipped';
    }

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
    const content = await this.attempt(notification, () => this.renderer.render(message));
    const receipt = await this.attempt(notification, () => this.send(notification, content));

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
   * Cette adresse a-t-elle cessé d'être sollicitée — **au moment de l'envoi** ?
   * (#73)
   *
   * ## Ce qu'elle garantit, et que rien d'autre ne garantissait
   *
   * « Une adresse en hard bounce passe en supprimé et **n'est plus jamais
   * sollicitée** » est le deuxième critère d'acceptation du ticket, et le mot
   * « jamais » est ce qui impose cette relecture. Les producteurs consultent bien
   * la suppression — `findRecipientContact` pour la confirmation, le balayage
   * pour le rappel J-1 — mais ils la consultent au moment de **composer**. Entre
   * cette composition et l'appel à SES il y a une file, une Lambda, un appel
   * HTTP et jusqu'à cinq réceptions : un rebond tombé dans cet intervalle
   * n'aurait été vu par personne.
   *
   * Le cas n'est pas théorique, il est même le plus probable des trois : un rebond
   * arrive *après* un envoi, donc précisément quand la chaîne travaille. Une
   * confirmation et un rappel partent souvent à quelques minutes d'écart pour la
   * même cliente — c'est le premier qui apprend que la boîte est morte, et c'est
   * le second qu'il faut arrêter.
   *
   * ## Elle passe **avant** la prise de droit, et avant la revérification du
   * rappel
   *
   * Avant `claim()`, pour la raison qu'expose `reminderStillDue` : un message
   * supprimé n'a pas à laisser de ligne, et le seul statut disponible pour
   * défaire un `PENDING` est `FAILED`, qui afficherait « échec » au comptoir pour
   * une décision qui n'en est pas un.
   *
   * Avant la revérification du rappel, parce qu'elle est plus générale : elle
   * vaut pour les trois types de message, là où l'autre ne concerne que
   * `REMINDER_24H`. Sur un rappel vers une adresse supprimée, les deux
   * concluraient de toute façon à `skipped` ; l'ordre ne fait qu'éviter la
   * seconde lecture.
   *
   * ## Le canal SMS n'est pas concerné
   *
   * SES ne dit rien d'un numéro de téléphone, et SNS n'expose aucun équivalent au
   * périmètre du MVP. La condition sur le canal n'est donc pas une optimisation :
   * c'est la portée exacte de ce que la suppression sait.
   *
   * ## Un destinataire absent ne suppose rien
   *
   * `recipientUserId` est déclaré non nul par `NotificationMessage`, mais la
   * colonne est nullable et la ligne relue peut l'avoir perdu (anonymisation
   * RGPD). Sans compte à consulter, il n'y a pas de suppression à constater : le
   * message poursuit son chemin, et c'est le rendu qui dira, s'il le faut, que
   * son objet a disparu.
   */
  private async emailSuppressed(message: NotificationMessage): Promise<boolean> {
    const suppressed = await this.repository.isEmailSuppressed(message.recipientUserId);

    if (suppressed) {
      // Aucune adresse au journal — c'est une donnée personnelle
      // (notifications §7). L'identifiant du compte suffit à retrouver la fiche,
      // et il ne dit rien à qui lit le journal sans accès à la base.
      this.logger.log('envoi e-mail supprimé, adresse en liste de suppression', {
        recipientUserId: message.recipientUserId,
        type: message.type,
        appointmentId: message.appointmentId,
      });
    }

    return suppressed;
  }

  /**
   * Ce rappel J-1 a-t-il encore lieu d'être — **au moment de l'envoi** ? (#71)
   *
   * ## Pourquoi cette relecture existe
   *
   * Parce que la sélection et l'envoi ne sont pas le même instant. Entre le
   * balayage horaire et l'appel au fournisseur il y a une publication SQS, une
   * invocation de Lambda, un appel HTTP, et jusqu'à cinq réceptions avant la file
   * d'attente morte : notifications §3 chiffre l'écart à une heure, et exige que
   * la décision se prenne ici plutôt que là-bas. Un rendez-vous annulé entre les
   * deux ne doit rien recevoir — un rappel pour un rendez-vous qui n'existe plus
   * fait rater une matinée à une cliente et un appel au comptoir au salon.
   *
   * ## Elle passe **avant** la prise de droit, et c'est délibéré
   *
   * Un rappel supprimé n'a pas à laisser de ligne. La placer après `claim()`
   * aurait inscrit un `PENDING` qu'il aurait ensuite fallu défaire — et le seul
   * statut disponible pour cela est `FAILED`, qui affiche « échec » au comptoir
   * pour une décision qui n'en est pas un. Le schéma ne connaît pas de
   * `SUPPRESSED` (l'ajouter serait une migration, hors du périmètre de #71), et
   * mentir sur le statut d'un envoi coûte plus cher que la lecture qu'on évite.
   *
   * Elle ne rouvre aucune fenêtre d'idempotence : la prise de droit précède
   * toujours l'appel au fournisseur, qui reste le seul effet irréversible. Ce
   * que cet ordre coûte, c'est une lecture indexée de plus sur le rejeu d'un
   * rappel déjà parti — le rejeu est rare, et la lecture porte sur deux colonnes.
   *
   * ## Les trois refus, et ce qu'ils veulent dire
   *
   * | Ce que la relecture trouve | Pourquoi rien ne part |
   * |---|---|
   * | plus de rendez-vous | il a été supprimé ou anonymisé ; il n'y a rien à annoncer |
   * | un statut qui n'occupe plus le créneau | annulé, honoré ou no-show — `appointment-status.ts` en tient la liste, celle-là même que la contrainte d'exclusion emploie |
   * | une échéance hors fenêtre | trop tard (le rappel serait « en retard », ce que notifications §3 interdit) ou trop tôt (le rendez-vous a été repoussé : un balayage à venir le reprendra) |
   *
   * Aucun n'est une erreur : rien n'est levé, rien n'est inscrit, et l'appelant
   * reçoit `skipped` — donc, pour la Lambda, un acquittement. Lever aurait fait
   * rejouer le message jusqu'à la file d'attente morte, et l'alarme de
   * profondeur aurait signalé une panne là où il n'y a qu'une annulation.
   */
  private async reminderStillDue(message: NotificationMessage, now: Date): Promise<boolean> {
    const eligibility = await this.repository.findReminderEligibility(message.appointmentId);

    if (eligibility === null) {
      this.logger.log('rappel J-1 sans objet, rendez-vous introuvable', {
        appointmentId: message.appointmentId,
        channel: message.channel,
      });
      return false;
    }

    if (!isAppointmentStatus(eligibility.status) || !occupiesSlot(eligibility.status)) {
      this.logger.log('rappel J-1 supprimé, le rendez-vous ne tient plus le créneau', {
        appointmentId: message.appointmentId,
        channel: message.channel,
        status: eligibility.status,
      });
      return false;
    }

    const timing = reminderTiming(eligibility.startsAt, now);

    if (timing !== 'due') {
      this.logger.warn('rappel J-1 supprimé, hors de sa fenêtre', {
        appointmentId: message.appointmentId,
        channel: message.channel,
        timing,
      });
      return false;
    }

    return true;
  }

  /**
   * Le seul temps irréversible : l'appel au fournisseur.
   *
   * Le contenu lui est **passé** plutôt que relu : il vient d'être rendu, dans
   * la portée de tenant courante, et le refaire ici ferait deux lectures de la
   * base pour un message.
   */
  private send(
    notification: NotificationRecord,
    content: RenderedNotification,
  ): Promise<NotificationReceipt> {
    return this.sender.send({
      notificationId: notification.id,
      type: notification.type,
      channel: notification.channel,
      recipientUserId: notification.recipientUserId,
      appointmentId: notification.appointmentId,
      content,
    });
  }

  /**
   * Exécute un temps de l'expédition en **inscrivant son échec avant de le
   * relever**.
   *
   * C'est indispensable, et c'est la raison d'être de ce détour : sans cette
   * inscription la ligne resterait `PENDING`, donc vivante dans
   * `notifications_live_once`, et le rejeu que SQS s'apprête à faire serait pris
   * pour un doublon. Le message ne repartirait jamais — un échec transitoire
   * deviendrait définitif.
   *
   * Écrit **une fois** et employé par le rendu comme par l'expédition : deux
   * copies divergeraient, et celle qui perdrait le `markFailed` condamnerait
   * silencieusement les messages du chemin qu'elle couvre.
   *
   * Le journal ne dit ni le contenu ni le destinataire, seulement de quel envoi
   * il s'agit et à quelle tentative (notifications §7).
   */
  private async attempt<T>(notification: NotificationRecord, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
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
