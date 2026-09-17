import { Injectable } from '@nestjs/common';

import { NotFoundError } from '../../common/errors';
import type { Money } from './payments.types';
import type { SaleItemKind } from './pos.types';
import { ReceiptRepository, type ReceiptRow } from './receipt.repository';
import type {
  ReceiptIssuer,
  ReceiptLine,
  ReceiptParty,
  ReceiptRefund,
  ReceiptSettlement,
  ReceiptTaxLine,
  SaleReceipt,
} from './receipt.types';

/**
 * Le ticket de caisse — #818, cinquième et sixième critères.
 *
 * Ne connaît ni `Request`, ni `Response`, ni Prisma (api-module §2). Il ne
 * **calcule** rien de ce que la cliente doit : tous les montants viennent des
 * colonnes que le serveur a composées à la vente et figées à la clôture. Le
 * seul montant qu'il dérive est la **monnaie rendue**, et elle se soustrait.
 *
 * ## Pourquoi un service à part de `SalesService`
 *
 * Parce qu'il répond à une autre question. `SalesService` compose une addition
 * et la relit ; celui-ci compose une **pièce comptable** — ce qui demande
 * l'identité légale du salon, les personnes que la vente met en présence, la
 * ventilation de la taxe et les avoirs. Les y fondre aurait fait lire tout cela
 * à chaque `GET /sales/:id`, pour une page de caisse qui n'en affiche rien.
 *
 * ## Ce qu'il ne fait pas
 *
 * **Il n'attribue aucun numéro.** Le rang est pris à la clôture, dans la
 * transaction qui pose `settled_at` (`receipt.numbering.ts`) : le lire ici
 * reviendrait à en attribuer un à chaque impression, et la suite aurait autant
 * de trous que de reçus consultés. Un ticket encore ouvert n'a donc pas de
 * numéro, et son reçu est un proforma.
 */

function money(amountMinor: number, currency: string): Money {
  return { amountMinor, currency };
}

