/**
 * Erreurs de domaine.
 *
 * Un service ne lève **jamais** une `HttpException` (api-module §5) : il lève
 * une erreur de domaine, que `DomainExceptionFilter` traduit en HTTP. C'est ce
 * qui rend les services testables sans HTTP, et ce qui garantit un corps
 * d'erreur unique pour toute l'API.
 *
 * Le contrat de sortie est stable et documenté :
 *
 * ```json
 * { "code": "NOT_FOUND", "message": "…", "details": {} }
 * ```
 *
 * Le front réagit sur `code`, jamais sur `message` — le message est traduisible
 * et peut changer sans préavis.
 */

/** Codes HTTP utilisés par la table de correspondance d'api-module §5. */
export const DOMAIN_HTTP_STATUS = {
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
} as const;

export type DomainErrorDetails = Readonly<Record<string, unknown>>;

/**
 * Racine des erreurs métier. Chaque sous-classe fige son `code` — la valeur sur
 * laquelle le front branche son comportement — et son `status` HTTP.
 *
 * `details` complète le message par des données **non personnelles** : un
 * identifiant de ressource, un nom de champ, une transition refusée. Jamais un
 * nom de client, un e-mail ou un secret : le filtre les expurgerait, mais la
 * bonne place pour cette donnée est le log, pas la réponse.
 */
export abstract class DomainError extends Error {
  public abstract readonly code: string;
  public abstract readonly status: number;

  public readonly details: DomainErrorDetails;

  protected constructor(message: string, details: DomainErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    // Retire le constructeur de la pile : elle doit pointer le site d'appel.
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Ressource inexistante — ou existante mais hors du tenant courant. */
export class NotFoundError extends DomainError {
  public override readonly code = 'NOT_FOUND';
  public override readonly status = DOMAIN_HTTP_STATUS.NOT_FOUND;

  public constructor(message = 'Ressource introuvable.', details: DomainErrorDetails = {}) {
    super(message, details);
  }
}

/**
 * Droits insuffisants sur une ressource dont l'existence est déjà établie.
 *
 * À ne pas confondre avec une ressource appartenant à un autre tenant : celle-ci
 * doit répondre `NotFoundError`, car un 403 confirmerait son existence
 * (tenant-isolation — un 403 est une fuite d'information).
 */
export class ForbiddenError extends DomainError {
  public override readonly code = 'FORBIDDEN';
  public override readonly status = DOMAIN_HTTP_STATUS.FORBIDDEN;

  public constructor(message = 'Droits insuffisants.', details: DomainErrorDetails = {}) {
    super(message, details);
  }
}

/**
 * L'état du monde a changé sous la requête : la ressource est déjà prise, déjà
 * créée, déjà modifiée. Les erreurs de concurrence du moteur de réservation
 * (créneau attribué entre-temps) en dériveront.
 */
export class ConflictError extends DomainError {
  public override readonly code = 'CONFLICT';
  public override readonly status = DOMAIN_HTTP_STATUS.CONFLICT;

  public constructor(message = 'Conflit avec l’état courant de la ressource.', details: DomainErrorDetails = {}) {
    super(message, details);
  }
}

/** Règle métier violée par une requête pourtant bien formée. */
export class BusinessRuleError extends DomainError {
  public override readonly code = 'BUSINESS_RULE_VIOLATION';
  public override readonly status = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

  public constructor(message: string, details: DomainErrorDetails = {}) {
    super(message, details);
  }
}

/** Transition de statut interdite par le cycle de vie de l'entité. */
export class InvalidStateTransitionError extends DomainError {
  public override readonly code = 'INVALID_STATE_TRANSITION';
  public override readonly status = DOMAIN_HTTP_STATUS.UNPROCESSABLE_ENTITY;

  public constructor(from: string, to: string, details: DomainErrorDetails = {}) {
    super(`Transition « ${from} » → « ${to} » interdite.`, { from, to, ...details });
  }
}
