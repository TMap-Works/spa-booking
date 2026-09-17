/**
 * Le ticket de caisse — **le contrat**, source de vérité du septième critère de
 * #818.
 *
 * Ce fichier décrit ce qu'une pièce de caisse porte, et le front ne redéclare
 * aucun de ces types (CLAUDE.md, « les types d'API vivent dans
 * `packages/shared` »). C'est une **lecture** et rien d'autre : aucun schéma
 * d'entrée ici, aucun montant qui remonterait du navigateur — le total d'un
 * ticket est composé par le serveur, et le reçu n'en est que la restitution.
 *
 * ## Ce que le reçu ne porte pas
 *
 * Ni `tenantId` — la vitrine est celle du salon qui sert la requête
 * (tenant-isolation §4) —, ni la moindre donnée de carte : un règlement porte
 * son moyen et son montant, jamais une marque, un porteur ou quatre chiffres
 * (payments-stripe §1). Ni l'adresse ou le téléphone de la cliente : un reçu la
 * **nomme**, il ne recopie pas sa fiche (CDC §5.1).
 */

import { z } from 'zod';

import { displayNameSchema, emailSchema, storedPhoneSchema, uuidSchema } from '../common/identifiers';
import { moneySchema, nonNegativeMoneySchema } from '../common/money';
import { timeZoneSchema, utcInstantSchema } from '../common/time';
import {
  LEGAL_ID_MAX_LENGTH,
  LEGAL_ID_TYPES,
  LEGAL_NAME_MAX_LENGTH,
  RECEIPT_FOOTER_MAX_LENGTH,
  RECEIPT_PREFIX_PATTERN,
} from '../constants/receipt';
import { counterPaymentMethodSchema } from './payment';
import { postalAddressSchema } from './tenant';

export const legalIdTypeSchema = z.enum(LEGAL_ID_TYPES);

export const legalNameSchema = z.string().trim().min(1).max(LEGAL_NAME_MAX_LENGTH);

export const legalIdSchema = z.string().trim().min(1).max(LEGAL_ID_MAX_LENGTH);

export const receiptFooterSchema = z.string().trim().min(1).max(RECEIPT_FOOTER_MAX_LENGTH);

/** Le préfixe de numérotation, normalisé en majuscules dès la lecture. */
export const receiptPrefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(RECEIPT_PREFIX_PATTERN, {
    message: 'préfixe attendu : 2 à 8 lettres majuscules ou chiffres, sans tiret',
  });

/**
 * L'émetteur de la pièce — le cinquième critère, « identité légale et
 * coordonnées du salon ».
 *
 * Tout y est facultatif **sauf le nom commercial et le fuseau**. C'est ce qui
 * rend la migration additive vraie jusqu'au bout : un salon inscrit avant #818
 * n'a ni raison sociale, ni identifiant d'entreprise, et son reçu doit
 * continuer d'être servi. Un champ manquant est **omis**, jamais rendu `null` —
 * même régime que l'adresse de `publicTenantSchema`, pour que l'écran n'ait pas
 * à distinguer « pas renseigné » de « renseigné vide ».
 */
export const receiptIssuerSchema = z.object({
  /** Le nom commercial — celui de l'enseigne, toujours présent. */
  name: displayNameSchema,
  /** La raison sociale, quand elle diffère de l'enseigne. */
  legalName: legalNameSchema.optional(),
  legalIdType: legalIdTypeSchema.optional(),
  legalId: legalIdSchema.optional(),
  vatNumber: legalIdSchema.optional(),
  address: postalAddressSchema.optional(),
  contactEmail: emailSchema.optional(),
  contactPhone: storedPhoneSchema.optional(),
  /** Les mentions que le salon imprime en pied de ticket. */
  footer: receiptFooterSchema.optional(),
});

export type ReceiptIssuer = z.infer<typeof receiptIssuerSchema>;

