import { EventEmitter } from 'node:events';

import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../../common/logging/structured-logger';
import {
  APPOINTMENT_CANCELLED,
  type AppointmentCancelledEvent,
} from './appointment-cancelled.event';
import { APPOINTMENT_CREATED, type AppointmentCreatedEvent } from './appointment-created.event';
import {
  APPOINTMENT_RESCHEDULED,
  type AppointmentRescheduledEvent,
} from './appointment-rescheduled.event';

/**
 * Tout ce que ce bus publie.
 *
 * Une union plutôt qu'une interface commune : les trois événements ne partagent
 * que leur enveloppe — nom, tenant, rendez-vous, instant d'émission — et une
 * classe de base les ferait diverger par héritage plutôt que par contrat. Ce que
 * la publication a besoin de savoir tient dans ces quatre champs, et c'est
 * exactement ce que l'union garantit.
 */
export type AppointmentDomainEvent =
  | AppointmentCreatedEvent
  | AppointmentRescheduledEvent
  | AppointmentCancelledEvent;

/**
 * Le bus d'événements du module `appointments` — publication en mémoire, dans le
 * processus (#37).
 *
 * ## Pourquoi `node:events` et non `@nestjs/event-emitter`
 *
 * Parce qu'ajouter une dépendance touche `apps/api/package.json`, hors de
 * l'empreinte de ce ticket, et surtout parce que le paquet n'apporterait rien
 * qu'on utilise : `EventEmitter` est dans la bibliothèque standard, la surface
 * dont ce module a besoin tient en `emit` et `on`, et la substitution le jour où
 * la publication passera par SQS se fera derrière **cette** classe, quelle que
 * soit la façon dont elle est écrite aujourd'hui.
 *
 * ## Ce que cette publication garantit, et ce qu'elle ne garantit pas
 *
 * Elle est **synchrone et en mémoire** : un abonné qui lève arrête l'appelant,
 * et rien ne survit à un redémarrage du processus. C'est suffisant tant qu'aucun
 * abonné n'existe — `notifications` est un module de S4 — et cela ne le sera
 * plus dès qu'un envoi d'e-mail en dépendra : la chaîne visée par le CDC §2.2
 * est EventBridge → SQS → Lambda, avec sa reprise et sa file de rebut.
 *
 * Deux précautions rendent le passage possible sans réécrire les appelants :
 *
 * 1. `emit` **n'échoue jamais** du point de vue de l'appelant. Un abonné qui
 *    lève est journalisé, pas propagé : un rendez-vous réellement écrit en base
 *    ne doit pas être rapporté comme un échec à la cliente parce qu'un e-mail
 *    n'est pas parti. C'est la même règle que celle qui justifie l'événement
 *    plutôt que l'appel direct ;
 * 2. l'événement est journalisé à chaque émission. C'est ce qui rend le critère
 *    « événement de domaine `appointment.created` émis » observable en recette et
 *    en exploitation, sans abonné pour en témoigner.
 *
 * ## Aucune limite d'abonnés n'est levée
 *
 * `EventEmitter` avertit au-delà de dix abonnés sur un même nom. Le seuil est
 * conservé : dépasser dix abonnés sur `appointment.created` dans un monolithe
 * modulaire signalerait une fuite d'écouteurs — un module qui s'abonne à chaque
 * requête — bien plus sûrement qu'un besoin réel.
 */
@Injectable()
export class AppointmentEvents {
  private readonly emitter = new EventEmitter();

  public constructor(private readonly logger: StructuredLogger) {}

