import { z } from 'zod';

import { uuidSchema } from '../common/identifiers';
import { utcInstantSchema } from '../common/time';
import { cancellationActorSchema } from './appointment';

/**
 * Le flux temps réel des rendez-vous — `GET /v1/appointments/stream`.
 *
 * ## Ce qu'il est
 *
 * Un flux `text/event-stream` (Server-Sent Events) qui prévient un écran ouvert
 * qu'un rendez-vous **de son périmètre** vient de changer : la gérante voit
 * arriver la réservation que la cliente vient de faire, la cliente voit son
 * rendez-vous passer « confirmé » à l'instant où le salon clique. Le CDC §1.4
 * demande un « calendrier de disponibilité temps réel » ; un planning qu'il faut
 * recharger à la main pour voir la réservation d'à côté n'en est pas un.
 *
 * ## Un signal, pas une donnée
 *
 * Chaque message dit **qu'un** rendez-vous a changé, et comment — jamais ce
 * qu'il contient. Ni nom, ni prestation, ni praticien, ni note : l'écran qui le
 * reçoit **relit** ce qu'il affiche par ses routes habituelles, qui appliquent
 * chacune leur propre contrôle d'accès. Le flux n'a donc aucune règle de
 * visibilité à dupliquer, et rien à fuiter s'il se trompait de destinataire —
 * au pire un identifiant opaque et une heure.
 *
 * `startsAt` est la seule donnée métier, et elle ne sert qu'à dire **où**
 * regarder : le jour du planning à relire, le jour que l'annonce propose
 * d'ouvrir.
 *
 * ## Le périmètre, décidé par le jeton
 *
 * | Appelant | Reçoit |
 * |---|---|
 * | `agenda:read:all` (gérante, administratrice) | tous les rendez-vous de l'établissement |
 * | praticien (`agenda:read:own`) | les rendez-vous de **sa** fiche |
 * | cliente | **ses** rendez-vous |
 *
 * Aucun paramètre ne le change : il n'y en a pas.
 */

/** Le nom d'événement SSE sous lequel chaque changement est émis. */
export const APPOINTMENT_FEED_EVENT = 'appointment' as const;

/**
 * Le nom d'événement SSE du battement de cœur — un message vide toutes les
 * vingt-cinq secondes, pour qu'aucun intermédiaire (répartiteur de charge,
 * proxy) ne coupe une connexion qu'il croirait morte.
 */
export const APPOINTMENT_FEED_HEARTBEAT = 'ping' as const;

/**
 * Ce qui vient d'arriver au rendez-vous.
 *
 * Un par événement de domaine, et le vocabulaire est celui du contrat — en
 * minuscules, comme `appointmentStatusSchema` — et non celui du bus.
 */
export const APPOINTMENT_FEED_CHANGES = [
  'created',
  'confirmed',
  'rescheduled',
  'cancelled',
  'completed',
  'no_show',
] as const;

export const appointmentFeedChangeSchema = z.enum(APPOINTMENT_FEED_CHANGES);

export type AppointmentFeedChange = z.infer<typeof appointmentFeedChangeSchema>;

export const appointmentFeedEventSchema = z.object({
  change: appointmentFeedChangeSchema,
  /** Le rendez-vous concerné — le **nouveau** après un report. */
  appointmentId: uuidSchema,
  /** Après un report : celui qu'il remplace, désormais annulé. */
  previousAppointmentId: uuidSchema.optional(),
  /**
   * Début du soin (intervalle facturé), quand l'événement le porte : réservation,
   * report — l'heure d'arrivée —, annulation.
   */
  startsAt: utcInstantSchema.optional(),
  /** Après une annulation : de quel côté du comptoir elle vient. */
  cancelledBy: cancellationActorSchema.optional(),
  /** Instant du changement, ISO 8601 UTC. */
  occurredAt: utcInstantSchema,
});

export type AppointmentFeedEvent = z.infer<typeof appointmentFeedEventSchema>;
