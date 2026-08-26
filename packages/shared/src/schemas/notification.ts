/**
 * Notifications — confirmation de réservation, rappel J-1, avis d'annulation.
 *
 * Trois messages, deux canaux : le périmètre MVP s'arrête là (CDC §1.4).
 *
 * **Aucune coordonnée n'apparaît dans ces schémas.** Ni l'adresse e-mail ni le
 * numéro de destination : ils se relisent sur le compte au moment de l'envoi.
 * Les recopier dans la trace de notification dupliquerait une donnée personnelle
 * qu'il faudrait ensuite effacer à deux endroits sur une demande RGPD — et la
 * seconde copie est toujours celle qu'on oublie.
 */

import { z } from 'zod';

import { reasonSchema, uuidSchema } from '../common/identifiers';
import { utcInstantSchema } from '../common/time';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
} from '../constants/notification';

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export const notificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

/**
 * Trace d'un message, telle que la voit le back-office.
 *
 * `scheduledFor` distingue le rappel J-1 — planifié — des deux autres messages,
 * émis dans la foulée de l'action qui les déclenche. `attemptCount` et
 * `failureReason` existent parce qu'un SMS non délivré doit être visible depuis
 * l'écran du salon : sans cela, la seule trace d'un rappel jamais parti est la
 * cliente qui ne vient pas.
 */
export const notificationSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.optional(),
  recipientUserId: uuidSchema.optional(),
  type: notificationTypeSchema,
  channel: notificationChannelSchema,
  status: notificationStatusSchema,
  scheduledFor: utcInstantSchema.optional(),
  sentAt: utcInstantSchema.optional(),
  attemptCount: z.number().int().min(0),
  failureReason: reasonSchema.optional(),
  createdAt: utcInstantSchema,
});

export type Notification = z.infer<typeof notificationSchema>;

/**
 * Préférences de contact d'un client.
 *
 * Le SMS se désactive, l'e-mail non : la confirmation de réservation est la
 * preuve du rendez-vous, et un établissement doit pouvoir la produire. Un opt-out
 * total relève de la suppression du compte, pas d'une case à cocher.
 */
export const notificationPreferencesSchema = z
  .object({
    smsEnabled: z.boolean(),
  })
  .strict();

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Filtres du journal d'envois du back-office. */
export const notificationListQuerySchema = z
  .object({
    appointmentId: uuidSchema.optional(),
    type: notificationTypeSchema.optional(),
    channel: notificationChannelSchema.optional(),
    statuses: z.array(notificationStatusSchema).nonempty().optional(),
  })
  .strict();

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
