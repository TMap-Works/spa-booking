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
import { localeSchema } from '../locale/locale';

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
 *
 * ## `locale` — la langue dans laquelle le message est **réellement** parti (#854)
 *
 * Deuxième critère d'acceptation de #854 : « la langue retenue est enregistrée
 * sur la notification émise ». Ce n'est pas une préférence recopiée, c'est un
 * **constat** : la langue du destinataire, ou à défaut celle de l'établissement,
 * telle qu'elle a été résolue au moment de l'expédition. Sans elle, un salon qui
 * reçoit « votre cliente dit n'avoir rien compris au SMS » n'a aucun moyen de
 * savoir en quelle langue il est parti.
 *
 * ## Pourquoi `optional()` alors que la colonne est `NOT NULL`
 *
 * Parce qu'ajouter un champ **obligatoire** à un schéma de réponse est un
 * changement cassant : `apps/web/lib/api-client.ts` valide les réponses de
 * `GET /api/v1/notifications` avec ce schéma, et tout consommateur qui compose
 * un `Notification` en test verrait sa forme refusée du jour au lendemain. Un
 * champ facultatif s'ajoute sans rien casser, et l'API l'émet systématiquement —
 * c'est la même discipline que pour `sentAt` et `scheduledFor`, que le contrat
 * omet plutôt que de les rendre à `null`.
 */
export const notificationSchema = z.object({
  id: uuidSchema,
  appointmentId: uuidSchema.optional(),
  recipientUserId: uuidSchema.optional(),
  type: notificationTypeSchema,
  channel: notificationChannelSchema,
  status: notificationStatusSchema,
  locale: localeSchema.optional(),
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
