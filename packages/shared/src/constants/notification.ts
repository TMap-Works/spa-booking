/**
 * Notifications — CDC §1.4 : trois messages de rendez-vous, deux canaux.
 *
 * Le marketing, les campagnes et les modèles personnalisables sont hors
 * périmètre MVP (CLAUDE.md, contrainte 1). Ajouter une valeur ici revient à
 * élargir le périmètre : cela passe par une issue, pas par une ligne.
 *
 * Une quatrième valeur y est entrée par cette porte-là, et par elle seule :
 * `password_reset` (#809). Elle n'ajoute aucun message que le rendez-vous
 * déclenche — elle porte le lien de **récupération d'un accès perdu**, que le
 * CDC §2.3 exige au titre de l'authentification des clientes, du personnel et
 * des administrateurs. La chaîne d'envoi est unique : la seule autre issue
 * aurait été un appel direct à SES depuis le chemin de requête HTTP, que
 * notifications §1 interdit.
 *
 * La cinquième, `appointment_confirmed` (#800), est du CDC §1.4 : c'est la
 * seconde moitié de la « confirmation automatique ». Tout rendez-vous naît à
 * confirmer par le salon ; `booking_confirmation` le dit à la réservation, et
 * `appointment_confirmed` part quand le salon a confirmé.
 *
 * La sixième, `appointment_rescheduled`, dit à la cliente que son rendez-vous a
 * été déplacé : un report crée un rendez-vous neuf sans passer par la
 * réservation, et rien ne la prévenait quand le salon le faisait.
 *
 * L'ordre compte : les trois messages du CDC §1.4 restent en tête, et c'est
 * l'ordre de déclaration de l'énumération PostgreSQL. Insérer une valeur au
 * milieu désaccorderait les deux.
 */

export const NOTIFICATION_CHANNELS = ['email', 'sms'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_TYPES = [
  'booking_confirmation',
  'reminder_24h',
  'cancellation',
  'password_reset',
  'appointment_confirmed',
  'appointment_rescheduled',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_STATUSES = ['pending', 'sent', 'failed'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** `true` si `value` est un canal de notification connu. */
export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === 'string' && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}
