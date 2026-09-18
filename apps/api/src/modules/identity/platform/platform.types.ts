import type { TenantBillingStatus } from '@spa/shared';

/**
 * Formes de données de la console plateforme — #806.
 *
 * Aucune ne porte de `tenantId` au sens de la portée : un opérateur n'appartient
 * à aucun établissement (ADR 0012). Là où un identifiant d'établissement
 * apparaît — `ProvisionedTenant.id`, `TenantSummary.id` —, il désigne le salon
 * **que la console vient de nommer**, jamais la portée de l'appelant.
 */

/**
 * Les bornes du mot de passe d'un opérateur, **écrites une seule fois**.
 *
 * Elles vivent ici, dans un fichier sans décorateur ni dépendance, parce que
 * deux surfaces les appliquent : le DTO de connexion (`dto/platform.dto.ts`) et
 * la commande d'exploitation qui pose le mot de passe initial
 * (`platform-operator.cli.ts`), laquelle ne peut pas importer le DTO — ses
 * décorateurs exigent `reflect-metadata`, que la commande ne charge pas. Deux
 * écritures auraient laissé la commande créer un opérateur que la connexion
 * refuse ensuite en 400, sans recours : rien, dans le MVP, ne réinitialise le
 * mot de passe d'un opérateur.
 *
 * Douze caractères au minimum, là où un compte de salon en demande huit : ce
 * mot de passe ouvre tous les salons, et il est le premier des deux facteurs.
 * Le plafond est celui de bcrypt — 72 octets, au-delà desquels l'empreinte
 * ignore silencieusement la fin.
 */
export const PLATFORM_PASSWORD_MIN_LENGTH = 12;
export const PLATFORM_PASSWORD_MAX_LENGTH = 72;

/** L'opérateur, tel qu'une garde le pose sur la requête. Jamais d'empreinte. */
export interface AuthenticatedOperator {
  readonly operatorId: string;
  readonly email: string;
}

/** L'opérateur tel que le dépôt le lit — empreinte et secret compris. */
export interface PlatformOperatorRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly totpSecret: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly isActive: boolean;
}

/** Ce qu'une connexion d'opérateur rend — sans jeton de rafraîchissement. */
export interface PlatformSession {
  readonly accessToken: string;
  /** Secondes — la console n'a pas à décoder le jeton pour savoir quand refaire la MFA. */
  readonly expiresIn: number;
  readonly operator: {
    readonly id: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
  };
}

/** Ce que l'ouverture d'un salon demande. */
export interface ProvisionTenantInput {
  readonly operatorId: string;
  readonly idempotencyKey: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly countryCode: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string;
  readonly adminEmail: string;
  readonly adminFirstName: string;
  readonly adminLastName: string;
}

/** L'établissement et son administrateur, tels que la transaction les a écrits. */
export interface ProvisionedTenantRecord {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly createdAt: Date;
}

/** Une ligne de la liste des établissements — critère 4. */
export interface TenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
  readonly isActive: boolean;
  /** `managed` pour un salon ouvert par la console (ADR 0016). */
  readonly billingStatus: TenantBillingStatus;
  readonly trialEndsAt: Date | null;
  readonly createdAt: Date;
}

/** Une page d'établissements, avec de quoi afficher un sélecteur de page. */
export interface TenantPage {
  readonly items: readonly TenantSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

/**
 * Les trois liens que le critère 2 exige, plus l'invitation qui les accompagne.
 *
 * Le lien d'invitation **porte le jeton** : c'est la même transition assumée que
 * `StaffInvitation` du module `identity` — aucune chaîne d'envoi ne s'adresse
 * encore à un administrateur qui n'existait pas une seconde plus tôt. Il part
 * donc à l'opérateur, qui vient d'ouvrir ce salon et peut de toute façon
 * réémettre l'invitation à volonté.
 */
export interface TenantAccessLinks {
  /** `https://{slug}.{domaine}/reservation` — ce que les clientes utiliseront. */
  readonly bookingUrl: string;
  /** Le lien qui pose le premier mot de passe de l'administrateur. */
  readonly adminInvitationUrl: string;
  /** `https://{slug}.{domaine}/admin/connexion`. */
  readonly adminLoginUrl: string;
  /** Validité du jeton d'invitation, en secondes. */
  readonly invitationExpiresIn: number;
}

/** Ce que rend l'ouverture d'un salon — critère 2. */
export interface ProvisionedTenant {
  readonly tenant: TenantSummary;
  readonly admin: {
    readonly id: string;
    readonly email: string;
    readonly firstName: string;
    readonly lastName: string;
  };
  readonly links: TenantAccessLinks;
  /**
   * `true` quand la réponse est celle d'un **rejeu** : la clé d'idempotence
   * désignait un salon déjà ouvert, et rien n'a été créé. Le dire explicitement
   * évite que la console annonce « établissement créé » deux fois.
   */
  readonly replayed: boolean;
}

/** Ce que rend la réémission de l'invitation de l'administrateur — critère 4. */
export interface ReissuedTenantInvitation {
  readonly tenantId: string;
  readonly admin: {
    readonly id: string;
    readonly email: string;
  };
  readonly links: TenantAccessLinks;
}
