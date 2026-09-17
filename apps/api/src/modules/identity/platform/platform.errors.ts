import { IDENTITY_ERROR_CODES } from '@spa/shared';

import { DomainError, type DomainErrorDetails } from '../../../common/errors';

/**
 * Erreurs de la console plateforme — #806.
 *
 * ## Les codes viennent du contrat, et de la famille du module
 *
 * `IDENTITY_ERROR_CODES` et non une famille `PLATFORM_ERROR_CODES` propre : la
 * console vit dans le module `identity` (ADR 0012), et `api-error-codes.spec.ts`
 * tient deux règles qui l'imposent — un module ne **déclare** aucun code, et il
 * ne sert que **sa** famille. Une famille de plus aurait rendu ambigu le
 * propriétaire de `TENANT_SLUG_TAKEN`, qui est bien un refus d'identité : c'est
 * l'adresse publique d'un établissement qui est prise.
 */

/** 401 — absent de `DOMAIN_HTTP_STATUS`, qui ne connaît pas l'authentification. */
const UNAUTHORIZED = 401;
const CONFLICT = 409;

/**
 * Connexion d'opérateur refusée.
 *
 * **Un seul message pour quatre causes** — adresse inconnue, mot de passe faux,
 * code MFA faux, compte désactivé. C'est la conduite d'`InvalidCredentialsError`
 * côté établissement, et elle compte davantage ici : l'annuaire des opérateurs
 * de la plateforme est court, et distinguer « cette adresse n'existe pas » de
 * « le code est faux » dirait à qui cherche s'il tient déjà le premier facteur.
 *
 * Aucun `details` n'est jamais renseigné, pour la même raison.
 */
export class InvalidPlatformCredentialsError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.INVALID_PLATFORM_CREDENTIALS;
  public override readonly status = UNAUTHORIZED;

  public constructor() {
    super('Identifiants ou code de vérification invalides.');
  }
}

/**
 * Le slug demandé est déjà pris — critère 3 de #806.
 *
 * 409 et non 422 : ce n'est pas la requête qui est mal formée, c'est l'état du
 * monde qui s'y oppose. `details.slug` rend la valeur en cause, ce qui est sans
 * risque : l'appelant vient de l'écrire, et l'espace des slugs est public par
 * construction — chaque salon publie le sien dans son adresse.
 *
 * Le même code couvre le **nom réservé** (`www`, `api`, `admin`…), et c'est
 * délibéré : du point de vue de l'appelant, les deux disent la même chose — ce
 * nom-là n'est pas disponible. Les distinguer aurait fait de la console un
 * oracle sur la liste des noms que la plateforme se garde.
 */
export class TenantSlugTakenError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.TENANT_SLUG_TAKEN;
  public override readonly status = CONFLICT;

  public constructor(slug: string, details: DomainErrorDetails = {}) {
    super('Ce nom d’adresse est déjà pris ou réservé.', { slug, ...details });
  }
}

/**
 * Réémission demandée sur un établissement sans administrateur.
 *
 * Ne peut arriver qu'à un salon créé avant cette console — par le seed, ou à la
 * main. 409 plutôt que 404 : l'établissement existe, et l'opérateur a le droit
 * de savoir pourquoi la réémission n'aboutit pas. Lui répondre « introuvable »
 * le laisserait chercher un identifiant qu'il vient de lire dans la liste.
 */
export class TenantAdminMissingError extends DomainError {
  public override readonly code = IDENTITY_ERROR_CODES.TENANT_ADMIN_MISSING;
  public override readonly status = CONFLICT;

  public constructor() {
    super('Cet établissement n’a aucun compte administrateur à réinviter.');
  }
}
