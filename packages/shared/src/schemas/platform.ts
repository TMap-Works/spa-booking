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
import { currencyCodeSchema } from '../common/money';
import { timeZoneSchema, utcInstantSchema } from '../common/time';
import { ADDRESS_LINE_MAX_LENGTH, CITY_MAX_LENGTH, POSTAL_CODE_MAX_LENGTH } from '../constants/limits';
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
      .min(PLATFORM_PASSWORD_MIN_LENGTH, {
        message: `le mot de passe fait au moins ${String(PLATFORM_PASSWORD_MIN_LENGTH)} caractères`,
      })
      .max(PLATFORM_PASSWORD_MAX_LENGTH),
    totpCode: z
      .string()
      .trim()
      .regex(/^\d{6}$/, { message: 'six chiffres, tels que les affiche votre application' }),
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
    countryCode: countryCodeSchema,
    addressLine1: z.string().trim().min(1, { message: 'adresse requise' }).max(ADDRESS_LINE_MAX_LENGTH),
    addressLine2: optionalText(ADDRESS_LINE_MAX_LENGTH),
    postalCode: optionalText(POSTAL_CODE_MAX_LENGTH),
    city: z.string().trim().min(1, { message: 'ville requise' }).max(CITY_MAX_LENGTH),
    adminEmail: emailSchema,
    adminFirstName: nameSchema,
    adminLastName: nameSchema,
  })
  .strict();

export type CreateTenantRequest = z.input<typeof createTenantRequestSchema>;

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
});

export type PlatformTenant = z.infer<typeof platformTenantSchema>;

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
