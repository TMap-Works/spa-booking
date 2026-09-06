import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `notifications` — le seul fichier d'erreurs du module.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en
 * `{ code, message, details }` le jour où une route les fera passer par HTTP.
 *
 * **Aucune ne porte de donnée personnelle.** Ni adresse e-mail, ni numéro, ni
 * nom de cliente : un `details` d'erreur est journalisé, et notifications §7
 * interdit de journaliser les coordonnées comme le contenu des messages. Ce qui
 * s'y trouve est un identifiant de notification et un canal — rien d'autre.
 */

/** 503 — `DOMAIN_HTTP_STATUS` ne connaît pas les dépendances externes. */
const SERVICE_UNAVAILABLE = 503;

/** Codes d'erreur du module, tels qu'ils partiraient au client. */
export const NOTIFICATION_ERROR_CODES = {
  NOTIFICATION_SENDER_NOT_CONFIGURED: 'NOTIFICATION_SENDER_NOT_CONFIGURED',
} as const;

/**
 * Aucun expéditeur n'est branché pour ce canal.
 *
 * **503 et non 500** : ce n'est pas un défaut de notre code, c'est une capacité
 * absente — le même régime que `PaymentProviderUnavailableError` quand les clés
 * Stripe manquent. Le module démarre sans SES ni SNS, et c'est délibéré : #68
 * pose la table, l'ordre d'écriture et l'idempotence ; les passerelles AWS
 * viennent avec la Lambda d'envoi, et les brancher ici aurait mêlé deux tickets.
 *
 * Elle laisse la ligne en `FAILED` et remonte à l'appelant, donc à SQS, qui
 * réessaiera avec son backoff natif avant la DLQ (notifications §4). C'est la
 * conduite qu'on veut : un canal non configuré est un incident d'exploitation
 * qui doit se voir dans la profondeur de la DLQ, pas un message avalé en
 * silence.
 */
export class NotificationSenderNotConfiguredError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_SENDER_NOT_CONFIGURED;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor(channel: string) {
    super("Aucun expéditeur n'est configuré pour ce canal de notification.", { channel });
  }
}
