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

/** 401 — `DOMAIN_HTTP_STATUS` s'arrête à 403 : il ne connaît que les droits, pas l'authentification. */
const UNAUTHORIZED = 401;

/** Codes d'erreur du module, tels qu'ils partiraient au client. */
export const NOTIFICATION_ERROR_CODES = {
  NOTIFICATION_SENDER_NOT_CONFIGURED: 'NOTIFICATION_SENDER_NOT_CONFIGURED',
  NOTIFICATION_NOT_RENDERABLE: 'NOTIFICATION_NOT_RENDERABLE',
  NOTIFICATION_CONTEXT_GONE: 'NOTIFICATION_CONTEXT_GONE',
  INTERNAL_CALLER_NOT_CONFIGURED: 'INTERNAL_CALLER_NOT_CONFIGURED',
  INTERNAL_CALLER_REJECTED: 'INTERNAL_CALLER_REJECTED',
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

/**
 * Aucun jeton d'appel interne n'est configuré sur cette API.
 *
 * **503, comme l'expéditeur absent** : ce n'est pas une requête fautive, c'est
 * une capacité qui n'est pas branchée. Le défaut est fermé — sans jeton attendu,
 * aucun appel n'est reconnu — parce qu'accepter reviendrait à ouvrir aux
 * anonymes une route qui lit les rendez-vous de tous les établissements.
 *
 * Le refus est **bruyant par requête** plutôt que bloquant au démarrage : le
 * balayage horaire échoue à chaque heure, la Lambda le journalise, et son alarme
 * d'erreurs le voit. Un démarrage refusé aurait immobilisé l'API entière pour une
 * capacité que le reste du module n'exige pas encore.
 */
export class InternalCallerUnconfiguredError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.INTERNAL_CALLER_NOT_CONFIGURED;
  public override readonly status = SERVICE_UNAVAILABLE;

  public constructor() {
    super("Aucun jeton d'appel interne n'est configuré sur cette API.");
  }
}

/**
 * Le jeton présenté n'est pas celui attendu — ou il manque.
 *
 * **401 et non 403** : la question n'est pas « avez-vous le droit ? » mais
 * « êtes-vous bien qui vous dites ». C'est aussi ce que la Lambda d'envoi de #67
 * classe comme **transitoire** — « un refus d'authentification ne dit rien du
 * message, il dit que la fonction ne s'est pas fait reconnaître » —, si bien
 * qu'une rotation de secret à mi-course fait rejouer les messages au lieu de les
 * acquitter dans le vide.
 *
 * Aucun `details` : ni le jeton présenté, ni sa longueur, ni le fait de savoir
 * s'il était absent ou faux. Tout cela renseignerait qui cherche à le deviner.
 */
export class InternalCallerRejectedError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.INTERNAL_CALLER_REJECTED;
  public override readonly status = UNAUTHORIZED;

  public constructor() {
    super("Appel interne refusé : jeton absent ou invalide.");
  }
}
