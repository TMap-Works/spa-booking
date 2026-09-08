import { IDENTITY_ERROR_CODES } from '@spa/shared';

import { DomainError, type DomainErrorDetails } from '../../common/errors';

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
