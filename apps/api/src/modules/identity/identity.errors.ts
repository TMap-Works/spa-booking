import { IDENTITY_ERROR_CODES, type Permission } from '@spa/shared';

import { DomainError, DOMAIN_HTTP_STATUS } from '../../common/errors';
import type { DomainErrorDetails } from '../../common/errors';

/**
 * Erreurs du module `identity`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur `code`,
 * jamais sur `message`.
 *
 * Les **codes** viennent désormais de `@spa/shared` et sont simplement
 * réexportés d'ici (#536) : le contrat est leur seule écriture, et la famille
 * n'est plus à cheval sur deux sources. Ce qu'a coûté ce rapatriement, et qui
 * est écrit en tête de `packages/shared/src/errors/error-codes.ts` : les six
 * codes que le contrat déclarait ici sans que l'API les émette jamais —
 * `ACCESS_TOKEN_EXPIRED`, `INVALID_TOKEN`, `REFRESH_TOKEN_REVOKED`,
 * `ACCOUNT_DISABLED`, `INSUFFICIENT_ROLE`, `TENANT_UNAVAILABLE` — ont été
 * retirés. Les refus de jeton et de rôle ne passent pas par une `DomainError`
 * mais par les gardes de Nest, et sortent en `UNAUTHORIZED` ou `FORBIDDEN`.
 */
export { IDENTITY_ERROR_CODES };

/** 401 — absent de `DOMAIN_HTTP_STATUS`, qui ne connaît pas encore l'authentification. */
const UNAUTHORIZED = 401;
const CONFLICT = 409;

/**
 * Identifiants refusés.
 *
 * **Un seul message pour trois causes distinctes** — compte inexistant, mot de
 * passe faux, compte désactivé — et c'est délibéré. Distinguer « cet e-mail est
 * inconnu » de « ce mot de passe est faux » transforme le formulaire de connexion
 * en oracle d'énumération : on découvre qui est client de quel salon sans jamais
 * réussir à se connecter. Le détail de la cause part dans le journal, pas dans la
 * réponse.
 *
 * Aucun `details` n'est jamais renseigné ici, pour la même raison.
 */
export class InvalidCredentialsError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVALID_CREDENTIALS;
  public override readonly status = UNAUTHORIZED;

  public constructor() {
    super('Identifiants invalides.');
  }
}

/**
 * Inscription sur une adresse déjà prise **dans cet établissement**.
 *
 * L'unicité de l'e-mail est par tenant : la même personne peut être cliente de
 * deux salons, et l'un ne doit pas pouvoir en déduire l'autre. Ce conflit ne dit
 * donc rien de plus que « ici, cette adresse est prise » — ce que la personne qui
 * la saisit sait déjà si le compte est le sien.
 */
export class EmailAlreadyRegisteredError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.EMAIL_ALREADY_REGISTERED;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Cette adresse e-mail est déjà utilisée dans cet établissement.');
  }
}

/**
 * Jeton de rafraîchissement absent, illisible, expiré, révoqué — ou **rejoué**.
 *
 * Le message ne distingue pas ces cas : un porteur de jeton volé apprendrait, à
 * la nuance du message, si la session est encore vivante.
 */
export class InvalidRefreshTokenError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVALID_REFRESH_TOKEN;
  public override readonly status = UNAUTHORIZED;

  public constructor(details: DomainErrorDetails = {}) {
    super('Session invalide ou expirée.', details);
  }
}

/**
 * Invitation de personnel refusée — #55.
 *
 * **Un seul message pour cinq causes** : jeton contrefait, expiré, désignant un
 * compte supprimé, désignant un compte désactivé, ou déjà accepté. Le point
 * d'entrée qui la lève n'est pas authentifié : distinguer les cas en ferait un
 * oracle qui dit, à qui présente un jeton ramassé, si le compte existe encore et
 * s'il est actif. Le détail part dans le journal, pas dans la réponse.
 *
 * 401 et non 422 : ce qui est refusé est une **preuve de qualité**, pas une
 * règle métier. C'est le régime d'`InvalidRefreshTokenError`, pour la même
 * raison.
 */
export class InvalidInvitationError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVALID_INVITATION;
  public override readonly status = UNAUTHORIZED;

  public constructor(details: DomainErrorDetails = {}) {
    super('Invitation invalide ou expirée.', details);
  }
}

