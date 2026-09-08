import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { AppointmentCancelledEvent } from '../appointments/events/appointment-cancelled.event';
import { AppointmentEvents } from '../appointments/events/appointment-events';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationsRepository } from './notifications.repository';
import {
  appointmentDedupeKey,
  reachableChannels,
  type NotificationChannel,
  type NotificationMessage,
} from './notifications.types';

/**
 * L'avis d'annulation — troisième et dernier message du MVP (#72, CDC §1.4).
 *
 * ## Déclenché par l'événement, jamais depuis le contrôleur
 *
 * Premier critère d'acceptation, et la raison est celle de #70 : un appel depuis
 * `AppointmentsService` ferait échouer une annulation **déjà écrite en base**
 * parce qu'un e-mail n'est pas parti. La cliente verrait une erreur, croirait son
 * rendez-vous maintenu, et se présenterait un créneau qui a été revendu.
 *
 * `AppointmentEvents.onAppointmentCancelled` existe depuis #40, publié après la
 * validation de la transaction — jamais dedans. `appointments` n'est pas modifié
 * par ce ticket.
 *
 * ## Qui reçoit l'avis, et pourquoi ce n'est pas « tout le monde »
 *
 * Le CDC §1.4 nomme deux publics : « avis d'annulation **au staff et au
 * client** ». Le quatrième critère d'acceptation en retire un cas, et c'est lui
 * qui donne la règle : « aucun avis envoyé si l'annulation vient du client
 * lui-même sur son propre rendez-vous, **hors notification au staff** ».
 *
 * L'avis part donc vers les deux, **moins celui qui a décidé** :
 *
 * | `cancelledBy` | Destinataires | Pourquoi |
 * |---|---|---|
 * | `CLIENT` | le praticien seul | son agenda vient de changer sans lui ; la cliente, elle, sait déjà — c'est elle qui a cliqué, et le quatrième critère l'exclut nommément |
 * | `STAFF` | la cliente **et** le praticien | le salon a décidé ; elle doit l'apprendre autrement qu'en se déplaçant, et lui doit l'apprendre parce que rien ne dit que c'est lui qui a posé l'annulation — l'accueil et la gérance annulent aussi |
 * | `SYSTEM` | la cliente **et** le praticien | personne ne l'a décidé d'aucun côté du comptoir |
 *
 * ## Pourquoi deux destinataires ont demandé une migration (#534)
 *
 * Jusqu'à #534, l'avis partait vers **une** seule des deux parties, et ce
 * n'était pas un oubli : `notifications_live_once` — l'index unique partiel posé
 * par #68 — portait sur `(tenant_id, appointment_id, type, channel)`. Il ne
 * pouvait donc pas exister deux avis d'annulation **vivants** sur le même canal
 * pour le même rendez-vous. Écrire la cliente puis le praticien faisait refuser
 * le second par PostgreSQL, `claim()` rendait `already-live`, et le praticien ne
 * recevait rien — **en silence**, puisque c'est exactement la forme qu'a un
 * rejeu SQS légitime.
 *
 * `20260908120000_notification_live_once_per_recipient` a remplacé cet index par
 * un index qui porte le destinataire. Les deux avis d'une même annulation sont
 * désormais deux lignes légales, et le rejeu reste refusé **par destinataire** :
 * c'est ce qui fait qu'ajouter un public n'a pas coûté l'idempotence.
 *
 * ## Le praticien qui **est** la cliente ne reçoit qu'un avis
 *
 * Une praticienne peut réserver pour elle-même. Les deux destinataires se
 * résolvent alors au même compte, et il serait absurde de lui écrire deux fois
 * la même chose : la liste est dédupliquée. Ce n'est pas une précaution
 * théorique — c'est le seul cas où les deux publics du CDC désignent une seule
 * personne.
 *
 * ## La portée de tenant est rouverte explicitement
 *
 * Même raison que pour la confirmation : l'émission a lieu dans la requête HTTP
 * qui a annulé, donc dans une portée déjà ouverte — mais s'y fier serait un pari
 * sur l'implémentation du bus, et `AppointmentCancelledEvent` porte `tenantId`
 * précisément pour ne pas avoir à le faire.
 *
 * ## Il ne lève jamais
 *
 * `handle` rattrape lui-même, comme `BookingConfirmationListener` : un abonné qui
 * se repose sur la garde de son émetteur est un abonné dont on ne sait plus, en
 * le lisant, s'il est sûr. Un envoi qui échoue laisse une ligne `FAILED` visible
 * au back-office (`GET /notifications`) et un journal d'erreur.
 */
@Injectable()
export class CancellationNoticeListener implements OnModuleInit, OnModuleDestroy {
  /** De quoi se retirer du bus à l'arrêt du module — même raison que #70. */
  private unsubscribe: (() => void) | null = null;