  /**
   * Publie `appointment.created`.
   *
   * Appelé **après** la validation de la transaction d'écriture, jamais dedans :
   * annoncer un rendez-vous qu'un `ROLLBACK` effacerait ensuite enverrait une
   * confirmation pour un rendez-vous qui n'existe pas.
   */
  public appointmentCreated(event: Omit<AppointmentCreatedEvent, 'name' | 'occurredAt'>): void {
    this.publish({
      ...event,
      name: APPOINTMENT_CREATED,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Publie `appointment.rescheduled` (#39).
   *
   * Appelé **après** la validation de la transaction de report, jamais dedans :
   * un `ROLLBACK` laisserait l'ancien rendez-vous en place, et l'avis de
   * déplacement aurait annoncé une heure à laquelle personne n'est attendu.
   */
  public appointmentRescheduled(
    event: Omit<AppointmentRescheduledEvent, 'name' | 'occurredAt'>,
  ): void {
    this.publish({
      ...event,
      name: APPOINTMENT_RESCHEDULED,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Publie `appointment.cancelled` (#40).
   *
   * Appelé **après** la validation de l'annulation, jamais dedans : un
   * `ROLLBACK` laisserait le rendez-vous debout, et l'avis d'annulation aurait
   * décommandé une cliente qui est toujours attendue.
   */
  public appointmentCancelled(event: Omit<AppointmentCancelledEvent, 'name' | 'occurredAt'>): void {
    this.publish({
      ...event,
      name: APPOINTMENT_CANCELLED,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Abonne un écouteur à `appointment.created`.
   *
   * Rend la fonction de désabonnement plutôt que rien : un module qui s'abonne
   * dans `onModuleInit` doit pouvoir se retirer dans `onModuleDestroy`, faute de
   * quoi chaque application montée par la suite de tests laisse son écouteur sur
   * un émetteur qui, lui, vit aussi longtemps que son instance.
   */
  public onAppointmentCreated(listener: (event: AppointmentCreatedEvent) => void): () => void {
    return this.subscribe(APPOINTMENT_CREATED, listener);
  }

  /**
   * Abonne un écouteur à `appointment.rescheduled` — même contrat, même
   * enveloppe.
   */
  public onAppointmentRescheduled(
    listener: (event: AppointmentRescheduledEvent) => void,
  ): () => void {
    return this.subscribe(APPOINTMENT_RESCHEDULED, listener);
  }

  /**
   * Abonne un écouteur à `appointment.cancelled` — même contrat, même enveloppe.
   */
  public onAppointmentCancelled(listener: (event: AppointmentCancelledEvent) => void): () => void {
    return this.subscribe(APPOINTMENT_CANCELLED, listener);
  }

  /**
   * L'abonnement, quel que soit l'événement.
   *
   * ## L'écouteur est **enveloppé**, et il doit l'être
   *
   * Deux modes de défaillance qu'un `try` autour d'`emit` ne couvre pas :
   *
   * 1. `EventEmitter.emit` appelle ses écouteurs **en boucle** ; le premier qui
   *    lève interrompt la boucle, et les suivants ne reçoivent jamais
   *    l'événement. Un `notifications` tombé priverait alors `reporting` du même
   *    fait, sans que rien ne le dise ;
   * 2. la signature annonce `void`, mais TypeScript accepte un abonné `async`
   *    sous ce type — et c'en sera un, la confirmation partant par SES. Son rejet
   *    survient *après* le retour d'`emit` : aucun `try` de l'appelant ne le
   *    rattrape, et Node abat le processus sur une promesse non gérée.
   *
   * L'enveloppe isole donc chaque abonné, dans les deux temps : la levée
   * synchrone et le rejet différé. Elle est écrite **une fois** : deux copies
   * divergeraient, et celle qui perdrait le `catch` différé abattrait le
   * processus sur un rejet d'abonné.
   */
  private subscribe<E extends AppointmentDomainEvent>(
    name: E['name'],
    listener: (event: E) => void,
  ): () => void {
    const guarded = (event: E): void => {
      try {
        const outcome: unknown = listener(event);
        if (outcome instanceof Promise) {
          void outcome.catch((error: unknown) => {
            this.listenerFailed(event, error);
          });
        }
      } catch (error: unknown) {
        this.listenerFailed(event, error);
      }
    };

    this.emitter.on(name, guarded);
    return () => {
      this.emitter.off(name, guarded);
    };
  }

  /**
   * L'émission proprement dite : journalisée, puis publiée sans laisser un abonné
   * fautif remonter jusqu'à l'appelant.
   *
   * `EventEmitter.emit` propage ce que lèvent ses écouteurs — ils sont appelés en
   * boucle, sur la pile de l'appelant. Chaque abonné passé par
   * `onAppointmentCreated` est déjà enveloppé ; ce `try` couvre ce qui ne l'est
   * pas — un écouteur posé sur l'émetteur par un autre chemin — et garantit qu'un
   * module d'aval ne fera jamais échouer une réservation déjà validée en base.
   */
  private publish(event: AppointmentDomainEvent): void {
    this.logger.log('domain event', {
      event: event.name,
      tenantId: event.tenantId,
      appointmentId: event.appointmentId,
    });

    try {
      this.emitter.emit(event.name, event);
    } catch (error: unknown) {
      this.listenerFailed(event, error);
    }
  }

  /** Un abonné a échoué — journalisé, jamais propagé à l'appelant. */
  private listenerFailed(event: AppointmentDomainEvent, error: unknown): void {
    this.logger.error('domain event listener failed', {
      event: event.name,
      appointmentId: event.appointmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