/**
 * Jeton de réinitialisation de mot de passe refusé — #809.
 *
 * **Un seul message pour six causes** : jeton contrefait, expiré, déjà consommé,
 * remplacé par une demande plus récente, désignant un compte disparu, ou
 * désignant un compte désactivé. Même raisonnement qu'`InvalidInvitationError`,
 * et il porte ici davantage : le lien circule par courrier, il traverse des
 * boîtes partagées et des historiques de navigation, et distinguer les cas
 * dirait à qui le ramasse si le compte qu'il désigne est encore en service.
 *
 * 401 et non 422, pour la raison qui vaut pour les deux autres jetons : ce qui
 * est refusé est une **preuve de qualité**, pas une règle métier.
 *
 * ## La demande, elle, ne lève jamais
 *
 * Cette erreur n'est le fait que de la **confirmation**. La demande de
 * réinitialisation répond 202 en toutes circonstances — adresse inconnue,
 * compte désactivé, demande trop rapprochée — parce qu'un refus y ferait de ce
 * formulaire un annuaire de la clientèle du salon (premier critère
 * d'acceptation).
 */
export class InvalidPasswordResetTokenError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVALID_PASSWORD_RESET_TOKEN;
  public override readonly status = UNAUTHORIZED;

  public constructor(details: DomainErrorDetails = {}) {
    super('Lien de réinitialisation invalide ou expiré.', details);
  }
}

/**
 * Réémission demandée sur un compte **déjà activé** — #55.
 *
 * Distincte d'`InvalidInvitationError`, et sans contradiction avec elle : la
 * réémission est demandée par un administrateur **authentifié** de
 * l'établissement, qui a déjà le droit de lire ce compte et de savoir qu'il a
 * été activé. Il n'y a donc rien à taire, et lui répondre « invitation
 * invalide » le laisserait réessayer sans comprendre. 409 : l'état du monde
 * s'oppose à l'opération, il ne s'agit ni d'un droit manquant ni d'une
 * ressource absente.
 */
export class InvitationAlreadyAcceptedError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVITATION_ALREADY_ACCEPTED;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Ce compte a déjà été activé : son invitation ne peut plus être réémise.');
  }
}

/**
 * L'appelant n'a le droit d'agir que sur **son propre** périmètre, et la
 * ressource visée n'en fait pas partie — #812, troisième critère, ADR 0013.
 *
 * ## 403, et pourquoi ce n'est pas la fuite que le 404 évite ailleurs
 *
 * La règle « une ressource d'un autre établissement rend 404, jamais 403 »
 * (tenant-isolation §4) protège une chose précise : qu'un salon ne puisse pas
 * apprendre ce que possède le salon voisin. Ici, la ressource est du **même**
 * établissement. Le praticien qui vise le rendez-vous de sa collègue sait déjà
 * qu'il existe — il travaille dans la pièce d'à côté, il voit le fauteuil
 * occupé, il a croisé la cliente. Un 404 ne lui cacherait rien et lui ferait
 * seulement croire à un rendez-vous effacé, ce qui est une mauvaise réponse à
 * une bonne question.
 *
 * Le ticket le tranche mot pour mot : « Le 403 est juste ici, car la ressource
 * est du même établissement. La règle du 404 reste celle des ressources d'un
 * autre établissement. »
 *
 * ## Ce que `details` porte, et ce qu'il ne porte pas
 *
 * La **permission** qui aurait permis le geste — `appointment:write:all`,
 * `customers:read:all`. C'est actionnable : l'écran peut dire « demandez à votre
 * gérante » plutôt que « une erreur est survenue ». Jamais l'identifiant de la
 * ressource, jamais le nom du praticien qui la détient : ce serait rendre par le
 * message ce que le refus vient d'interdire, et la note interne d'une collègue
 * n'a pas à transiter par un corps d'erreur.
 *
 * ## Elle est levée par les services, jamais par une garde
 *
 * Une garde ne consulte aucune ressource, par construction — c'est ce qui rend
 * son 403 indiscernable d'une route à l'autre. Décider « ce rendez-vous est-il
 * le vôtre ? » demande de le lire ; cette décision appartient donc au service,
 * après que la garde a jugé la route.
 */
export class OwnScopeOnlyError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.OWN_SCOPE_ONLY;
  public override readonly status = DOMAIN_HTTP_STATUS.FORBIDDEN;

  public constructor(scope: Permission, details: DomainErrorDetails = {}) {
    super(
      'Cette ressource est hors de votre périmètre : vous n’agissez que sur le vôtre.',
      { scope, ...details },
    );
  }
}

/**
 * Le salon n'a pas d'abonnement en cours — ADR 0016. **402** : le back-office
 * se ferme, sauf l'écran d'abonnement qui permet de le rétablir.
 */
export class SubscriptionRequiredError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.SUBSCRIPTION_REQUIRED;
  public override readonly status = DOMAIN_HTTP_STATUS.PAYMENT_REQUIRED;

  public constructor() {
    super('L’abonnement de ce salon n’est pas actif. Son administrateur peut le rétablir.');
  }
}

/** Le salon n'accepte pas de réservation en ligne — son abonnement est inactif. */
export class SalonBookingClosedError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.SALON_BOOKING_CLOSED;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Ce salon n’accepte pas de réservation en ligne pour le moment.');
  }
}
