import type { LegalIdType } from '@spa/shared';

import type { Money } from './payments.types';
import type { SaleItemKind } from './pos.types';

/**
 * Le vocabulaire du **ticket de caisse** — #818, cinquième et septième critères.
 *
 * Ni DTO HTTP — ils vivent sous `dto/` —, ni types générés par Prisma
 * (api-module §2). La **forme servie**, elle, est tenue par le contrat partagé
 * (`packages/shared/src/schemas/receipt.ts`), qui en est la source de vérité :
 * ces types-ci sont ce que le dépôt lit et ce que le service compose, avec des
 * `Date` et des `null` là où le contrat a des chaînes ISO et des clés absentes.
 *
 * `LegalIdType` est en revanche **importé** du contrat et non redéclaré : c'est
 * l'énumération que la colonne porte et que le front affiche, et le témoin d'une
 * liste recopiée ici aurait été une liste de plus à tenir en regard (l'écart que
 * `pos.types.ts` documente pour `SALE_ITEM_KINDS` et que #554 laisse ouvert).
 */

/** L'établissement tel que la pièce le nomme. */
export interface ReceiptIssuer {
  readonly name: string;
  readonly legalName: string | null;
  readonly legalIdType: LegalIdType | null;
  readonly legalId: string | null;
  readonly vatNumber: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly footer: string | null;
  /** Le préfixe de numérotation — le `{PRÉFIXE}` du format affiché. */
  readonly receiptPrefix: string;
  /** Le fuseau de l'établissement, pour l'affichage des instants. */
  readonly timezone: string;
}

/**
 * Une personne nommée sur la pièce.
 *
 * Un nom d'affichage, et rien d'autre : ni identifiant, ni coordonnées. Ce
 * qu'on n'imprime pas sur un reçu ne peut pas être ramassé avec lui (CDC §5.1).
 */
export interface ReceiptParty {
  readonly displayName: string;
}

/** Une ligne du reçu — prix unitaire **TTC**, depuis #816. */
export interface ReceiptLine {
  readonly position: number;
  readonly kind: SaleItemKind;
  readonly label: string;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly lineAmount: Money;
}

/** Une ventilation de taxe, pour un taux donné. */
export interface ReceiptTaxLine {
  readonly rateBps: number;
  readonly base: Money;
  readonly tax: Money;
}

/** Un règlement porté sur la pièce. */
export interface ReceiptSettlement {
  readonly method: 'CASH' | 'CARD';
  readonly amount: Money;
  /** Ce que la cliente a tendu — espèces seulement, `null` partout ailleurs. */
  readonly tendered: Money | null;
  /** `tendered − amount`, ou `null` quand rien n'a été rendu. */
  readonly change: Money | null;
  readonly capturedAt: Date | null;
}

/**
 * Un avoir émis sur cette vente — sixième critère.
 *
 * `rank` est le rang du remboursement sur la vente, à partir de 1 : c'est lui
 * qui compose le numéro de la pièce d'avoir, `{numéro d'origine}-R{rang}`. Il se
 * déduit d'un ordre total et immuable — les remboursements d'une vente, du plus
 * ancien au plus récent —, et ne peut donc ni sauter ni collisionner.
 */
export interface ReceiptRefund {
  readonly rank: number;
  readonly amount: Money;
  readonly issuedAt: Date;
  readonly reason: string | null;
}

/** Le ticket de caisse complet, tel que le service le compose. */
export interface SaleReceipt {
  readonly saleId: string;
  /** Le rang dans la suite de l'établissement, `null` tant qu'il est ouvert. */
  readonly sequence: number | null;
  /** L'instant de la clôture — la date de la pièce. */
  readonly issuedAt: Date | null;
  /** L'instant où le comptoir a composé le ticket. */
  readonly openedAt: Date;
  readonly issuer: ReceiptIssuer;
  readonly cashier: ReceiptParty;
  readonly client: ReceiptParty | null;
  readonly practitioner: ReceiptParty | null;
  readonly lines: readonly ReceiptLine[];
  readonly taxBreakdown: readonly ReceiptTaxLine[];
  readonly subtotal: Money;
  readonly taxTotal: Money;
  readonly tip: Money;
  readonly total: Money;
  readonly settlements: readonly ReceiptSettlement[];
  readonly refunds: readonly ReceiptRefund[];
}
