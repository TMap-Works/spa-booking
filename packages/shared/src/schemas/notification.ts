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
 * Les motifs d'échec d'un envoi, tels que la trace les porte — #1328.
 *
 * ## Pourquoi un vocabulaire, et non la phrase de l'erreur
 *
 * `failure_reason` portait jusqu'ici le `message` de l'erreur levée par la chaîne
 * d'envoi, c'est-à-dire une phrase **française** écrite dans
 * `apps/api/src/modules/notifications/notifications.errors.ts`. Le back-office
 * l'affichait telle quelle : un salon anglophone lisait « Aucun expéditeur n'est
 * configuré pour ce canal de notification. » au milieu d'un écran en anglais.
 * Traduire côté API aurait déplacé le problème — la langue de lecture n'est pas
 * connue au moment de l'échec, et l'écran peut changer de langue après coup —, et
 * l'a déjà réglé pour les refus HTTP : « le front réagit sur `code`, jamais sur
 * `message` » (`packages/shared/src/errors/error-codes.ts`). C'est la même
 * discipline ici, un cran plus loin : ce qui s'enregistre est un code, et la
 * phrase se choisit à l'affichage.
 *
 * ## Ce n'est pas la liste des codes d'erreur du module
 *
 * `NOTIFICATION_ERROR_CODES` dit à un **appelant HTTP** pourquoi sa requête est
 * refusée ; ceci dit à la **personne au comptoir** pourquoi un message n'est pas
 * parti. Les deux jeux ne se recouvrent pas : `NOTIFICATION_TEMPLATE_TOO_LONG`
 * refuse une saisie et n'atteint jamais une trace, tandis que
 * `recipient_unreachable` — le cas le plus fréquent au comptoir — n'a pas de code
 * d'erreur propre, son erreur retombant sur `BUSINESS_RULE_VIOLATION`. Les
 * confondre aurait fait afficher « Cette action n'est pas autorisée par les
 * règles du salon. » sur un SMS qu'aucun numéro ne pouvait recevoir.
 *
 * ## Le vocabulaire est clos, la lecture ne l'est pas
 *
 * `failureReason` reste une chaîne libre au contrat, et c'est **délibéré** :
 * les lignes écrites avant ce ticket portent une phrase, et une lecture
 * refusée ferait échouer la validation de `GET /api/v1/notifications` sur une
 * donnée d'historique — donc un tiroir de rendez-vous vide, là où le journal
 * d'envois est justement ce qui explique une cliente absente. Tout ce que le
 * vocabulaire ne nomme pas s'affiche par un repli traduit
 * (`admin-planning.notifications.failureReasons.unknown`), jamais brut et jamais
 * en `MISSING_MESSAGE`.
 *
 * Il vit avec le schéma de la trace, et non dans `constants/notification.ts` où
 * sont les canaux, les types et les statuts : ces trois-là sont des types
 * énumérés de la base, dont la casse se convertit à la sérialisation, alors que
 * celui-ci n'est le contenu d'aucune énumération — la colonne est une
 * `VARCHAR(500)` que ce ticket restreint par convention, sans migration.
 */
export const NOTIFICATION_FAILURE_REASONS = [
  /** Aucun expéditeur n'est branché sur ce canal — capacité absente, SQS réessaie. */
  'sender_not_configured',
  /** Aucun modèle ne permet de composer ce message dans cette langue. */
  'template_missing',
  /** Le rendez-vous que le message annonce n'existe plus — rien à rejouer. */
  'appointment_gone',
  /** Plus de compte, adresse vide, ou numéro non normalisable — échec permanent. */
  'recipient_unreachable',
  /**
   * Tout le reste : panne du fournisseur, erreur inattendue, et les motifs
   * rédigés avant #1328. Le détail du diagnostic est au journal de l'API, pas
   * dans cette colonne.
   */
  'unknown',
] as const;

export const notificationFailureReasonSchema = z.enum(NOTIFICATION_FAILURE_REASONS);

export type NotificationFailureReason = z.infer<typeof notificationFailureReasonSchema>;

const KNOWN_FAILURE_REASONS: ReadonlySet<string> = new Set(NOTIFICATION_FAILURE_REASONS);

/**
 * `true` si `value` est l'un des motifs ci-dessus.
 *
 * Le garde existe parce que la lecture est ouverte : un motif stocké avant #1328
 * est une phrase, et c'est ce test — et lui seul — qui décide si l'écran traduit
 * le code ou retombe sur son repli. Écrit ici plutôt que dans le composant pour
 * que l'API et le front partagent le même jugement.
 */
export function isNotificationFailureReason(
  value: unknown,
): value is NotificationFailureReason {
  return typeof value === 'string' && KNOWN_FAILURE_REASONS.has(value);
}

/**
 * Le motif affichable d'une valeur quelconque — le point de repli unique.
 *
 * Rend `undefined` quand il n'y a rien à afficher, le code quand il est connu, et
 * `unknown` pour tout le reste : une phrase d'historique, un code d'une version
 * plus récente de l'API, une chaîne vide. L'appelant n'a donc jamais à choisir
 * entre « afficher brut » et « n'afficher rien », les deux écueils que le
 * deuxième critère d'acceptation de #1328 interdit.
 */
export function notificationFailureReasonOf(
  value: string | null | undefined,
): NotificationFailureReason | undefined {
  if (value === null || value === undefined || value.trim() === '') {
    return undefined;
  }

  return isNotificationFailureReason(value) ? value : 'unknown';
}

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
  /**
   * Le motif du dernier échec — un code de `NOTIFICATION_FAILURE_REASONS` depuis
   * #1328, mais validé comme une chaîne libre : les lignes antérieures portent
   * une phrase française, et les refuser rendrait illisible tout le journal du
   * rendez-vous qui en contient une. `notificationFailureReasonOf` est le seul
   * endroit où cette tolérance se résout.
   */
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
