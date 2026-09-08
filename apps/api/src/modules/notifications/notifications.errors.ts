import { NOTIFICATION_ERROR_CODES } from '@spa/shared';

import { DomainError } from '../../common/errors';

/**
 * Erreurs du module `notifications` — le seul fichier d'erreurs du module.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit en
 * `{ code, message, details }` le jour où une route les fera passer par HTTP.
 *
 * Les **codes** viennent désormais de `@spa/shared`, où le rapatriement de #536
 * leur a créé une famille propre au module, et sont réexportés d'ici. Le contrat
 * n'en portait aucun : les huit y ont été ajoutés à l'identique. Cela vaut aussi
 * pour ceux que seul le consommateur de file lit — un code qui ne sort pas
 * aujourd'hui par HTTP peut en sortir demain, et le contrat est l'endroit où
 * cette liste se tient.
 *
 * **Aucune ne porte de donnée personnelle.** Ni adresse e-mail, ni numéro, ni
 * nom de cliente : un `details` d'erreur est journalisé, et notifications §7
 * interdit de journaliser les coordonnées comme le contenu des messages. Ce qui
 * s'y trouve est un identifiant de notification et un canal — rien d'autre.
 */
export { NOTIFICATION_ERROR_CODES };

/** 503 — `DOMAIN_HTTP_STATUS` ne connaît pas les dépendances externes. */
const SERVICE_UNAVAILABLE = 503;

/** 401 — `DOMAIN_HTTP_STATUS` s'arrête à 403 : il ne connaît que les droits, pas l'authentification. */
const UNAUTHORIZED = 401;

/** 400 — la requête est fautive, et le champ en cause est nommé. */
const BAD_REQUEST = 400;

/** 404 — aucun modèle, ni personnalisé ni par défaut, pour ce message. */
const NOT_FOUND = 404;

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

/**
 * Le modèle soumis nomme des variables qui n'existent pas — ou laisse une
 * section ouverte (#69).
 *
 * **400 et non 422** : c'est une requête fautive, et le champ en cause est
 * nommable. Le `details` porte les noms exacts, parce que c'est la seule chose
 * qui aide : un salon qui a écrit `{{prenom}}` doit lire « prenom », pas
 * « modèle invalide ».
 *
 * ## Pourquoi refuser plutôt que rendre à vide
 *
 * Une variable inconnue rendue à vide ne se découvrirait que dans l'e-mail d'une
 * cliente, une fois parti — « Bonjour , » au lieu de « Bonjour Amina, ». Le refus
 * a lieu au seul instant où quelqu'un est là pour le corriger : la saisie.
 *
 * Ce refus est aussi la frontière de sécurité du moteur. La liste des variables
 * est close ; ce qu'elle ne nomme pas n'est pas substituable, donc pas
 * exposable. Un modèle qui pourrait nommer n'importe quoi serait un moyen de lire
 * ce que le rendu a sous la main.
 */
export class NotificationTemplateInvalidError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_TEMPLATE_INVALID;
  public override readonly status = BAD_REQUEST;

  public constructor(details: {
    readonly unknownVariables?: readonly string[];
    readonly unbalancedSections?: readonly string[];
    /**
     * Champs que le canal exige et que le modèle laisse vides — `subject` sur
     * l'e-mail. La contrainte dépend du canal, elle ne peut donc pas être portée
     * par un décorateur du DTO, qui ne connaît que le corps de la requête.
     */
    readonly missingFields?: readonly string[];
  }) {
    super(
      'Le modèle emploie des variables inconnues, laisse une section non refermée, ' +
        'ou omet un champ que son canal exige.',
      details,
    );
  }
}

/**
 * Le modèle de SMS coûterait plus que le plafond de segments (#69).
 *
 * **400** : le modèle est refusé, pas tronqué. Tronquer aurait enregistré une
 * chaîne que le salon n'a pas écrite, et lui aurait fait découvrir la coupure
 * dans le message reçu par sa cliente.
 *
 * Le `details` porte l'encodage et le nombre de segments mesurés, parce que c'est
 * ce qui rend la faute compréhensible : « 2 segments en UCS-2 » dit au salon que
 * son apostrophe typographique vient de doubler sa facture, là où « trop long »
 * l'aurait laissé raccourcir un texte qui n'était pas trop long
 * (notifications §5).
 *
 * Aucun contenu de modèle dans le `details` : un `details` d'erreur est
 * journalisé, et si un modèle ne porte pas de donnée personnelle, il n'y a
 * aucune raison de faire grossir un journal avec un corps d'e-mail.
 */
export class NotificationTemplateTooLongError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_TEMPLATE_TOO_LONG;
  public override readonly status = BAD_REQUEST;

  public constructor(details: {
    readonly encoding: string;
    readonly segments: number;
    readonly maxSegments: number;
  }) {
    super(
      'Ce modèle de SMS dépasse le nombre de segments autorisé : un accent hors GSM-7 ' +
        'bascule le message en UCS-2 et le limite à 70 caractères au lieu de 160.',
      details,
    );
  }
}

/**
 * Aucun modèle — ni personnalisé, ni par défaut — pour ce message.
 *
 * **404** : la ressource demandée n'existe pas. Depuis #72, les trois messages du
 * CDC §1.4 ont tous leur défaut de plateforme sur les deux canaux : aucune valeur
 * de `NotificationType` ne l'atteint plus, et le DTO du contrôleur n'en laisse
 * passer aucune autre. La barrière reste pour le message qu'on ajouterait à
 * l'énumération sans son modèle — mieux vaut 404 que servir celui d'un autre.
 * Distinct d'`UnrenderableNotificationError`, qui est le même fait vu depuis la
 * chaîne d'envoi et se traduit en 503 : là-bas, c'est une capacité absente qui
 * laisse la ligne reprenable ; ici, c'est une lecture qui ne trouve rien.
 */
export class NotificationTemplateNotFoundError extends DomainError {
  public override readonly code = NOTIFICATION_ERROR_CODES.NOTIFICATION_TEMPLATE_NOT_FOUND;
  public override readonly status = NOT_FOUND;

  public constructor(type: string, channel: string) {
    super("Aucun modèle de message n'existe pour ce type et ce canal.", { type, channel });
  }
}
