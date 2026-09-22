import { randomUUID } from 'node:crypto';

import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  appointmentFeedEventSchema,
  type AppointmentFeedEvent,
  type CancellationActor,
  type Permission,
} from '@spa/shared';

import { StructuredLogger } from '../../common/logging/structured-logger';
import { CacheBroadcast } from '../../infrastructure/cache/cache.broadcast';
import type { AuthenticatedUser } from '../identity/identity.types';
import { roleHasPermission } from '../identity/permissions';
import type { AppointmentCancelledBy } from './appointment-status';
import { AppointmentsRepository } from './appointments.repository';
import { AppointmentEvents, type AppointmentDomainEvent } from './events/appointment-events';

/**
 * Le flux temps réel des rendez-vous — ce que `GET /v1/appointments/stream`
 * pousse aux écrans ouverts.
 *
 * ## D'où il tire ses signaux
 *
 * Du bus du module (`AppointmentEvents`), et de lui seul : les cinq événements
 * de domaine y passent déjà, **après** la validation de leur écriture. Le flux
 * n'annonce donc jamais un rendez-vous qu'un `ROLLBACK` aurait effacé, et il
 * n'a aucune écriture à surveiller par lui-même — un geste qui n'émettrait pas
 * d'événement serait un défaut du bus, pas du flux.
 *
 * ## Comment il atteint les autres instances
 *
 * Le bus est en mémoire, et la production tourne sur plusieurs tâches. Chaque
 * signal est donc servi **tout de suite** aux connexions de l'instance qui l'a
 * produit, puis publié sur Redis pour les autres (`CacheBroadcast`). L'instance
 * d'origine reconnaît son propre message à son `origin` et ne le sert pas deux
 * fois. Redis tombé, le temps réel se réduit à l'instance d'origine — il ne
 * casse rien d'autre.
 *
 * Un canal **par établissement** (`appointments:feed:{tenantId}`) : une instance
 * ne s'abonne qu'aux salons dont elle tient un écran ouvert, et le message d'un
 * salon ne transite jamais par l'abonnement d'un autre (tenant-isolation §5).
 *
 * ## Ce qu'il envoie
 *
 * Un signal — `appointmentFeedEventSchema` —, jamais une donnée : l'écran relit
 * par ses routes habituelles, qui appliquent chacune leur contrôle d'accès. Voir
 * `packages/shared/src/schemas/appointment-feed.ts`.
 */

/** Ce qui circule entre instances, et entre le bus et les connexions. */
export interface AppointmentFeedSignal {
  readonly tenantId: string;
  /** La cliente du rendez-vous — son identifiant de compte. */
  readonly clientId: string;
  /** Les praticiens concernés : deux après un report qui change de praticien. */
  readonly staffIds: readonly string[];
  /** Ce que l'écran reçoit, et rien de plus. */
  readonly event: AppointmentFeedEvent;
}

/**
 * Qui regarde — dérivé du jeton, jamais d'un paramètre.
 *
 * Trois périmètres, les mêmes que ceux des lectures de rendez-vous : l'agenda du
 * salon (`GET /appointments`), celui du praticien (`GET /me/appointments`),
 * l'historique de la cliente (`GET /appointments/mine`).
 */
export type AppointmentFeedAudience =
  | { readonly kind: 'establishment'; readonly tenantId: string }
  | { readonly kind: 'staff'; readonly tenantId: string; readonly staffId: string }
  | { readonly kind: 'client'; readonly tenantId: string; readonly clientId: string };

/** Le signal concerne-t-il ce regard ? Le tenant d'abord, toujours. */
export function reaches(audience: AppointmentFeedAudience, signal: AppointmentFeedSignal): boolean {
  if (signal.tenantId !== audience.tenantId) {
    return false;
  }

  switch (audience.kind) {
    case 'establishment':
      return true;
    case 'staff':
      return signal.staffIds.includes(audience.staffId);
    case 'client':
      return signal.clientId === audience.clientId;
  }
}

