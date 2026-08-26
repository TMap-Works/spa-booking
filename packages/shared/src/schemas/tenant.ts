/**
 * Établissement — la racine de l'isolation.
 *
 * Le seul objet du contrat dont l'identifiant de tenant est exposé, pour une
 * raison simple : il *est* le tenant. Partout ailleurs, `tenantId` est absent
 * des schémas — il est résolu côté serveur depuis la requête et ne doit ni
 * entrer (un client qui le pose choisit son établissement) ni sortir (le
 * renvoyer confirme l'existence d'une frontière qu'on n'a pas à documenter au
 * cas par cas).
 */

import { z } from 'zod';

import { displayNameSchema, emailSchema, phoneSchema, slugSchema, uuidSchema } from '../common/identifiers';
import { currencyCodeSchema } from '../common/money';
import { timeZoneSchema } from '../common/time';

/**
 * Vitrine publique d'un établissement, servie **avant toute authentification**
 * à la page de réservation.
 *
 * `timezone` en fait partie et n'est pas optionnel : le front reçoit des
 * instants UTC et n'a aucun autre moyen de les afficher dans le calendrier du
 * salon. Sans lui, il retomberait sur le fuseau du navigateur — et une cliente
 * en déplacement verrait son rendez-vous décalé.
 *
 * Ce qui n'y figure pas est aussi un choix : ni `isActive`, ni les compteurs,
 * ni quoi que ce soit qui n'aide pas à réserver.
 */
export const publicTenantSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: displayNameSchema,
  timezone: timeZoneSchema,
  defaultCurrency: currencyCodeSchema,
  contactEmail: emailSchema.optional(),
  contactPhone: phoneSchema.optional(),
});

export type PublicTenant = z.infer<typeof publicTenantSchema>;

/**
 * Vue back-office du même établissement : la vitrine, plus l'état
 * d'activation que seul le staff a besoin de connaître.
 *
 * Composé par `.extend` et non réécrit — ajouter un champ à la vitrine le
 * propage ici, l'inverse n'est pas vrai.
 */
export const tenantSchema = publicTenantSchema.extend({
  isActive: z.boolean(),
});

export type Tenant = z.infer<typeof tenantSchema>;

/** Réglages modifiables d'un établissement depuis le back-office. */
export const updateTenantRequestSchema = z
  .object({
    name: displayNameSchema,
    timezone: timeZoneSchema,
    defaultCurrency: currencyCodeSchema,
    contactEmail: emailSchema.nullable(),
    contactPhone: phoneSchema.nullable(),
  })
  .strict()
  .partial();

export type UpdateTenantRequest = z.infer<typeof updateTenantRequestSchema>;
