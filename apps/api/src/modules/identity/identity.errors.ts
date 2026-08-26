import { DomainError, type DomainErrorDetails } from '../../common/errors';

/**
 * Erreurs du module `identity`.
 *
 * Un service ne lève jamais d'`HttpException` (api-module §5) : il lève une de
 * ces classes, et `DomainExceptionFilter` la traduit. Le front réagit sur `code`,
 * jamais sur `message`.
 *
 * TODO(#26) : ces codes appartiennent au contrat d'API et devront vivre dans
 * `@spa/shared` — le front doit pouvoir brancher son comportement dessus sans les
 * recopier. Le paquet est tenu par #26 en parallèle de ce ticket ; les déclarer
 * ici évite d'écrire dans son empreinte, et l'import se substituera à ces
 * constantes sans changer une seule valeur.
 */

/** Codes d'erreur du module, tels qu'ils partent au client. */
export const IDENTITY_ERROR_CODES = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
} as const;

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