/**
 * Une personne nommée sur la pièce — la caissière, la cliente, le praticien.
 *
 * Un **nom d'affichage** et rien d'autre. Pas d'identifiant : un reçu se lit, il
 * ne sert pas à énumérer le fichier client. Pas de coordonnées non plus — ce
 * qu'on n'écrit pas sur une pièce imprimée ne peut pas être ramassé avec elle
 * (CDC §5.1).
 */
export const receiptPartySchema = z.object({ displayName: displayNameSchema });

export type ReceiptParty = z.infer<typeof receiptPartySchema>;

/** Nature d'une ligne de ticket, telle que la colonne la porte. */
export const receiptLineKindSchema = z.enum(['SERVICE', 'PRODUCT', 'TAX', 'TIP']);

/**
 * Une ligne du reçu — « libellé, quantité, prix unitaire TTC, total » du
 * cinquième critère.
 *
 * `unitPrice` est **TTC** : depuis #816, les prix du catalogue sont les prix
 * affichés, et la taxe s'en **extrait** au lieu de s'y ajouter. La ventilation
 * de TVA vit donc à part, dans {@link receiptTaxLineSchema}, et non en colonne
 * de chaque ligne.
 */
export const receiptLineSchema = z.object({
  position: z.number().int().min(0),
  kind: receiptLineKindSchema,
  label: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: moneySchema,
  total: moneySchema,
});

export type ReceiptLine = z.infer<typeof receiptLineSchema>;

/**
 * La ventilation de la taxe **par taux** — cinquième critère.
 *
 * Un tableau et non un montant unique, alors que le MVP n'expose qu'un taux par
 * établissement (`tenants.tax_rate_bps`) : une pièce comptable porte la
 * ventilation, et un ticket composé sous un taux de 20 % puis relu après un
 * passage à 10 % doit continuer d'afficher le taux **sous lequel il a été
 * composé**. Le taux est donc reconstitué depuis les montants figés du ticket,
 * jamais relu sur l'établissement.
 */
export const receiptTaxLineSchema = z.object({
  /** Le taux, en points de base — `2000` vaut 20 % (jamais un flottant). */
  rateBps: z.number().int().min(0).max(10_000),
  /** L'assiette hors taxe à laquelle ce taux s'applique. */
  base: nonNegativeMoneySchema,
  /** La taxe **comprise dans** les prix affichés de cette assiette. */
  tax: nonNegativeMoneySchema,
});

export type ReceiptTaxLine = z.infer<typeof receiptTaxLineSchema>;

/**
 * Un règlement porté sur la pièce — « moyen, montant, et monnaie rendue pour les
 * espèces ».
 *
 * `tendered` et `change` sont omis partout sauf sur un règlement en espèces où
 * la cliente a tendu plus que le dû : c'est la seule situation où la monnaie
 * existe, un terminal ne rendant jamais rien (`settlement.rules.ts`,
 * `givesChange`).
 */
export const receiptSettlementSchema = z.object({
  // Le moyen est celui du comptoir, repris de `counterPaymentMethodSchema` et
  // non redéclaré : deux énumérations pour une seule valeur de colonne auraient
  // fini par diverger, et c'est la même que `settleSaleRequestSchema` accepte.
  method: counterPaymentMethodSchema,
  amount: nonNegativeMoneySchema,
  /** Ce que la cliente a tendu, espèces seulement. */
  tendered: nonNegativeMoneySchema.optional(),
  /** `tendered − amount` — la monnaie rendue, jamais encaissée. */
  change: nonNegativeMoneySchema.optional(),
  capturedAt: utcInstantSchema.nullable(),
});

export type ReceiptSettlement = z.infer<typeof receiptSettlementSchema>;

/**
 * La pièce d'avoir d'un remboursement — sixième critère.
 *
 * « Une vente remboursée garde son numéro. Le remboursement produit sa propre
 * pièce, qui cite le numéro d'origine » : `number` est la pièce, `origin` est le
 * numéro cité, et les deux figurent sur le reçu de la vente comme sur l'avoir.
 *
 * ## Les deux sont nuls quand la vente n'est pas close
 *
 * Un encaissement abouti peut ne solder qu'une part du ticket — une intention
 * carte de 50,00 € sur une addition de 100,00 € — puis être remboursé avant que
 * le reste ne soit réglé. La vente n'a alors pas de numéro (`saleReceiptSchema.
 * number` est nul pour la même raison), et il n'y a donc **rien à citer** :
 * `origin` est nul, et `number` l'est avec lui. Inventer `-R1` aurait produit un
 * numéro de pièce qui ne désigne aucune vente.
 */
