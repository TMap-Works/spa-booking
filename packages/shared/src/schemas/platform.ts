/**
 * Contrats de la console de l'éditeur — l'espace plateforme (ADR 0012, #806).
 *
 * L'API les porte en `class-validator` (`identity/platform/dto/platform.dto.ts`) ;
 * ils sont écrits ici pour que la console web valide avec la **même** règle et
 * lise les réponses sans redéclarer leurs formes (web-frontend §2).
 *
 * Aucun de ces schémas ne porte de `tenantId` au sens d'une portée : l'opérateur
 * est au-dessus des établissements, et l'identifiant d'un salon n'y est jamais
 * qu'une ressource nommée.
 */

import { z } from 'zod';

import {
  countryCodeSchema,
  displayNameSchema,
  emailSchema,
  nameSchema,
  opaqueTokenSchema,
  slugSchema,
  uuidSchema,
} from '../common/identifiers';
import { currencyCodeSchema, nonNegativeMoneySchema } from '../common/money';
import { calendarDateSchema, timeZoneSchema, utcInstantSchema } from '../common/time';
import { ADDRESS_LINE_MAX_LENGTH, CITY_MAX_LENGTH, POSTAL_CODE_MAX_LENGTH } from '../constants/limits';
import { messageKey } from '../errors/zod-messages';
import { localeSchema, submittedLocaleSchema } from '../locale/index';
import { tenantBillingStatusSchema } from './billing';

/** Bornes du mot de passe d'un opérateur — `PLATFORM_PASSWORD_*` côté API. */
export const PLATFORM_PASSWORD_MIN_LENGTH = 12;
export const PLATFORM_PASSWORD_MAX_LENGTH = 72;

/** Connexion d'un opérateur : mot de passe **et** code TOTP, jamais l'un sans l'autre. */
export const platformLoginRequestSchema = z
  .object({
    email: emailSchema,
    password: z
      .string()
      .min(PLATFORM_PASSWORD_MIN_LENGTH)
      .max(PLATFORM_PASSWORD_MAX_LENGTH),
    totpCode: z
      .string()
      .trim()
      .refine((value) => /^\d{6}$/.test(value), messageKey('platform.totpCode')),
  })
  .strict();

export type PlatformLoginRequest = z.infer<typeof platformLoginRequestSchema>;

export const platformOperatorSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string(),
});

export type PlatformOperator = z.infer<typeof platformOperatorSchema>;

/** Une session de console : trente minutes, sans renouvellement (ADR 0012 §3). */
export const platformSessionSchema = z.object({
  accessToken: opaqueTokenSchema,
  expiresIn: z.number().int().positive(),
  operator: platformOperatorSchema,
});

export type PlatformSession = z.infer<typeof platformSessionSchema>;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : value));

/** Ouvrir un établissement et inviter son administrateur — `POST /platform/tenants`. */
export const createTenantRequestSchema = z
  .object({
    slug: slugSchema,
    name: displayNameSchema,
    timezone: timeZoneSchema,
    defaultCurrency: currencyCodeSchema,
    /**
     * La langue dans laquelle le salon s'ouvre — **facultative**, `en` sinon
     * (#844, troisième critère d'acceptation).
     *
     * Facultative parce que c'est un défaut du système et non une question à
     * poser : la clientèle du produit est nord-américaine (décision du PO du
     * 2026-09-19), et un formulaire d'ouverture qui exigerait de choisir sa
     * langue ajouterait un champ obligatoire à la seule étape qu'on veut courte.
     * Le salon qui parle français le dit ici, ou le changera dans ses réglages.
     *
     * Le défaut est posé **côté serveur**, jamais par ce schéma : un `.default()`
     * ici l'aurait aussi appliqué dans le navigateur de la console, et deux
     * endroits auraient eu un avis sur la langue d'un salon.
     *
     * Ce champ vaut aussi pour l'inscription libre-service (ADR 0016), qui étend
     * ce schéma (`salonSignupRequestSchema`) : les deux portes d'ouverture d'un
     * établissement doivent accepter la même chose.
     */
    defaultLocale: submittedLocaleSchema.optional(),
    countryCode: countryCodeSchema,
    addressLine1: z.string().trim().min(1).max(ADDRESS_LINE_MAX_LENGTH),
    addressLine2: optionalText(ADDRESS_LINE_MAX_LENGTH),
    postalCode: optionalText(POSTAL_CODE_MAX_LENGTH),
    city: z.string().trim().min(1).max(CITY_MAX_LENGTH),
    adminEmail: emailSchema,
    adminFirstName: nameSchema,
    adminLastName: nameSchema,
  })
  .strict();

