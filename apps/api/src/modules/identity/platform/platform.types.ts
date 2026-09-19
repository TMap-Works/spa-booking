import type {
  Locale,
  Money,
  PlatformSignupWeek,
  PlatformTenantEventKind,
  PlatformTenantOrigin,
  PlatformTenantState,
  TenantBillingStatus,
} from '@spa/shared';

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
  /** Résolue par le service — jamais facultative ici (#844). Voir `SelfServiceTenantInput`. */
  readonly defaultLocale: Locale;
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
  /** Ouvert depuis la console, ou inscrit en libre-service (ADR 0016). */
  readonly origin: PlatformTenantOrigin;
}

/**
 * Les filtres de la liste — tous facultatifs, combinés en « et ».
 *
 * `q` cherche dans le nom, l'adresse (slug), l'e-mail de contact du salon et
 * l'e-mail de ses gérants et administrateurs : c'est ce qu'un opérateur a sous
 * la main quand un salon l'appelle.
 */
export interface TenantListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly q?: string;
  readonly billingStatus?: TenantBillingStatus;
  readonly state?: PlatformTenantState;
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

// ---------------------------------------------------------------------------
// Le tableau de bord et la fiche salon
// ---------------------------------------------------------------------------

/** Une ligne de l'historique d'un salon — note, geste, ou ouverture. */
export interface TenantEventRecord {
  readonly id: string;
  readonly kind: PlatformTenantEventKind;
  readonly body: string | null;
  /** « Prénom N. » — l'opérateur, jamais son adresse. */
  readonly operatorName: string | null;
  readonly createdAt: Date;
}

/** Ce que la base compte pour la vue d'ensemble — la matière brute du service. */
export interface OverviewCounts {
  readonly total: number;
  readonly suspended: number;
  readonly byBillingStatus: Readonly<Record<TenantBillingStatus, number>>;
  readonly trialsEndingSoon: readonly TenantSummary[];
  /** Les salons ouverts depuis le début de la fenêtre, avec leur origine. */
  readonly recentOpenings: readonly { createdAt: Date; origin: PlatformTenantOrigin }[];
  readonly activation: {
    readonly opened: number;
    readonly configured: number;
    readonly booked: number;
    readonly activeLast30Days: number;
  };
  readonly recent: readonly TenantSummary[];
}

/** La fiche d'un salon telle que la base la rend, avant mise en forme. */
export interface TenantDetailRecord {
  readonly summary: TenantSummary;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly address: {
    readonly line1: string;
    readonly line2: string | null;
    readonly postalCode: string | null;
    readonly city: string;
    readonly country: string;
  } | null;
  readonly legalName: string | null;
  readonly hasLegalId: boolean;
  readonly currentPeriodEndsAt: Date | null;
  readonly stripeCustomerId: string | null;
}

/** Un compte interne du salon — jamais une cliente, jamais une empreinte. */
export interface TenantAccountRecord {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly role: 'staff' | 'manager' | 'admin';
  readonly isActive: boolean;
  readonly activated: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

/** Où en est la mise en route d'un salon. */
export interface TenantSetupRecord {
  readonly openingHours: boolean;
  readonly activeServices: number;
  readonly activeStaff: number;
  readonly staffWithSchedule: number;
  readonly firstAppointmentAt: Date | null;
}

/** Trente jours d'activité, en nombres. */
export interface TenantActivityRecord {
  readonly createdLast30Days: number;
  readonly upcoming: number;
  readonly completedLast30Days: number;
  readonly noShowLast30Days: number;
  readonly cancelledLast30Days: number;
  readonly lastBookingAt: Date | null;
}

/** La vue d'ensemble, telle que le service la compose. */
export interface PlatformOverviewView {
  readonly generatedAt: Date;
  readonly tenants: {
    readonly total: number;
    readonly suspended: number;
    readonly byBillingStatus: Readonly<Record<TenantBillingStatus, number>>;
  };
  readonly revenue: {
    readonly monthlyRecurring: Money;
    readonly atRisk: Money;
    readonly inTrial: Money;
  };
  readonly trialsEndingSoon: readonly TenantSummary[];
  readonly signupsByWeek: readonly PlatformSignupWeek[];
  readonly activation: OverviewCounts['activation'];
  readonly recent: readonly TenantSummary[];
}

/** La fiche d'un salon, telle que le service la compose. */
export interface TenantDetailView {
  readonly record: TenantDetailRecord;
  readonly links: { readonly bookingUrl: string; readonly adminLoginUrl: string };
  readonly accounts: readonly TenantAccountRecord[];
  readonly clientCount: number;
  readonly setup: TenantSetupRecord & {
    readonly adminActivated: boolean;
    readonly address: boolean;
    readonly legalIdentity: boolean;
  };
  readonly activity: TenantActivityRecord;
  readonly events: readonly TenantEventRecord[];
}
