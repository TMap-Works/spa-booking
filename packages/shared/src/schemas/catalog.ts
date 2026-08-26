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
 *
 * La **rubrique est une entité** depuis #24, et non plus une chaîne libre portée
 * par la prestation : elle a son identifiant, son slug unique par tenant, sa
 * description et son propre basculement d'activité. Une prestation la désigne
 * par `categoryId` en entrée et la porte imbriquée en sortie.
 */

import { z } from 'zod';

import {
  displayNameSchema,
  longTextSchema,
  slugSchema,
  uuidSchema,
} from '../common/identifiers';
import { nonNegativeMoneySchema } from '../common/money';
import { durationMinutesSchema } from '../common/time';

/**
 * Tampon de part et d'autre d'un soin, en minutes.
 *
 * Zéro est permis, contrairement à une durée de soin : un soin sans temps de
 * préparation est le cas courant. Négatif ne l'est pas — un tampon négatif
 * raccourcirait le créneau occupé au lieu de l'allonger, rendant la cabine
 * disponible avant la fin réelle du soin. La base pose le même plancher
 * (`CHECK ("buffer_before_minutes" >= 0)`).
 */
export const bufferMinutesSchema = z
  .number()
  .int({ message: 'un tampon s’exprime en minutes entières' })
  .min(0, { message: 'un tampon n’est jamais négatif' });

/**
 * Rubrique du catalogue — « Soins du visage », « Coiffure ».
 *
 * Table à part entière depuis #24, là où `services.category` était une chaîne
 * libre recopiée à chaque prestation : une chaîne se renomme une prestation à la
 * fois, tolère « Massages » à côté de « massage », et ne se désactive pas.
 */
export const serviceCategorySchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: displayNameSchema,
  description: longTextSchema.nullable(),
  isActive: z.boolean(),
});

export type ServiceCategory = z.infer<typeof serviceCategorySchema>;

/** Forme réduite, telle qu'imbriquée dans une prestation. */
export const serviceCategorySummarySchema = serviceCategorySchema.pick({
  id: true,
  slug: true,
  name: true,
});

export type ServiceCategorySummary = z.infer<typeof serviceCategorySummarySchema>;

/**
 * Création d'une rubrique. `slug` est optionnel — le serveur le dérive du nom —
 * et reste fournissable pour figer l'URL publique d'une rubrique qu'on renomme.
 */
export const createServiceCategoryRequestSchema = z
  .object({
    name: displayNameSchema,
    slug: slugSchema.optional(),
    description: longTextSchema.optional(),
  })
  .strict();

export type CreateServiceCategoryRequest = z.infer<typeof createServiceCategoryRequestSchema>;

/**
 * Modification d'une rubrique — tous les champs optionnels.
 *
 * `isActive` s'y ajoute : c'est **ainsi** qu'une rubrique sort du catalogue. Il
 * n'y a pas de suppression, parce que des prestations la référencent et que le
 * reporting doit continuer à savoir sous quelle rubrique une vente a été faite.
 *
 * `description` accepte `null` — il vaut « efface ce texte ». L'absence du champ
 * et son effacement sont deux gestes distincts, et un formulaire vidé doit
 * pouvoir dire le second.
 */
export const updateServiceCategoryRequestSchema = createServiceCategoryRequestSchema
  .extend({ description: longTextSchema.nullable(), isActive: z.boolean() })
  .partial();

export type UpdateServiceCategoryRequest = z.infer<typeof updateServiceCategoryRequestSchema>;

