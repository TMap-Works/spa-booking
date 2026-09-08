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
 * L'avis va donc à la partie qui **n'a pas décidé** :
 *
 * | `cancelledBy` | Destinataire | Pourquoi |
 * |---|---|---|
 * | `CLIENT` | le praticien | son agenda vient de changer sans lui ; la cliente, elle, sait déjà — c'est elle qui a cliqué |
 * | `STAFF` | la cliente | le salon a décidé ; elle doit l'apprendre autrement qu'en se déplaçant |
 * | `SYSTEM` | la cliente | personne ne l'a décidé de son côté du comptoir |
 *
 * ## Pourquoi un seul destinataire par annulation, et non les deux
 *
 * Parce que la base ne l'autorise pas encore, et c'est une limite assumée, pas un
 * oubli. `notifications_live_once` — l'index unique partiel posé par #68 — porte
 * sur `(tenant_id, appointment_id, type, channel)` : il ne peut pas exister deux
 * avis d'annulation **vivants** sur le même canal pour le même rendez-vous.
 * Écrire la cliente puis le praticien ferait donc refuser le second par
 * PostgreSQL, `claim()` rendrait `already-live`, et le praticien ne recevrait
 * rien — **en silence**, puisque c'est exactement la forme qu'a un rejeu SQS
 * légitime.
 *
 * Servir les deux publics demande d'ajouter `recipient_user_id` à cet index. Un
 * index ne se modifie pas — il se **remplace**, donc il se `DROP` —, et c'est là
 * que la porte se ferme : le garde « migration purement additive » de
 * `infrastructure/database/__tests__/prisma-schema.spec.ts` refuse tout
 * `DROP INDEX` dans le SQL de migration. Aucun chemin additif n'existe, puisque
 * l'ancien index bloque tant qu'il vit. Lever la limite demande d'assouplir ce
 * garde **et** de poser la migration, dans un ticket qui porte les deux : c'est
 * l'objet de l'issue de suivi.
 *
 * La règle ci-dessus est ce qui, sans migration, sert les deux publics **sans
 * jamais perdre un envoi** : à chaque annulation, un avis part vers la partie qui
 * n'a pas décidé.
 *
 * Ce qu'elle ne couvre pas : sur `STAFF`, seule la cliente est prévenue. Une
 * annulation posée au comptoir par quelqu'un d'autre que le praticien concerné —
 * accueil, gérance — ne lui dit donc rien, alors que son agenda vient de changer.
 * C'est le second public que la migration débloquera.
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
   * Traite un `appointment.cancelled` : un message par canal retenu, pour le
   * destinataire que l'origine de l'annulation désigne.
   *
   * Ne lève jamais — voir l'en-tête.
   */
  public async handle(event: AppointmentCancelledEvent): Promise<void> {
    try {
      await this.tenants.runWithTenant(event.tenantId, async () => {
        const recipientUserId = await this.resolveRecipient(event);

        if (recipientUserId === null) {
          return;
        }

        const channels = await this.resolveChannels(recipientUserId);

        if (channels.length === 0) {
          this.logger.warn("avis d'annulation sans canal joignable", {
            appointmentId: event.appointmentId,
            recipientUserId,
          });
          return;
        }

        // Séquentiel, et non `Promise.all` : les deux canaux écrivent dans la
        // même table, et l'e-mail est celui qui porte le récapitulatif. Le
        // paralléliser ferait dépendre l'ordre des lignes de l'ordonnancement,
        // ce que le journal du back-office affiche.
        for (const channel of channels) {
          await this.dispatchOne(event, recipientUserId, channel);
        }
      });
    } catch (error: unknown) {
      this.failed(event, error);
    }
  }

  /**
   * Le compte à prévenir — la partie qui n'a pas décidé de l'annulation.
   *
   * Rend `null` quand il n'y a personne à prévenir, et les deux cas sont
   * distincts :
   *
   * - le praticien n'a pas de compte joignable dans cet établissement — sa ligne
   *   `staff` a disparu, ou appartient à un autre salon, ce que le client scopé
   *   traite de la même façon. C'est journalisé : c'est le seul chemin par lequel
   *   une annulation ne produirait aucune trace ;
   * - le praticien **est** la personne qui a annulé. Cela se produit quand une
   *   praticienne réserve pour elle-même et se décommande depuis son espace
   *   client : le compte destinataire serait alors celui de l'auteur de
   *   l'annulation, ce que le quatrième critère d'acceptation interdit
   *   littéralement — « aucun avis envoyé si l'annulation vient du client
   *   lui-même sur son propre rendez-vous ». Rien n'est envoyé, et rien n'est
   *   anormal.
   */
  private async resolveRecipient(event: AppointmentCancelledEvent): Promise<string | null> {
    if (event.cancelledBy !== 'CLIENT') {
      return event.clientId;
    }

    const staffUserId = await this.repository.findStaffRecipient(event.staffId);

    if (staffUserId === null) {
      this.logger.warn("avis d'annulation sans praticien joignable", {
        appointmentId: event.appointmentId,
        staffId: event.staffId,
      });
      return null;
    }

    if (staffUserId === event.clientId) {
      this.logger.log("avis d'annulation sans objet, le praticien est l'auteur", {
        appointmentId: event.appointmentId,
      });
      return null;
    }

    return staffUserId;
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
