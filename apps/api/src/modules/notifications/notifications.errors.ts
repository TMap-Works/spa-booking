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
  NOTIFICATION_NOT_RENDERABLE: 'NOTIFICATION_NOT_RENDERABLE',
  NOTIFICATION_CONTEXT_GONE: 'NOTIFICATION_CONTEXT_GONE',
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

/**
 * Aucun modèle n'existe pour ce type de message.
 *
 * **503 comme l'expéditeur absent**, et pour la même raison : ce n'est pas une
 * requête fautive, c'est une capacité qui n'est pas encore livrée. #70 rend la
 * confirmation ; le rappel J-1 et l'avis d'annulation ont leurs issues.
 *
 * Le refus vaut mieux qu'un repli sur le modèle de confirmation : un rappel qui
 * annoncerait « votre rendez-vous est confirmé » serait pire qu'un rappel
 * absent, et l'échec laisse la ligne `FAILED`, donc reprenable le jour où le
 * modèle existe.
 */
export class UnrenderableNotificationError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_NOT_RENDERABLE;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor(type: string) {
    super("Aucun modèle de message n'est défini pour ce type de notification.", { type });
  }
}

/**
 * Le rendez-vous que ce message annonce n'existe plus.
 *
 * **404 et non 503** : rien ne se répare en réessayant, la donnée a disparu. Le
 * `DomainExceptionFilter` la traduirait en 404 si une route la laissait passer,
 * mais son vrai destinataire est le consommateur de file — pour qui elle signifie
 * « ce message n'a plus d'objet, cesse de le rejouer ».
 *
 * Le cas est réel et non théorique : une livraison SQS peut arriver après une
 * anonymisation RGPD ou une suppression de rendez-vous, et la fenêtre entre la
 * publication et la consommation n'est bornée par rien.
 */
export class NotificationContextGoneError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_CONTEXT_GONE;
  public override readonly status = 404;

  public constructor(appointmentId: string) {
    super("Le rendez-vous que ce message annonce n'existe plus.", { appointmentId });
  }
}
