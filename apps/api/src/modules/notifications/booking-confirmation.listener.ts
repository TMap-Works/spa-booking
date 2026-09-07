import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { AppointmentCreatedEvent } from '../appointments/events/appointment-created.event';
import { AppointmentEvents } from '../appointments/events/appointment-events';
import { NotificationDispatchService } from './notification-dispatch.service';
import { NotificationsRepository } from './notifications.repository';
import {
  appointmentDedupeKey,
  type NotificationChannel,
  type NotificationMessage,
} from './notifications.types';

/**
 * La confirmation de réservation — premier des trois messages du MVP (#70).
 *
 * ## Déclenchée par l'événement, jamais depuis le contrôleur
 *
 * C'est le premier critère d'acceptation de l'issue, et ce n'est pas une
 * préférence de style. Un appel depuis `AppointmentsService` ferait échouer une
 * réservation **déjà écrite en base** parce qu'un e-mail n'est pas parti : la
 * cliente verrait une erreur, reprendrait le tunnel, et se retrouverait avec
 * deux rendez-vous — ou aucun, si le second heurtait la contrainte d'exclusion
 * du premier.
 *
 * L'événement inverse la dépendance : `appointments` annonce un fait, et ce
 * module décide qu'un tel fait mérite un message. `appointments` n'est pas
 * modifié par #70 — `AppointmentEvents` était déjà exporté par son module,
 * précisément pour cela.
 *
 * ## Un abonné qui lève ne fait échouer personne
 *
 * `AppointmentEvents.subscribe` enveloppe déjà chaque écouteur et rattrape la
 * levée synchrone comme le rejet différé. Ce fichier n'en dépend pas pour
 * autant : `handle` rattrape lui-même, parce qu'un abonné qui se repose sur la
 * garde de son émetteur est un abonné dont on ne sait plus, en le lisant, s'il
 * est sûr. La garde du bus est une seconde barrière, pas la première.
 *
 * La conséquence est explicite : **un envoi qui échoue ne remonte nulle part.**
 * Il laisse une ligne `FAILED` en base, visible au back-office
 * (`GET /notifications`), et un journal d'erreur. C'est le comportement voulu
 * tant que la publication est en mémoire ; le jour où elle passera par SQS,
 * c'est la file qui reprendra, et cette classe deviendra le consommateur.
 *
 * ## La portée de tenant est rouverte explicitement
 *
 * L'émission a lieu dans la requête HTTP qui a créé le rendez-vous, donc dans
 * une portée déjà ouverte — mais s'y fier serait un pari sur l'implémentation du
 * bus. Le jour où l'événement viendra d'une file, il n'y aura plus aucune
 * requête ni aucun `AsyncLocalStorage` à hériter, et c'est exactement pourquoi
 * `AppointmentCreatedEvent` porte `tenantId`. `runWithTenant` le pose ici, une
 * fois, autour de tout ce qui touche la base.
 */
@Injectable()
export class BookingConfirmationListener implements OnModuleInit, OnModuleDestroy {
  /**
   * De quoi se retirer du bus à l'arrêt du module.
   *
   * Sans cela, chaque application montée par la suite de tests laisserait son
   * écouteur sur un émetteur qui vit aussi longtemps que son instance — c'est la
   * raison pour laquelle `onAppointmentCreated` rend une fonction plutôt que
   * rien.
   */
  private unsubscribe: (() => void) | null = null;

  public constructor(
    private readonly events: AppointmentEvents,
    private readonly dispatch: NotificationDispatchService,
    private readonly repository: NotificationsRepository,
    private readonly tenants: TenantContextService,
    private readonly logger: StructuredLogger,
  ) {}

  public onModuleInit(): void {
    this.unsubscribe = this.events.onAppointmentCreated((event) => {
      void this.handle(event);
    });
  }

