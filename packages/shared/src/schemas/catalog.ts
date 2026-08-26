/**
 * Catalog — prestations, catégories, praticiens et leurs affectations.
 *
 * Le prix est exposé comme un **objet `Money`** (`{ amountMinor, currency }`) et
 * non comme les deux colonnes plates du schéma Prisma
 * (`price_amount_minor`, `price_currency`). Ce n'est pas une coquetterie : deux
 * champs indépendants dans un DTO peuvent être mis à jour séparément, et il
 * existe alors un instant où le montant est celui de l'ancienne devise. Le
 * couple est indissociable, le type le dit. La mise à plat vers les colonnes est
 * la responsabilité du repository (api-module §2).
 */

import { z } from 'zod';

import {
  displayNameSchema,
  longTextSchema,
  nameSchema,
  slugSchema,
  uuidSchema,
} from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import { durationMinutesSchema } from '../common/time';

/** Prestation vendue par l'établissement. */
export const serviceSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: displayNameSchema,
  description: longTextSchema.optional(),
  category: nameSchema.optional(),
  /** Durée facturée du soin. Les tampons avant/après relèvent du moteur de disponibilité. */
  durationMinutes: durationMinutesSchema,
  /** Prix affiché. Un soin offert vaut zéro ; il n'a jamais un prix négatif. */
  price: nonNegativeMoneySchema,
  isActive: z.boolean(),
});

export type Service = z.infer<typeof serviceSchema>;

/** Forme réduite, telle qu'imbriquée dans un rendez-vous ou un créneau. */
export const serviceSummarySchema = serviceSchema.pick({
  id: true,
  name: true,
  durationMinutes: true,
  price: true,
});

export type ServiceSummary = z.infer<typeof serviceSummarySchema>;

/**
 * Création d'une prestation.
 *
 * `slug` est optionnel : le serveur le dérive du nom quand il n'est pas fourni.
 * Le laisser saisissable reste utile pour préserver l'URL publique d'une
 * prestation qu'on renomme.
 */
export const createServiceRequestSchema = z
  .object({
    name: displayNameSchema,
    slug: slugSchema.optional(),
    description: longTextSchema.optional(),
    category: nameSchema.optional(),
    durationMinutes: durationMinutesSchema,
    price: nonNegativeMoneySchema,
    staffIds: z.array(uuidSchema).optional(),
  })
  .strict();

export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

/**
 * Modification d'une prestation — tous les champs optionnels.
 *
 * `isActive` s'y ajoute : c'est **ainsi** qu'une prestation sort du catalogue.
 * Il n'y a pas de suppression, parce que les rendez-vous passés la référencent
 * et que le reporting doit continuer à savoir ce qui a été vendu.
 */
export const updateServiceRequestSchema = createServiceRequestSchema
  .extend({ isActive: z.boolean() })
  .partial();

export type UpdateServiceRequest = z.infer<typeof updateServiceRequestSchema>;

/**
 * Fiche praticien — la vitrine publique, distincte du compte qui porte
 * l'identité et les droits.
 *
 * `userId` n'est **pas** exposé : la page de réservation publique affiche cette
 * fiche, et rien n'y justifie de révéler le compte qui la sous-tend.
 */
export const staffMemberSchema = z.object({
  id: uuidSchema,
  displayName: displayNameSchema,
  bio: longTextSchema.optional(),
  isActive: z.boolean(),
});

export type StaffMember = z.infer<typeof staffMemberSchema>;

export const staffMemberSummarySchema = staffMemberSchema.pick({
  id: true,
  displayName: true,
});

export type StaffMemberSummary = z.infer<typeof staffMemberSummarySchema>;

/** Création d'une fiche praticien, rattachée à un compte existant. */
export const createStaffMemberRequestSchema = z
  .object({
    userId: uuidSchema,
    displayName: displayNameSchema,
    bio: longTextSchema.optional(),
    serviceIds: z.array(uuidSchema).optional(),
  })
  .strict();

export type CreateStaffMemberRequest = z.infer<typeof createStaffMemberRequestSchema>;

export const updateStaffMemberRequestSchema = createStaffMemberRequestSchema
  .omit({ userId: true })
  .extend({ isActive: z.boolean() })
  .partial();

export type UpdateStaffMemberRequest = z.infer<typeof updateStaffMemberRequestSchema>;

/**
 * Remplace l'affectation « ce praticien pratique ces prestations ».
 *
 * L'opération est un **remplacement** et non un ajout : le corps porte l'état
 * voulu au complet. Un `PATCH` incrémental sur une collection oblige à inventer
 * un verbe de retrait et rend l'écran de back-office non idempotent.
 */
export const setStaffServicesRequestSchema = z
  .object({
    serviceIds: z.array(uuidSchema),
  })
  .strict();

export type SetStaffServicesRequest = z.infer<typeof setStaffServicesRequestSchema>;
