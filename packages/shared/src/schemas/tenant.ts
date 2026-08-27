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
import {
  MAX_MIN_BOOKING_NOTICE_MINUTES,
  MAX_SLOT_INTERVAL_MINUTES,
  MIN_BOOKING_NOTICE_MINUTES_FLOOR,
  MIN_SLOT_INTERVAL_MINUTES,
} from '../constants/limits';

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

/**
 * Les deux réglages qui gouvernent le calcul des créneaux libres (#34).
 *
 * Ils vivent sur l'établissement et non sur la prestation : un salon annonce une
 * grille, il n'en annonce pas une par soin. Les poser par prestation produirait
 * des grilles concurrentes sur un même agenda — deux soins aux pas différents
 * proposant des créneaux qui se chevauchent à moitié.
 *
 * ## Ce qu'ils ne disent pas
 *
 * Ni les tampons de préparation et de remise en état — ils appartiennent à la
 * prestation (`services.buffer_before_minutes` / `buffer_after_minutes`), parce
 * qu'un massage aux pierres chaudes n'a pas le même temps de cabine qu'une
 * coupe —, ni la fenêtre maximale interrogeable, qui est une borne de coût du
 * serveur (`MAX_AVAILABILITY_RANGE_DAYS`) et non un choix du salon.
 *
 * Ce schéma décrit une forme, il n'ouvre pas d'endpoint : #34 pose les colonnes
 * et l'algorithme qui les lit, #35 sert la disponibilité, et l'écran de réglages
 * du back-office les rendra modifiables. Même précédent que
 * `staffBusyIntervalSchema`, déclaré par #33 pour le moteur qui le consomme.
 */
export const tenantBookingSettingsSchema = z
  .object({
    /** Pas de découpage des créneaux proposés, en minutes. */
    slotIntervalMinutes: z
      .number()
      .int({ message: 'un pas de créneau s’exprime en minutes entières' })
      .min(MIN_SLOT_INTERVAL_MINUTES, {
        message: `pas de créneau attendu entre ${String(MIN_SLOT_INTERVAL_MINUTES)} et ${String(MAX_SLOT_INTERVAL_MINUTES)} minutes`,
      })
      .max(MAX_SLOT_INTERVAL_MINUTES, {
        message: `pas de créneau attendu entre ${String(MIN_SLOT_INTERVAL_MINUTES)} et ${String(MAX_SLOT_INTERVAL_MINUTES)} minutes`,
      }),
    /** Délai minimum avant le début d'un créneau proposable, en minutes. */
    minBookingNoticeMinutes: z
      .number()
      .int({ message: 'un délai de réservation s’exprime en minutes entières' })
      .min(MIN_BOOKING_NOTICE_MINUTES_FLOOR, {
        message: `délai minimum attendu entre ${String(MIN_BOOKING_NOTICE_MINUTES_FLOOR)} et ${String(MAX_MIN_BOOKING_NOTICE_MINUTES)} minutes`,
      })
      .max(MAX_MIN_BOOKING_NOTICE_MINUTES, {
        message: `délai minimum attendu entre ${String(MIN_BOOKING_NOTICE_MINUTES_FLOOR)} et ${String(MAX_MIN_BOOKING_NOTICE_MINUTES)} minutes`,
      }),
  })
  .strict();

export type TenantBookingSettings = z.infer<typeof tenantBookingSettingsSchema>;