/** « Camille Roux » — le nom tel qu'une pièce le porte. */
function displayNameOf(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`.trim();
}

function toParty(person: { firstName: string; lastName: string }): ReceiptParty {
  return { displayName: displayNameOf(person) };
}

function toIssuer(tenant: ReceiptRow['tenant']): ReceiptIssuer {
  return {
    name: tenant.name,
    slug: tenant.slug,
    legalName: tenant.legalName,
    legalIdType: tenant.legalIdType,
    legalId: tenant.legalId,
    vatNumber: tenant.vatNumber,
    addressLine1: tenant.addressLine1,
    addressLine2: tenant.addressLine2,
    postalCode: tenant.postalCode,
    city: tenant.city,
    countryCode: tenant.countryCode,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
    footer: tenant.receiptFooter,
    receiptPrefix: tenant.receiptPrefix,
    timezone: tenant.timezone,
  };
}

function toLine(item: ReceiptRow['items'][number]): ReceiptLine {
  return {
    position: item.position,
    // L'énumération du schéma est reprise telle quelle : le témoin de
    // `pos.types.spec.ts` garantit que les libellés coïncident.
    kind: item.kind as SaleItemKind,
    label: item.label,
    quantity: item.quantity,
    unitAmount: money(item.unitAmountMinor, item.currency),
    lineAmount: money(item.lineAmountMinor, item.currency),
  };
}

/**
 * La ventilation de la taxe — cinquième critère.
 *
 * Une seule assiette aujourd'hui : le MVP applique un taux par établissement, et
 * le ticket le porte figé (`sales.tax_rate_bps`). Le tableau reste un tableau
 * parce que c'est la forme d'une ventilation — le jour où une prestation portera
 * son propre taux, rien du contrat ni de l'écran n'aura à changer.
 *
 * Vide quand il n'y a pas de taxe : afficher « 0,00 € à 0 % » sur le reçu d'un
 * salon qui n'est pas assujetti serait une ligne qui ne veut rien dire.
 */
export function taxBreakdownOf(sale: {
  readonly subtotalAmountMinor: number;
  readonly taxAmountMinor: number;
  readonly taxRateBps: number;
  readonly currency: string;
}): readonly ReceiptTaxLine[] {
  if (sale.taxAmountMinor === 0) {
    return [];
  }

  return [
    {
      rateBps: sale.taxRateBps,
      base: money(sale.subtotalAmountMinor, sale.currency),
      tax: money(sale.taxAmountMinor, sale.currency),
    },
  ];
}

/**
 * Un règlement, et la monnaie qu'il a rendue.
 *
 * La monnaie n'est pas stockée : elle se **déduit** de `tendered − amount`, et
 * inscrire les deux aurait rendu représentable une monnaie incohérente avec le
 * billet. `tendered` n'est écrit que sur un règlement en espèces qui a rendu
 * quelque chose — `payments_tendered_amount_minor_check` refuse le reste.
 */
function toSettlement(payment: ReceiptRow['payments'][number]): ReceiptSettlement {
  const tendered = payment.tenderedAmountMinor;

  return {
    method: payment.method as 'CASH' | 'CARD',
    amount: money(payment.amountMinor, payment.currency),
    tendered: tendered === null ? null : money(tendered, payment.currency),
    change: tendered === null ? null : money(tendered - payment.amountMinor, payment.currency),
    capturedAt: payment.capturedAt,
  };
}

/**
 * Les avoirs de la vente, **rangés** — sixième critère.
 *
 * Les remboursements vivent sous les encaissements ; une pièce de caisse, elle,
 * les porte tous ensemble. Ils sont donc mis à plat puis ordonnés par leur
 * instant, départagés par leur identifiant : c'est cet ordre total et immuable
 * qui donne son rang à chaque avoir, et donc son numéro — `{numéro
 * d'origine}-R{rang}`.
 *
 * L'ordre ne peut pas changer rétroactivement : un remboursement s'ajoute, il ne
 * s'insère jamais avant un plus ancien, et aucun ne se retire.
 */
export function refundsOf(payments: ReceiptRow['payments']): readonly ReceiptRefund[] {
  const flattened = payments.flatMap((payment) => payment.refunds);

  flattened.sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
  );

  return flattened.map((refund, index) => ({
    rank: index + 1,
    amount: money(refund.amountMinor, refund.currency),
    issuedAt: refund.createdAt,
    // Le motif est facultatif à l'affichage : la colonne est `NOT NULL`, mais un
    // comptoir peut n'avoir rien écrit, et une ligne « Motif : » vide sur une
    // pièce imprimée n'apprend rien.
    reason: refund.reason.trim() === '' ? null : refund.reason,
  }));
}

@Injectable()
export class ReceiptService {
  public constructor(private readonly repository: ReceiptRepository) {}

  /**
   * Le ticket de caisse d'une vente de l'établissement courant.
   *
   * @throws {NotFoundError} vente inconnue, ou d'un autre établissement — les
   * deux refus sont indiscernables (tenant-isolation §4).
   */
  public async bySaleId(saleId: string): Promise<SaleReceipt> {
    const row = await this.repository.findReceiptBySaleId(saleId);

    if (row === null) {
      throw new NotFoundError('Ticket introuvable.');
    }

    return {
      saleId: row.id,
      sequence: row.receiptNumber,
      issuedAt: row.settledAt,
      openedAt: row.createdAt,
      issuer: toIssuer(row.tenant),
      cashier: toParty(row.cashier),
      client: row.appointment === null ? null : toParty(row.appointment.client),
      practitioner:
        row.appointment === null ? null : { displayName: row.appointment.staff.displayName },
      lines: row.items.map((item) => toLine(item)),
      taxBreakdown: taxBreakdownOf(row),
      subtotal: money(row.subtotalAmountMinor, row.currency),
      taxTotal: money(row.taxAmountMinor, row.currency),
      tip: money(row.tipAmountMinor, row.currency),
      total: money(row.totalAmountMinor, row.currency),
      settlements: row.payments.map((payment) => toSettlement(payment)),
      refunds: refundsOf(row.payments),
    };
  }
}