  public onModuleDestroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Traite un `appointment.created` : un message par canal retenu.
   *
   * Ne lève jamais. Voir l'en-tête — un rendez-vous réellement écrit en base ne
   * doit pas être rapporté comme un échec parce qu'un SMS n'est pas parti.
   */
  public async handle(event: AppointmentCreatedEvent): Promise<void> {
    try {
      await this.tenants.runWithTenant(event.tenantId, async () => {
        const channels = await this.resolveChannels(event.clientId);

        if (channels.length === 0) {
          // Structurellement improbable — `users.email` est `NOT NULL` — mais
          // le dire vaut mieux que de sortir en silence : c'est le seul chemin
          // par lequel une réservation ne produirait aucune trace d'envoi.
          this.logger.warn('confirmation sans canal joignable', {
            appointmentId: event.appointmentId,
          });
          return;
        }

        // Séquentiel, et non `Promise.all` : les deux canaux écrivent dans la
        // même table, et l'e-mail est celui qui compte. Le paralléliser ferait
        // dépendre l'ordre des lignes de l'ordonnancement, ce que le journal du
        // back-office affiche.
        for (const channel of channels) {
          await this.dispatchOne(event, channel);
        }
      });
    } catch (error: unknown) {
      this.failed(event, error);
    }
  }

  /**
   * Les canaux sur lesquels cette cliente est joignable — deuxième critère
   * d'acceptation, « selon les préférences du client ».
   *
   * ## Ce que « préférence » veut dire au périmètre de #70
   *
   * L'e-mail part **toujours**. C'est la règle que pose le contrat partagé
   * (`notificationPreferencesSchema` : « le SMS se désactive, l'e-mail non ») et
   * elle tient à ce que la confirmation est la preuve du rendez-vous : un
   * établissement doit pouvoir la produire, et un opt-out total relève de la
   * suppression du compte, pas d'une case à cocher.
   *
   * Le SMS ne part que si le compte porte un numéro exploitable. C'est la seule
   * préférence que le schéma sache exprimer aujourd'hui : `users.sms_enabled`
   * n'existe pas, et l'ajouter aurait demandé une migration hors du périmètre de
   * ce ticket — elle fait l'objet d'une issue de suivi. Saisir ou effacer son
   * numéro est donc, pour l'instant, la façon dont une cliente choisit de
   * recevoir des SMS.
   *
   * **`marketing_consent` n'entre pas ici**, et le schéma l'écrit noir sur
   * blanc : une confirmation relève de l'exécution du contrat (CDC §5.1,
   * notifications §7), pas de la prospection. La subordonner à un consentement
   * marketing priverait de leur preuve de rendez-vous toutes les clientes qui
   * ont refusé les offres commerciales.
   */
  private async resolveChannels(clientId: string): Promise<readonly NotificationChannel[]> {
    const contact = await this.repository.findRecipientContact(clientId);

    if (contact === null) {
      return [];
    }

    const channels: NotificationChannel[] = [];

    if (contact.hasEmail) {
      channels.push('EMAIL');
    }

    if (contact.hasSms) {
      channels.push('SMS');
    }

    return channels;
  }

  /**
   * Un canal, un message.
   *
   * L'échec est **absorbé ici**, canal par canal, et pas seulement au niveau du
   * `handle` : un SMS qui échoue ne doit pas empêcher l'e-mail suivant de
   * partir. C'est le pendant, à l'échelle des canaux, de l'enveloppe que le bus
   * pose à l'échelle des abonnés — et pour la même raison, une boucle
   * interrompue au premier échec privant les suivants de leur tour.
   *
   * `scheduledFor: null` : la confirmation est immédiate. Le champ existe pour
   * le rappel J-1, qui est le seul message planifié du MVP.
   */
  private async dispatchOne(
    event: AppointmentCreatedEvent,
    channel: NotificationChannel,
  ): Promise<void> {
    const message: NotificationMessage = {
      // Le même identifiant que celui dont `handle` ouvre la portée. Il ne sert
      // à rien tant que la publication est en mémoire ; il sert à tout le jour où
      // elle passe par SQS, et c'est justement ce que #71 met en service.
      tenantId: event.tenantId,
      dedupeKey: appointmentDedupeKey(event.appointmentId, 'BOOKING_CONFIRMATION', channel),
      appointmentId: event.appointmentId,
      recipientUserId: event.clientId,
      type: 'BOOKING_CONFIRMATION',
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
   * Ni contenu, ni coordonnée : l'identifiant du rendez-vous, le canal, et le
   * message de l'erreur — pas sa pile (notifications §7).
   */
  private failed(
    event: AppointmentCreatedEvent,
    error: unknown,
    channel?: NotificationChannel,
  ): void {
    this.logger.error('confirmation de réservation non expédiée', {
      appointmentId: event.appointmentId,
      ...(channel === undefined ? {} : { channel }),
      error: error instanceof Error ? error.message : `erreur non standard (${typeof error})`,
    });
  }
}