/** Le canal Redis d'un établissement — le tenant en tête, comme toute clé. */
export function feedChannel(tenantId: string): string {
  return `appointments:feed:${tenantId}`;
}

/** Le vocabulaire du contrat pour l'auteur d'une annulation — minuscules. */
const CANCELLED_BY: Readonly<Record<AppointmentCancelledBy, CancellationActor>> = {
  CLIENT: 'client',
  STAFF: 'staff',
  SYSTEM: 'system',
};

/** Traduit un événement de domaine en signal de flux. */
export function feedSignalOf(event: AppointmentDomainEvent): AppointmentFeedSignal {
  const envelope = { tenantId: event.tenantId, clientId: event.clientId };

  switch (event.name) {
    case 'appointment.created':
      return {
        ...envelope,
        staffIds: [event.staffId],
        event: {
          change: 'created',
          appointmentId: event.appointmentId,
          startsAt: event.startsAt,
          occurredAt: event.occurredAt,
        },
      };
    case 'appointment.confirmed':
      return {
        ...envelope,
        staffIds: [event.staffId],
        event: {
          change: 'confirmed',
          appointmentId: event.appointmentId,
          occurredAt: event.occurredAt,
        },
      };
    case 'appointment.rescheduled':
      return {
        ...envelope,
        // Le praticien d'arrivée **et** celui de départ : celui qui perd le
        // rendez-vous doit le voir disparaître de son planning.
        staffIds:
          event.staffId === event.previousStaffId
            ? [event.staffId]
            : [event.staffId, event.previousStaffId],
        event: {
          change: 'rescheduled',
          appointmentId: event.appointmentId,
          previousAppointmentId: event.previousAppointmentId,
          startsAt: event.startsAt,
          occurredAt: event.occurredAt,
        },
      };
    case 'appointment.cancelled':
      return {
        ...envelope,
        staffIds: [event.staffId],
        event: {
          change: 'cancelled',
          appointmentId: event.appointmentId,
          startsAt: event.startsAt,
          cancelledBy: CANCELLED_BY[event.cancelledBy],
          occurredAt: event.occurredAt,
        },
      };
    case 'appointment.status_changed':
      return {
        ...envelope,
        staffIds: [event.staffId],
        event: {
          change: event.status === 'COMPLETED' ? 'completed' : 'no_show',
          appointmentId: event.appointmentId,
          occurredAt: event.occurredAt,
        },
      };
  }
}

/** Ce qu'une connexion reçoit. */
export type AppointmentFeedListener = (event: AppointmentFeedEvent) => void;

/** La permission qui ouvre l'agenda de tout l'établissement. */
const ESTABLISHMENT_AGENDA: Permission = 'agenda:read:all';

/** La permission qui ouvre l'agenda du praticien connecté. */
const OWN_AGENDA: Permission = 'agenda:read:own';

interface Watcher {
  readonly audience: AppointmentFeedAudience;
  readonly listener: AppointmentFeedListener;
}

/** Un message tel qu'il transite sur Redis. */
interface RelayedSignal {
  readonly origin: string;
  readonly signal: AppointmentFeedSignal;
}

@Injectable()
export class AppointmentFeed implements OnModuleInit, OnModuleDestroy {
  /**
   * L'identité de cette instance sur le canal : ce qui lui fait reconnaître, et
   * ignorer, ce qu'elle a elle-même publié — ses connexions l'ont déjà reçu.
   */
  private readonly origin = randomUUID();

  private readonly watchers = new Set<Watcher>();

  private readonly unsubscribers: Array<() => void> = [];

  public constructor(
    private readonly events: AppointmentEvents,
    private readonly broadcast: CacheBroadcast,
    private readonly repository: AppointmentsRepository,
    private readonly logger: StructuredLogger,
  ) {}