export const receiptRefundSchema = z.object({
  /** `TIC-2026-000123-R1` — la pièce de cet avoir, ou `null`. */
  number: z.string().min(1).nullable(),
  /** `TIC-2026-000123` — la vente que cet avoir annule, ou `null`. */
  origin: z.string().min(1).nullable(),
  amount: nonNegativeMoneySchema,
  issuedAt: utcInstantSchema,
  /** Le motif saisi au comptoir, quand il y en a un. */
  reason: z.string().optional(),
});

export type ReceiptRefund = z.infer<typeof receiptRefundSchema>;

/**
 * Le ticket de caisse complet — ce que `GET /v1/sales/:id/receipt` rend.
 *
 * ## Le numéro est nul tant que la vente n'est pas close
 *
 * Premier critère : le numéro est attribué **à la clôture**. Un ticket encore
 * ouvert n'en a donc pas, et le reçu qu'on en tire est un proforma — il porte
 * tout le reste, et `number` vaut `null`. Inventer un numéro à la lecture aurait
 * percé la suite sans trou dès le premier ticket abandonné au comptoir.
 *
 * ## Deux instants, deux sens
 *
 * `issuedAt` est l'instant de la **clôture** — la date de la pièce, nulle tant
 * qu'elle n'est pas close. `openedAt` est celui de la composition du ticket. Les
 * deux sont en UTC, et `timezone` est le fuseau de l'établissement : le
 * cinquième critère demande « date et heure en UTC, avec le fuseau du salon »,
 * c'est-à-dire de quoi afficher l'heure locale sans que le navigateur impose la
 * sienne (CLAUDE.md, « converti à l'affichage selon le fuseau du tenant »).
 */
export const saleReceiptSchema = z.object({
  saleId: uuidSchema,
  /** `TIC-2026-000123`, ou `null` tant que la vente n'est pas close. */
  number: z.string().min(1).nullable(),
  /** Le rang dans la suite de l'établissement, ou `null`. */
  sequence: z.number().int().positive().nullable(),
  /** L'instant de la clôture — la date de la pièce. */
  issuedAt: utcInstantSchema.nullable(),
  /** L'instant où le comptoir a composé le ticket. */
  openedAt: utcInstantSchema,
  /** Le fuseau de l'établissement, pour l'affichage de ces deux instants. */
  timezone: timeZoneSchema,
  issuer: receiptIssuerSchema,
  cashier: receiptPartySchema,
  /** La cliente, quand la vente est adossée à un rendez-vous. */
  client: receiptPartySchema.nullable(),
  /** Le praticien du rendez-vous facturé, le cas échéant. */
  practitioner: receiptPartySchema.nullable(),
  lines: z.array(receiptLineSchema),
  /** La ventilation de la taxe par taux — vide si l'établissement n'en a pas. */
  taxBreakdown: z.array(receiptTaxLineSchema),
  /** La part hors taxe des lignes du catalogue. */
  subtotal: nonNegativeMoneySchema,
  /** La taxe comprise dans les prix affichés. */
  taxTotal: nonNegativeMoneySchema,
  /** Le pourboire, hors taxe par nature. */
  tip: nonNegativeMoneySchema,
  /** Ce que la cliente doit — `subtotal + taxTotal + tip`. */
  total: nonNegativeMoneySchema,
  settlements: z.array(receiptSettlementSchema),
  /** Les avoirs émis sur cette vente, du plus ancien au plus récent. */
  refunds: z.array(receiptRefundSchema),
});

export type SaleReceipt = z.infer<typeof saleReceiptSchema>;