/** Prestation vendue par l'établissement. */
export const serviceSchema = z.object({
  id: uuidSchema,
  slug: slugSchema,
  name: displayNameSchema,
  description: longTextSchema.nullable(),
  /**
   * La rubrique est **imbriquée** plutôt que réduite à son identifiant : un
   * écran de catalogue affiche le libellé, et le rendre obligerait sinon à une
   * seconde requête ou à un appariement côté client. `null` pour une prestation
   * non classée — imposer une rubrique obligerait à en inventer une avant de
   * pouvoir créer la première prestation.
   */
  category: serviceCategorySummarySchema.nullable(),
  /** Durée facturée du soin — ce que le client voit et paie. */
  durationMinutes: durationMinutesSchema,
  /**
   * Préparation avant le soin et remise en état après, en minutes. Non
   * facturées, invisibles du client, mais occupées sur l'agenda du praticien.
   */
  bufferBeforeMinutes: bufferMinutesSchema,
  bufferAfterMinutes: bufferMinutesSchema,
  /**
   * Durée réellement bloquée sur l'agenda, tampons compris — la valeur dont le
   * calendrier admin et le moteur de disponibilité ont besoin.
   *
   * **Dérivée** des trois champs précédents et jamais stockée : une quatrième
   * colonne se désynchroniserait de ses termes à la première mise à jour
   * partielle. Le serveur la calcule pour que la règle n'ait pas à être
   * réécrite — donc à diverger — côté client.
   */
  occupiedMinutes: durationMinutesSchema,
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
 *
 * `staffIds` n'y figure plus : l'affectation « ce praticien pratique cette
 * prestation » a son propre point d'entrée — `setStaffServicesRequestSchema`
 * plus bas — et l'endpoint de création livré par #24 refuse le champ. Un contrat
 * qui annonce un champ que l'API rejette en 400 coûte au front autant qu'un bug.
 */
export const createServiceRequestSchema = z
  .object({
    name: displayNameSchema,
    slug: slugSchema.optional(),
    description: longTextSchema.optional(),
    /** Rubrique du catalogue, par identifiant. Absent : prestation non classée. */
    categoryId: uuidSchema.optional(),
    durationMinutes: durationMinutesSchema,
    /** Absents, les tampons valent zéro — le cas courant. */
    bufferBeforeMinutes: bufferMinutesSchema.optional(),
    bufferAfterMinutes: bufferMinutesSchema.optional(),
    price: nonNegativeMoneySchema,
  })
  .strict();

export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

/**
 * Modification d'une prestation — tous les champs optionnels.
 *
 * `isActive` s'y ajoute : c'est **ainsi** qu'une prestation sort du catalogue.
 * Il n'y a pas de suppression, parce que les rendez-vous passés la référencent
 * et que le reporting doit continuer à savoir ce qui a été vendu.
 *
 * `description` et `categoryId` acceptent `null` — respectivement « efface ce
 * texte » et « déclasse cette prestation ». Les autres champs le refusent : un
 * prix ou une durée ne s'efface pas, il se remplace.
 */
export const updateServiceRequestSchema = createServiceRequestSchema
  .extend({
    description: longTextSchema.nullable(),
    categoryId: uuidSchema.nullable(),
    isActive: z.boolean(),
  })
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

/**
 * Un praticien affecté à une prestation, tel que le **back-office** le liste.
 *
 * Le résumé public ne porte que l'identifiant et le nom d'affichage ; celui-ci y
 * ajoute `isActive`, parce qu'un écran d'affectation doit pouvoir montrer qu'une
 * prestation reste rattachée à un praticien qui ne prend plus de rendez-vous.
 * Masquer cette ligne ferait croire à une affectation perdue et inviterait à la
 * recréer — pour se heurter au conflit d'unicité de `service_staff`.
 *
 * `bio` n'y figure pas : c'est de la vitrine, pas de la gestion, et une liste
 * d'affectations n'a aucune raison de transporter deux mille caractères par
 * ligne.
 */
export const serviceStaffMemberSchema = staffMemberSummarySchema.extend({
  isActive: z.boolean(),
});

export type ServiceStaffMember = z.infer<typeof serviceStaffMemberSchema>;

/**
 * Affecte **un** praticien à une prestation.
 *
 * Volontairement unitaire, là où `setStaffServicesRequestSchema` remplace en
 * bloc l'ensemble des prestations d'un praticien. Les deux gestes ne sont pas le
 * même : l'écran d'une prestation coche et décoche un praticien à la fois, et
 * lui imposer d'envoyer la liste complète ferait écraser, à chaque clic, les
 * affectations qu'un collègue vient d'ajouter. Le retrait a sa propre route —
 * `DELETE …/staff/{staffId}` — plutôt qu'un drapeau dans ce corps.
 *
 * Aucun `tenantId` : l'établissement vient du jeton vérifié et de nulle part
 * ailleurs (tenant-isolation §2). Le `.strict()` est ce qui refuse le champ s'il
 * était glissé quand même.
 */
export const assignServiceStaffRequestSchema = z
  .object({
    staffId: uuidSchema,
  })
  .strict();

export type AssignServiceStaffRequest = z.infer<typeof assignServiceStaffRequestSchema>;

/**
 * Une prestation telle que la **page de réservation publique** la reçoit, avec
 * les praticiens qui la pratiquent.
 *
 * Trois champs de `serviceSchema` en sont délibérément absents :
 *
 * - `bufferBeforeMinutes` et `bufferAfterMinutes` — le contrat les décrit
 *   lui-même comme « invisibles du client ». Ce sont des temps de cabine, donc
 *   une information d'exploitation : les publier révélerait la cadence interne
 *   d'un salon à qui lit son catalogue, sans rien apporter au visiteur, qui ne
 *   voit et ne paie que la durée du soin ;
 * - `occupiedMinutes`, qui n'est que leur somme avec la durée et fuiterait donc
 *   la même information par soustraction ;
 * - `isActive`, qui vaudrait toujours `true` — le catalogue public ne contient
 *   que des prestations actives. Un champ constant invite à écrire un filtre
 *   côté client et à croire qu'il peut valoir `false`.
 *
 * `staff` porte le **résumé** public de chaque praticien actif. Un praticien
 * désactivé n'y apparaît pas : il ne prend pas de rendez-vous, et le proposer au
 * choix mènerait à un créneau qu'aucun agenda ne peut honorer.
 */
export const publicServiceSchema = serviceSchema
  .pick({
    id: true,
    slug: true,
    name: true,
    description: true,
    category: true,
    durationMinutes: true,
    price: true,
  })
  .extend({ staff: z.array(staffMemberSummarySchema) });

export type PublicService = z.infer<typeof publicServiceSchema>;