export type CreateTenantRequest = z.input<typeof createTenantRequestSchema>;

/**
 * D'où vient un salon — déduit, aucune colonne ne le stocke :
 *
 * - `console` : une ligne `platform_tenant_provisionings` le désigne ;
 * - `signup` : inscrit en libre-service (ADR 0016) — il est né `pending`, et
 *   n'est donc jamais `managed` ;
 * - `legacy` : ni l'un ni l'autre — un salon `managed` sans ligne d'ouverture,
 *   créé avant la console par le seed, un jeu d'essai ou à la main.
 */
export const PLATFORM_TENANT_ORIGINS = ['console', 'signup', 'legacy'] as const;

export const platformTenantOriginSchema = z.enum(PLATFORM_TENANT_ORIGINS);

export type PlatformTenantOrigin = z.infer<typeof platformTenantOriginSchema>;

/** Un établissement, tel que la console le liste. */
export const platformTenantSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  timezone: z.string(),
  defaultCurrency: z.string(),
  isActive: z.boolean(),
  /** Où en est sa facturation — `managed` pour un salon ouvert ici (ADR 0016). */
  billingStatus: tenantBillingStatusSchema,
  trialEndsAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
  origin: platformTenantOriginSchema,
});

export type PlatformTenant = z.infer<typeof platformTenantSchema>;

/**
 * Les deux états d'exploitation d'un salon, tels que la liste les filtre :
 * ouvert, ou suspendu par l'éditeur (`tenants.is_active`).
 */
export const PLATFORM_TENANT_STATES = ['active', 'suspended'] as const;

export const platformTenantStateSchema = z.enum(PLATFORM_TENANT_STATES);

export type PlatformTenantState = z.infer<typeof platformTenantStateSchema>;

/** Le terme de recherche de la liste — nom, adresse, e-mail de contact ou d'un gérant. */
export const PLATFORM_TENANT_SEARCH_MAX_LENGTH = 120;

/**
 * Ce que la liste des salons accepte en filtre — `GET /platform/tenants`.
 *
 * Tous facultatifs, et combinés en « et » : « les essais suspendus dont le nom
 * contient lotus ».
 */