  public constructor(
    private readonly events: AppointmentEvents,
    private readonly dispatch: NotificationDispatchService,
    private readonly repository: NotificationsRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  public onModuleInit(): void {
    this.unsubscribe = this.events.onAppointmentCancelled((event) => {
      void this.handle(event);
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Traite un `appointment.cancelled` : un message par canal retenu, pour chacun
   * des destinataires que l'origine de l'annulation laisse à prévenir.
   *
   * Ne lève jamais — voir l'en-tête.
   */
  public async handle(event: AppointmentCancelledEvent): Promise<void> {
    try {
      await this.tenants.runWithTenant(event.tenantId, async () => {
        const recipients = await this.resolveRecipients(event);

        // Séquentiel, et non `Promise.all` : destinataires comme canaux
        // écrivent dans la même table, et l'e-mail est celui qui porte le
        // récapitulatif. Le paralléliser ferait dépendre l'ordre des lignes de
        // l'ordonnancement, ce que le journal du back-office affiche.
        for (const recipientUserId of recipients) {
          await this.notify(event, recipientUserId);
        }
      });
    } catch (error: unknown) {
      this.failed(event, error);
    }
  }

  /** Un destinataire, tous ses canaux joignables. */
  private async notify(
    event: AppointmentCancelledEvent,
    recipientUserId: string,
  ): Promise<void> {
    const channels = await this.resolveChannels(recipientUserId);

    if (channels.length === 0) {
      this.logger.warn("avis d'annulation sans canal joignable", {
        appointmentId: event.appointmentId,
        recipientUserId,
      });
      return;
    }

    for (const channel of channels) {
      await this.dispatchOne(event, recipientUserId, channel);
    }
  }

  /**
   * Les comptes à prévenir — les deux publics du CDC §1.4, moins celui qui a
   * décidé.
   *
   * La cliente d'abord, le praticien ensuite : c'est l'ordre dans lequel les
   * lignes s'écrivent, donc celui que le journal du back-office affiche, et il
   * n'est pas indifférent — l'avis de la cliente est celui qui arrête un
   * déplacement.
   *
   * Trois retraits, et chacun a sa raison :
   *
   * - **la cliente, quand c'est elle qui a annulé.** Quatrième critère
   *   d'acceptation de #72, au mot près : « aucun avis envoyé si l'annulation
   *   vient du client lui-même sur son propre rendez-vous, hors notification au
   *   staff ». Elle sait déjà, c'est elle qui a cliqué ;
   * - **le praticien, quand il n'a pas de compte joignable** dans cet
   *   établissement — sa ligne `staff` a disparu, ou appartient à un autre
   *   salon, ce que le client scopé traite de la même façon. C'est journalisé :
   *   c'est le seul chemin par lequel un public du CDC serait silencieusement
   *   privé de son avis. Une lecture **en échec** est traitée de la même façon,
   *   et `staffRecipient` dit pourquoi : elle ne doit pas emporter l'avis de la
   *   cliente avec elle ;
   * - **le praticien, quand il est l'auteur ou qu'il est déjà dans la liste.**
   *   Une praticienne qui réserve pour elle-même est à la fois la cliente et le
   *   praticien du rendez-vous : un seul avis, pas deux fois le même — et aucun
   *   si c'est elle qui s'est décommandée, le quatrième critère valant aussi de
   *   ce côté-là.
   *
   * La liste peut être vide, et ce n'est pas une anomalie : c'est le cas d'une
   * praticienne qui se décommande de son propre rendez-vous depuis son espace
   * client. Le seul destinataire possible serait alors l'auteur de l'annulation,
   * que le quatrième critère exclut. Rien n'est envoyé, et c'est juste.
   */
  private async resolveRecipients(
    event: AppointmentCancelledEvent,
  ): Promise<readonly string[]> {
    // Le compte de l'auteur, quand l'événement le nomme. `CLIENT` le nomme —
    // c'est `clientId`. `STAFF` ne le nomme pas : l'événement ne porte pas le
    // compte qui a posé l'annulation au comptoir, et c'est précisément pourquoi
    // le praticien doit être prévenu même là, rien ne disant que c'est lui.
    // `SYSTEM` n'est personne.
    const author = event.cancelledBy === 'CLIENT' ? event.clientId : null;

    const recipients: string[] = [];

    if (event.clientId !== author) {
      recipients.push(event.clientId);
    }

    const staffUserId = await this.staffRecipient(event);

    if (staffUserId === null) {
      this.logger.warn("avis d'annulation sans praticien joignable", {
        appointmentId: event.appointmentId,
        staffId: event.staffId,
      });
    } else if (staffUserId !== author && !recipients.includes(staffUserId)) {
      recipients.push(staffUserId);
    }

    if (recipients.length === 0) {
      this.logger.log("avis d'annulation sans destinataire à prévenir", {
        appointmentId: event.appointmentId,
      });
    }

    return recipients;
  }

  /**
   * Le compte du praticien — **sans jamais lever**.
   *
   * ## Pourquoi cette lecture est enveloppée, et elle seule
   *
   * Parce qu'elle est passée devant la cliente. Avant #534, une annulation
   * `STAFF` ou `SYSTEM` n'interrogeait pas la table `staff` du tout : le
   * destinataire était la cliente, et son avis partait sans qu'aucune autre
   * lecture ait pu échouer. Depuis que les deux publics sont servis, cette
   * lecture précède les deux envois — et une coupure de connexion, un délai
   * d'attente ou un pool saturé la ferait remonter jusqu'au `catch` de `handle`,
   * qui journalise et rend la main. Personne ne serait alors prévenu, pas même
   * la cliente, et le bus étant en mémoire il n'y a **aucun rejeu** : elle se
   * déplacerait pour un rendez-vous qui n'a plus lieu.
   *
   * L'échec est donc traité ici comme l'absence l'est juste après : le praticien
   * est perdu, la cliente ne l'est pas. C'est la règle que le module s'est
   * donnée — « un public perdu n'en emporte pas deux » — et elle ne vaut que si
   * elle couvre aussi la panne, pas seulement la ligne manquante.
   */
  private async staffRecipient(event: AppointmentCancelledEvent): Promise<string | null> {
    try {
      return await this.repository.findStaffRecipient(event.staffId);
    } catch (error: unknown) {
      // Distinct du journal de `failed()` : rien n'a échoué à partir, c'est la
      // **résolution** d'un destinataire qui n'a pas abouti. Ni coordonnée, ni
      // contenu, ni pile (notifications §7).
      this.logger.error("avis d'annulation — praticien non résolu", {
        appointmentId: event.appointmentId,
        staffId: event.staffId,
        error: error instanceof Error ? error.message : `erreur non standard (${typeof error})`,
      });

      return null;
    }
  }

  /**
   * Les canaux sur lesquels ce compte est joignable.
   *
   * La règle est celle de `reachableChannels`, la même que pour la confirmation
   * et le rappel : l'e-mail toujours, le SMS si le compte porte un numéro E.164
   * composable, et jamais `marketing_consent` — un avis d'annulation relève de
   * l'exécution du contrat, pas de la prospection (CDC §5.1). Une adresse en
   * liste de suppression (#73) n'est pas un canal, et `findRecipientContact` le
   * dit déjà.
   *
   * Elle vaut pour le praticien comme pour la cliente : ce sont deux lignes
   * `users`, et rien dans le schéma ne les distingue de ce point de vue.
   */
  private async resolveChannels(
    recipientUserId: string,
  ): Promise<readonly NotificationChannel[]> {
    return reachableChannels(await this.repository.findRecipientContact(recipientUserId));
  }

  /**
   * Un canal, un message.
   *
   * L'échec est **absorbé ici**, canal par canal : un SMS qui échoue ne doit pas
   * empêcher l'e-mail suivant de partir, ni l'inverse.
   *
   * La clé de livraison porte le **destinataire**, à la différence de celles des
   * deux autres messages. Ce n'est pas une précaution de style : l'avis
   * d'annulation est le seul dont le destinataire dépende d'une donnée du
   * rendez-vous — l'origine de la décision — et deux avis pour le même
   * rendez-vous peuvent donc désigner deux comptes différents. Sans le
   * destinataire dans la clé, un avis au praticien serait pris pour un rejeu d'un
   * avis à la cliente, et acquitté sans être parti.
   *
   * `scheduledFor: null` : l'avis est immédiat. Le champ existe pour le rappel
   * J-1, seul message planifié du MVP.
   */
  private async dispatchOne(
    event: AppointmentCancelledEvent,
    recipientUserId: string,
    channel: NotificationChannel,
  ): Promise<void> {
    const message: NotificationMessage = {
      tenantId: event.tenantId,
      dedupeKey: appointmentDedupeKey(
        event.appointmentId,
        'CANCELLATION',
        channel,
        recipientUserId,
      ),
      appointmentId: event.appointmentId,
      recipientUserId,
      type: 'CANCELLATION',
      channel,
      scheduledFor: null,
    };

    try {
      await this.dispatch.dispatch(message);
    } catch (error: unknown) {
      this.failed(event, error, channel);
    }
  }

  /**
   * L'échec, journalisé et jamais propagé.
   *
   * Ni contenu, ni coordonnée, ni motif d'annulation : l'identifiant du
   * rendez-vous, le canal, et le message de l'erreur — pas sa pile
   * (notifications §7).
   */
  private failed(
    event: AppointmentCancelledEvent,
    error: unknown,
    channel?: NotificationChannel,
  ): void {
    this.logger.error("avis d'annulation non expédié", {
      appointmentId: event.appointmentId,
      ...(channel === undefined ? {} : { channel }),
      error: error instanceof Error ? error.message : `erreur non standard (${typeof error})`,
    });
  }
}
