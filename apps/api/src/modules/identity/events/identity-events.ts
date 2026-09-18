import { EventEmitter } from 'node:events';

import { Injectable } from '@nestjs/common';

import { StructuredLogger } from '../../../common/logging/structured-logger';
import {
  PASSWORD_RESET_REQUESTED,
  type PasswordResetRequestedEvent,
} from './password-reset-requested.event';

/**
 * Tout ce que ce bus publie — un seul événement pour l'instant.
 *
 * Une union d'un membre plutôt qu'un type nu, et pour la même raison
 * qu'`AppointmentDomainEvent` en est une de trois : c'est elle qui donne à
 * `subscribe` le `name` sur lequel se discriminer, et un second événement
 * s'ajoutera sans toucher à l'enveloppe.
 */
export type IdentityDomainEvent = PasswordResetRequestedEvent;

/**
 * Le bus d'événements du module `identity` — publication en mémoire, dans le
 * processus (#809).
 *
 * ## Il reprend `AppointmentEvents` à la ligne près, et c'est délibéré
 *
 * Deux bus, même forme, mêmes garanties : `node:events` plutôt que
 * `@nestjs/event-emitter` — la surface utile tient en `emit` et `on`, et une
 * dépendance de plus toucherait `apps/api/package.json` —, un écouteur
 * **enveloppé** qui isole la levée synchrone comme le rejet différé, et une
 * fonction de désabonnement rendue à l'abonnement.
 *
 * Ce qu'on ne fait pas, c'est **mutualiser les deux** dans un bus commun. La
 * tentation est réelle : le code est presque identique. Mais un bus partagé
 * devrait vivre hors des modules — dans `common/` —, et il ferait de tout module
 * abonné un lecteur des faits de tous les autres : `notifications` pourrait
 * écouter un événement de `payments` sans que rien ne l'annonce dans le graphe
 * de dépendances. Ici, c'est l'`imports:` du module qui dit qui écoute qui, et
 * c'est ce qui rend le couplage visible en revue (api-module §3). Le jour où un
 * troisième bus apparaîtra, la question se posera ; à deux, la duplication coûte
 * moins que l'indirection.
 *
 * ## Ce que cette publication garantit, et ce qu'elle ne garantit pas
 *
 * Elle est **synchrone et en mémoire** : rien ne survit à un redémarrage du
 * processus. Ce n'est pas la même chose que pour les rendez-vous, et il faut le
 * dire : un abonné qui n'a pas eu son tour laisse ici une demande de
 * réinitialisation sans e-mail, et quelqu'un attend ce courrier.
 *
 * Deux choses bornent la conséquence. La première est que la demande est
 * **rejouable** : la personne redemande un lien, et le nouveau jeton invalide
 * l'ancien — c'est précisément ce que le deuxième critère d'acceptation
 * organise. La seconde est que l'abonné ne fait presque rien : il compose une
 * enveloppe et la remet à la file (`NOTIFICATION_PUBLISHER`), d'où la reprise,
 * la DLQ et son alarme prennent le relais (notifications §4). La fenêtre
 * réellement perdue est celle d'un processus tué entre l'écriture du jeton et la
 * publication SQS — quelques millisecondes.
 *
 * `emit` **n'échoue jamais** du point de vue de l'appelant, et c'est ce qui tient
 * le « toujours 202 » du premier critère : une demande légitime ne doit pas
 * ressortir en erreur parce que la file est indisponible, surtout adressée à
 * quelqu'un qui n'a déjà plus accès à son compte.
 *
 * ## Le journal ne porte jamais le jeton
 *
 * `publish` journalise le nom de l'événement, l'établissement et le compte. Ni
 * le jeton, ni l'adresse : l'identifiant du compte suffit à retrouver la fiche,
 * et il ne dit rien à qui lit le journal sans accès à la base (notifications §7,
 * CDC §5.1).
 */
@Injectable()
export class IdentityEvents {
  private readonly emitter = new EventEmitter();

  public constructor(private readonly logger: StructuredLogger) {}

  /**
   * Publie `password-reset.requested`.
   *
   * Appelé **après** l'armement du jeton en base, jamais avant : annoncer un
   * jeton que la base n'a pas accepté enverrait un lien qui ne pourrait rien
   * ouvrir, et la personne conclurait que le produit est cassé plutôt que de
   * redemander.
   */
  public passwordResetRequested(
    event: Omit<PasswordResetRequestedEvent, 'name' | 'occurredAt'>,
  ): void {
    this.publish({
      ...event,
      name: PASSWORD_RESET_REQUESTED,
      occurredAt: new Date().toISOString(),
    });
  }

  /**
   * Abonne un écouteur à `password-reset.requested`.
   *
   * Rend la fonction de désabonnement plutôt que rien : un module qui s'abonne
   * dans `onModuleInit` doit pouvoir se retirer dans `onModuleDestroy`, faute de
   * quoi chaque application montée par la suite de tests laisse son écouteur sur
   * un émetteur qui, lui, vit aussi longtemps que son instance.
   */
  public onPasswordResetRequested(
    listener: (event: PasswordResetRequestedEvent) => void,
  ): () => void {
    return this.subscribe(PASSWORD_RESET_REQUESTED, listener);
  }

  /**
   * L'abonnement, quel que soit l'événement.
   *
   * L'écouteur est **enveloppé**, et il doit l'être, pour les deux raisons que
   * `AppointmentEvents.subscribe` détaille : `EventEmitter.emit` appelle ses
   * écouteurs en boucle et le premier qui lève prive les suivants de
   * l'événement ; et un abonné `async` — celui-ci en est un, il publie sur SQS —
   * rejette *après* le retour d'`emit`, où aucun `try` de l'appelant ne le
   * rattrape, ce sur quoi Node abat le processus.
   */
  private subscribe<E extends IdentityDomainEvent>(
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
   * L'émission proprement dite : journalisée, puis publiée sans laisser un
   * abonné fautif remonter jusqu'à l'appelant.
   *
   * Chaque abonné passé par `onPasswordResetRequested` est déjà enveloppé ; ce
   * `try` couvre ce qui ne l'est pas — un écouteur posé sur l'émetteur par un
   * autre chemin — et garantit qu'un module d'aval ne fera jamais ressortir en
   * erreur une demande déjà inscrite en base.
   */
  private publish(event: IdentityDomainEvent): void {
    this.logger.log('domain event', {
      event: event.name,
      tenantId: event.tenantId,
      // Ni le jeton, ni l'adresse : l'identifiant du compte suffit à retrouver
      // la fiche, et il ne dit rien à qui lit le journal sans accès à la base.
      userId: event.userId,
    });

    try {
      this.emitter.emit(event.name, event);
    } catch (error: unknown) {
      this.listenerFailed(event, error);
    }
  }

  /** Un abonné a échoué — journalisé, jamais propagé à l'appelant. */
  private listenerFailed(event: IdentityDomainEvent, error: unknown): void {
    this.logger.error('domain event listener failed', {
      event: event.name,
      userId: event.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
