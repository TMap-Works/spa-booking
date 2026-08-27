/**
 * Codes d'erreur de l'API — l'énumération sur laquelle le front branche son
 * comportement.
 *
 * Le contrat de sortie est unique pour toute l'API (api-module §5) :
 *
 * ```json
 * { "code": "SLOT_NO_LONGER_AVAILABLE", "message": "…", "details": {} }
 * ```
 *
 * **Le front réagit sur `code`, jamais sur `message`** : le message est
 * traduisible, réécrit, expurgé par le filtre d'exception, et peut changer sans
 * préavis. Le code, lui, est un contrat : retirer ou renommer une valeur de ce
 * fichier casse un front déployé.
 *
 * Ce que ce fichier n'est **pas** : une table de correspondance vers des statuts
 * HTTP. Le statut est décidé par le serveur et lu sur la réponse ; le dupliquer
 * ici créerait une seconde source de vérité qui divergerait au premier code
 * ajouté.
 */

/**
 * Codes émis par l'infrastructure HTTP — `ValidationPipe`, route absente,
 * garde d'authentification, plafond de débit. Ils ne portent aucune sémantique
 * métier.
 */
export const TRANSPORT_ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  NOT_ACCEPTABLE: 'NOT_ACCEPTABLE',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Corps de requête refusé par la validation ; `details.violations` liste les champs. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

/**
 * Codes de domaine transverses, levés par n'importe quel module.
 *
 * `NOT_FOUND` couvre aussi la ressource **d'un autre tenant** : un 403 y
 * confirmerait son existence, ce qui est une fuite d'information
 * (tenant-isolation §4). Le front ne doit donc jamais interpréter un
 * `NOT_FOUND` comme « cet identifiant n'existe nulle part ».
 */
export const DOMAIN_ERROR_CODES = {
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
} as const;

/** Authentification et autorisation — #21, #22. */
export const IDENTITY_ERROR_CODES = {
  /** Couple e-mail / mot de passe refusé. Ne distingue **jamais** lequel des deux est faux. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Inscription sur une adresse déjà prise **dans ce tenant**. */
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  /** Jeton d'accès expiré — le front tente un rafraîchissement avant d'abandonner. */
  ACCESS_TOKEN_EXPIRED: 'ACCESS_TOKEN_EXPIRED',
  /** Jeton illisible, mal signé, ou dont les claims ne correspondent pas. */
  INVALID_TOKEN: 'INVALID_TOKEN',
  /** Refresh token révoqué par une déconnexion — le front repasse par la connexion. */
  REFRESH_TOKEN_REVOKED: 'REFRESH_TOKEN_REVOKED',
  /** Compte désactivé par l'établissement. */
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  /** Rôle insuffisant pour l'endpoint demandé, sur une ressource déjà établie. */
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  /** Établissement introuvable ou inactif — slug inconnu, tenant fermé. */
  TENANT_UNAVAILABLE: 'TENANT_UNAVAILABLE',
} as const;

/** Disponibilité et rendez-vous — le cœur de la boucle de valeur. */
export const BOOKING_ERROR_CODES = {
  /**
   * Le créneau a été pris entre l'affichage et la validation. **409**, jamais
   * 500 : le front réaffiche les créneaux et invite à en choisir un autre
   * (booking-engine §1).
   */
  SLOT_NO_LONGER_AVAILABLE: 'SLOT_NO_LONGER_AVAILABLE',
  /** Créneau hors des fenêtres de travail du praticien, ou jour de fermeture. */
  SLOT_OUTSIDE_WORKING_HOURS: 'SLOT_OUTSIDE_WORKING_HOURS',
  /** Réservation trop proche de l'instant présent, ou dans le passé. */
  BOOKING_TOO_LATE: 'BOOKING_TOO_LATE',
  /** Le praticien demandé ne pratique pas cette prestation. */
  STAFF_NOT_ELIGIBLE_FOR_SERVICE: 'STAFF_NOT_ELIGIBLE_FOR_SERVICE',
  /** Annulation demandée hors du délai consenti par l'établissement. */
  CANCELLATION_WINDOW_CLOSED: 'CANCELLATION_WINDOW_CLOSED',
  /** Plage de disponibilité trop large — voir `MAX_AVAILABILITY_RANGE_DAYS`. */
  AVAILABILITY_RANGE_TOO_WIDE: 'AVAILABILITY_RANGE_TOO_WIDE',
  /**
   * Plage bloquée ou congé dont les bornes ne tiennent pas : fin avant début,
   * ou fenêtre au-delà de `MAX_TIME_OFF_RANGE_DAYS` (#33). **422**.
   *
   * Un seul code pour les deux refus, `details.rule` les distingue
   * (`ends_before_starts` / `range_too_wide`) : le front affiche le même
   * message sur le même champ, et un second code lui aurait fait écrire deux
   * branches pour une seule correction à faire par l'utilisateur.
   */
  TIME_OFF_RANGE_INVALID: 'TIME_OFF_RANGE_INVALID',
} as const;

/** Encaissement — payments-stripe. */
export const PAYMENT_ERROR_CODES = {
  /** Second encaissement demandé sur un rendez-vous déjà réglé. */
  PAYMENT_ALREADY_CAPTURED: 'PAYMENT_ALREADY_CAPTURED',
  /** Remboursement supérieur au montant encaissé restant. */
  REFUND_EXCEEDS_CAPTURED_AMOUNT: 'REFUND_EXCEEDS_CAPTURED_AMOUNT',
  /** Devise du paiement différente de celle du montant dû — jamais convertie en silence. */
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  /** Refus ou incident côté prestataire. `details` ne contient aucune donnée de carte. */
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
} as const;

/**
 * L'ensemble des codes stables du contrat, tous domaines confondus.
 *
 * L'objet est figé à l'exécution : un module qui écrirait dedans changerait le
 * contrat pour tout le processus.
 */
export const ERROR_CODES = Object.freeze({
  ...TRANSPORT_ERROR_CODES,
  ...DOMAIN_ERROR_CODES,
  ...IDENTITY_ERROR_CODES,
  ...BOOKING_ERROR_CODES,
  ...PAYMENT_ERROR_CODES,
});

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

/**
 * `true` si `value` est l'un des codes stables ci-dessus.
 *
 * Un corps d'erreur peut porter un code **inconnu** de cette liste : le filtre
 * d'exception retombe sur `HTTP_<statut>` pour un statut qu'il ne sait pas
 * nommer. Le front traite ce cas comme une erreur générique — d'où ce garde,
 * plutôt qu'un transtypage optimiste.
 */
export function isKnownErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value);
}
