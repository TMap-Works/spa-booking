/**
 * Notifications — CDC §1.4 : trois messages, deux canaux, rien de plus.
 *
 * Le marketing, les campagnes et les modèles personnalisables sont hors
 * périmètre MVP (CLAUDE.md, contrainte 1). Ajouter une valeur ici revient à
 * élargir le périmètre : cela passe par une issue, pas par une ligne.
 */

export const NOTIFICATION_CHANNELS = ['email', 'sms'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'booking_confirmation',
  'reminder_24h',
  'cancellation',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** `true` si `value` est un canal de notification connu. */
export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}