export const platformTenantListQuerySchema = z
  .object({
    q: z.string().trim().max(PLATFORM_TENANT_SEARCH_MAX_LENGTH).optional(),
    billingStatus: tenantBillingStatusSchema.optional(),
    state: platformTenantStateSchema.optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type PlatformTenantListQuery = z.infer<typeof platformTenantListQuerySchema>;

export const platformTenantPageSchema = z.object({
  items: z.array(platformTenantSchema),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

export type PlatformTenantPage = z.infer<typeof platformTenantPageSchema>;

/**
 * Les liens que l'éditeur remet au gérant.
 *
 * `adminInvitationUrl` porte le jeton d'invitation : il s'affiche à l'opérateur,
 * et ne se journalise nulle part.
 */
export const tenantAccessLinksSchema = z.object({
  bookingUrl: z.string().url(),
  adminInvitationUrl: z.string().url(),
  adminLoginUrl: z.string().url(),
  invitationExpiresIn: z.number().int().positive(),
});

export type TenantAccessLinks = z.infer<typeof tenantAccessLinksSchema>;

export const provisionedTenantSchema = z.object({
  tenant: platformTenantSchema,
  admin: z.object({
    id: uuidSchema,
    email: z.string(),
    firstName: z.string(),
    lastName: z.string(),
  }),
  links: tenantAccessLinksSchema,
  /** `true` : la clé d'idempotence désignait un salon déjà ouvert, rien n'a été créé. */
  replayed: z.boolean(),
});

export type ProvisionedTenant = z.infer<typeof provisionedTenantSchema>;

export const reissuedTenantInvitationSchema = z.object({
  tenantId: uuidSchema,
  admin: z.object({ id: uuidSchema, email: z.string() }),
  links: tenantAccessLinksSchema,
});

export type ReissuedTenantInvitation = z.infer<typeof reissuedTenantInvitationSchema>;

// ---------------------------------------------------------------------------
// Le tableau de bord de l'éditeur
// ---------------------------------------------------------------------------

/** Une semaine d'ouvertures de salons, par origine. `weekStart` est un lundi, en UTC. */
export const platformSignupWeekSchema = z.object({
  weekStart: calendarDateSchema,
  console: z.number().int().min(0),
  signup: z.number().int().min(0),
});

export type PlatformSignupWeek = z.infer<typeof platformSignupWeekSchema>;

/**
 * La vue d'ensemble de la plateforme — `GET /platform/overview`.
 *
 * ## Des agrégats, jamais une donnée de salon
 *
 * L'éditeur est sous-traitant des salons (registre des traitements) : ce qu'il
 * lit ici se compte, rien ne s'y nomme au-delà du salon lui-même. Ni cliente,
 * ni montant encaissé par un salon — le revenu affiché est **celui de
 * l'éditeur**, les abonnements (ADR 0016).
 *
 * ## Le revenu récurrent est une estimation, et le nom le dit
 *
 * `monthlyRecurring` compte les salons `active` au tarif unique de l'offre
 * (`SUBSCRIPTION_PLAN`). C'est exact tant qu'il n'y a qu'une offre et aucune
 * remise ; le jour où Stripe portera des coupons, le chiffre juste se lira
 * chez Stripe.
 */
export const platformOverviewSchema = z.object({
  generatedAt: utcInstantSchema,
  tenants: z.object({
    total: z.number().int().min(0),
    suspended: z.number().int().min(0),
    byBillingStatus: z.object({
      managed: z.number().int().min(0),
      pending: z.number().int().min(0),
      trialing: z.number().int().min(0),
      active: z.number().int().min(0),
      past_due: z.number().int().min(0),
      canceled: z.number().int().min(0),
    }),
  }),
  revenue: z.object({
    /** Salons abonnés × tarif mensuel. */
    monthlyRecurring: nonNegativeMoneySchema,
    /** Salons en impayé × tarif mensuel — le revenu qui peut être perdu. */
    atRisk: nonNegativeMoneySchema,
    /** Salons en essai × tarif mensuel — le revenu à convertir. */
    inTrial: nonNegativeMoneySchema,
  }),
  /** Les essais qui se terminent dans les sept jours, le plus proche d'abord. */
  trialsEndingSoon: z.array(platformTenantSchema),
  /** Douze semaines d'ouvertures, la plus ancienne d'abord. */
  signupsByWeek: z.array(platformSignupWeekSchema),
  /**
   * L'entonnoir d'activation : combien de salons ouverts ont un catalogue et un
   * praticien, combien ont reçu au moins un rendez-vous, combien en ont reçu un
   * dans les trente derniers jours.
   */
  activation: z.object({
    opened: z.number().int().min(0),
    configured: z.number().int().min(0),
    booked: z.number().int().min(0),
    activeLast30Days: z.number().int().min(0),
  }),
  /** Les cinq derniers salons ouverts. */
  recent: z.array(platformTenantSchema),
});

export type PlatformOverview = z.infer<typeof platformOverviewSchema>;

// ---------------------------------------------------------------------------
// La fiche d'un salon
// ---------------------------------------------------------------------------

/** Ce que l'historique d'un salon porte. `provisioned` vient du journal d'ouverture. */
export const PLATFORM_TENANT_EVENT_KINDS = [
  'provisioned',
  'note',
  'suspended',
  'reactivated',
  'invitation_reissued',
] as const;

export const platformTenantEventKindSchema = z.enum(PLATFORM_TENANT_EVENT_KINDS);

export type PlatformTenantEventKind = z.infer<typeof platformTenantEventKindSchema>;

export const platformTenantEventSchema = z.object({
  id: z.string().min(1),
  kind: platformTenantEventKindSchema,
  /** Le texte d'une note, ou le motif d'une suspension. */
  body: z.string().nullable(),
  /** « Prénom N. » de l'opérateur. */
  operatorName: z.string().nullable(),
  createdAt: utcInstantSchema,
});

export type PlatformTenantEvent = z.infer<typeof platformTenantEventSchema>;

/** Les rôles internes d'un salon, tels que la fiche les affiche. */
export const PLATFORM_ACCOUNT_ROLES = ['staff', 'manager', 'admin'] as const;

/**
 * Un compte **interne** du salon — gérant, praticien. Jamais une cliente :
 * leurs comptes ne se comptent qu'en nombre (`clientCount`).
 */
export const platformTenantAccountSchema = z.object({
  id: uuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  role: z.enum(PLATFORM_ACCOUNT_ROLES),
  isActive: z.boolean(),
  /** Le mot de passe a été posé : l'invitation a été acceptée. */
  activated: z.boolean(),
  lastLoginAt: utcInstantSchema.nullable(),
  createdAt: utcInstantSchema,
});

export type PlatformTenantAccount = z.infer<typeof platformTenantAccountSchema>;

/**
 * Où en est la mise en route d'un salon — ce qu'il faut pour que la vitrine
 * prenne des rendez-vous.
 */
export const platformTenantSetupSchema = z.object({
  adminActivated: z.boolean(),
  address: z.boolean(),
  legalIdentity: z.boolean(),
  openingHours: z.boolean(),
  activeServices: z.number().int().min(0),
  activeStaff: z.number().int().min(0),
  staffWithSchedule: z.number().int().min(0),
  firstAppointmentAt: utcInstantSchema.nullable(),
});

export type PlatformTenantSetup = z.infer<typeof platformTenantSetupSchema>;

/** L'activité d'un salon sur trente jours — des comptes, jamais un rendez-vous. */
export const platformTenantActivitySchema = z.object({
  createdLast30Days: z.number().int().min(0),
  upcoming: z.number().int().min(0),
  completedLast30Days: z.number().int().min(0),
  noShowLast30Days: z.number().int().min(0),
  cancelledLast30Days: z.number().int().min(0),
  lastBookingAt: utcInstantSchema.nullable(),
});

export type PlatformTenantActivity = z.infer<typeof platformTenantActivitySchema>;

/** La fiche d'un salon — `GET /platform/tenants/:id`. */
export const platformTenantDetailSchema = z.object({
  tenant: platformTenantSchema,
  contact: z.object({
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  address: z
    .object({
      line1: z.string(),
      line2: z.string().nullable(),
      postalCode: z.string().nullable(),
      city: z.string(),
      country: z.string(),
    })
    .nullable(),
  legalName: z.string().nullable(),
  /**
   * La langue du salon (#844) — celle qu'on lui a donnée en l'ouvrant, et dans
   * laquelle sa vitrine et ses e-mails s'écrivent.
   *
   * Portée par la **fiche** et non par `platformTenantSchema` : la liste et la
   * vue d'ensemble n'en affichent aucune, et l'y mettre aurait chargé chaque
   * ligne d'une page de cent salons d'une colonne que personne ne lit.
   *
   * Toujours rendue, y compris pour un salon **suspendu** : c'est une donnée que
   * la console lit par son propre contrat, et non sur la vitrine du salon — qui,
   * elle, ne répond plus dès qu'il est suspendu (#1189).
   */
  defaultLocale: localeSchema,
  billing: z.object({
    status: tenantBillingStatusSchema,
    trialEndsAt: utcInstantSchema.nullable(),
    currentPeriodEndsAt: utcInstantSchema.nullable(),
    stripeCustomerId: z.string().nullable(),
  }),
  links: z.object({
    bookingUrl: z.string().url(),
    adminLoginUrl: z.string().url(),
  }),
  accounts: z.array(platformTenantAccountSchema),
  clientCount: z.number().int().min(0),
  setup: platformTenantSetupSchema,
  activity: platformTenantActivitySchema,
  /** Le plus récent d'abord ; l'ouverture depuis la console en dernier. */
  events: z.array(platformTenantEventSchema),
});

export type PlatformTenantDetail = z.infer<typeof platformTenantDetailSchema>;

/** Une note interne — `POST /platform/tenants/:id/notes`. */
export const PLATFORM_NOTE_MAX_LENGTH = 2000;

export const createPlatformNoteRequestSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(PLATFORM_NOTE_MAX_LENGTH),
  })
  .strict();

export type CreatePlatformNoteRequest = z.infer<typeof createPlatformNoteRequestSchema>;

/**
 * Suspendre ou réactiver un salon — `PUT /platform/tenants/:id/status`.
 *
 * Le motif est **obligatoire** dans les deux sens : c'est lui que l'historique
 * garde, et une suspension sans motif est une question que le suivant posera.
 */
export const PLATFORM_STATUS_REASON_MIN_LENGTH = 3;
export const PLATFORM_STATUS_REASON_MAX_LENGTH = 500;

export const updateTenantStatusRequestSchema = z
  .object({
    isActive: z.boolean(),
    reason: z
      .string()
      .trim()
      .min(PLATFORM_STATUS_REASON_MIN_LENGTH)
      .max(PLATFORM_STATUS_REASON_MAX_LENGTH),
  })
  .strict();

export type UpdateTenantStatusRequest = z.infer<typeof updateTenantStatusRequestSchema>;