  public onModuleInit(): void {
    const relay = (event: AppointmentDomainEvent): void => {
      this.emit(feedSignalOf(event));
    };

    this.unsubscribers.push(
      this.events.onAppointmentCreated(relay),
      this.events.onAppointmentConfirmed(relay),
      this.events.onAppointmentRescheduled(relay),
      this.events.onAppointmentCancelled(relay),
      this.events.onAppointmentStatusChanged(relay),
    );
  }

  public onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.watchers.clear();
  }

  /**
   * Le périmètre de l'appelant, dérivé de son jeton.
   *
   * Doit être appelé **dans** la requête : la fiche praticien se lit dans la
   * portée de tenant que `JwtAuthGuard` y a posée.
   *
   * Un compte praticien sans fiche n'a aucun agenda à lui ; il retombe sur le
   * périmètre « cliente » de son propre compte, qui ne désigne aucun rendez-vous.
   * C'est la réponse sûre : rien, plutôt que le salon entier.
   */
  public async audienceOf(user: AuthenticatedUser): Promise<AppointmentFeedAudience> {
    const { tenantId } = user;

    if (roleHasPermission(user.role, ESTABLISHMENT_AGENDA)) {
      return { kind: 'establishment', tenantId };
    }

    if (roleHasPermission(user.role, OWN_AGENDA)) {
      const staff = await this.repository.findStaffByUserId(user.userId);

      if (staff !== null) {
        return { kind: 'staff', tenantId, staffId: staff.id };
      }
    }

    return { kind: 'client', tenantId, clientId: user.userId };
  }

  /**
   * Branche une connexion sur le flux de son établissement, et rend de quoi la
   * débrancher.
   */
  public watch(audience: AppointmentFeedAudience, listener: AppointmentFeedListener): () => void {
    const watcher: Watcher = { audience, listener };

    this.watchers.add(watcher);

    const stopRelay = this.broadcast.subscribe(feedChannel(audience.tenantId), (raw) => {
      const signal = this.decode(raw);

      if (signal !== null) {
        this.offer(watcher, signal);
      }
    });

    return () => {
      this.watchers.delete(watcher);
      stopRelay();
    };
  }

  /** Sert les connexions locales, puis publie pour les autres instances. */
  private emit(signal: AppointmentFeedSignal): void {
    for (const watcher of this.watchers) {
      this.offer(watcher, signal);
    }

    const relayed: RelayedSignal = { origin: this.origin, signal };

    void this.broadcast.publish(feedChannel(signal.tenantId), JSON.stringify(relayed));
  }

  private offer(watcher: Watcher, signal: AppointmentFeedSignal): void {
    if (!reaches(watcher.audience, signal)) {
      return;
    }

    try {
      watcher.listener(signal.event);
    } catch (error: unknown) {
      this.logger.error('connexion du flux de rendez-vous en échec', {
        appointmentId: signal.event.appointmentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Relit un message venu de Redis — ou rien.
   *
   * Le canal n'est écrit que par nos instances, mais ce qui en sort part vers des
   * navigateurs : l'événement est revalidé contre le contrat plutôt que cru sur
   * parole. Un message de cette instance-ci est écarté — ses connexions l'ont
   * déjà reçu.
   */
  private decode(raw: string): AppointmentFeedSignal | null {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isRelayedSignal(parsed) || parsed.origin === this.origin) {
      return null;
    }

    const event = appointmentFeedEventSchema.safeParse(parsed.signal.event);

    if (!event.success) {
      return null;
    }

    return { ...parsed.signal, event: event.data };
  }
}

function isRelayedSignal(value: unknown): value is RelayedSignal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const { origin, signal } = value as Record<string, unknown>;

  if (typeof origin !== 'string' || typeof signal !== 'object' || signal === null) {
    return false;
  }

  const { tenantId, clientId, staffIds } = signal as Record<string, unknown>;

  return (
    typeof tenantId === 'string' &&
    typeof clientId === 'string' &&
    Array.isArray(staffIds) &&
    staffIds.every((staffId) => typeof staffId === 'string')
  );
}
