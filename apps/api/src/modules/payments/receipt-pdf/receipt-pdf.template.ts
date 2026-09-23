import type { LegalIdType } from '@spa/shared';

import type { SaleItemKind } from '../pos.types';
import type { ReceiptIssuer, ReceiptSettlement, SaleReceipt } from '../receipt.types';
import { mm, type ReceiptSurface } from './receipt-pdf.canvas';
import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatSettlementMethod,
  formatTaxRate,
} from './receipt-pdf.format';
import { qrMatrix } from './receipt-pdf.qr';
import type { ReceiptPdfFormat } from './receipt-pdf.types';

/**
 * Ce qui s'imprime, et dans quel ordre — #819, troisième et quatrième critères.
 *
 * **Un seul gabarit pour les deux formats.** Le troisième critère énumère les
 * huit sections d'un ticket de caisse ; le quatrième dit de la facture A4
 * qu'elle porte « mêmes données, plus l'adresse de la cliente et la mention
 * *Facture n° …* ». Deux fichiers auraient donc eu à rester d'accord sur huit
 * sections, et le jour où l'un d'eux aurait oublié la ventilation de la TVA,
 * rien ne l'aurait dit. Ici, l'ordre est écrit une fois et `variant` ne gouverne
 * que ce qui diffère vraiment : la largeur, le corps du texte, et les deux
 * ajouts de la facture.
 *
 * Aucune de ces fonctions ne lit la base ni ne connaît Nest. Elles prennent un
 * `SaleReceipt` — celui que #818 compose — et une planche à dessin.
 */

/** Ce qu'un gabarit a besoin de savoir en plus du reçu lui-même. */
export interface TemplateContext {
  readonly variant: ReceiptPdfFormat;
  /** Le numéro de pièce composé, ou `null` quand la vente est encore ouverte. */
  readonly receiptNumber: string | null;
  /** Le lien que le QR code du pied porte. */
  readonly bookingUrl: string;
}

/** La nature de l'identifiant d'entreprise, en toutes lettres. */
const LEGAL_ID_LABELS: Readonly<Record<LegalIdType, string>> = {
  SIRET: 'SIRET',
  SIREN: 'SIREN',
  NIF: 'NIF',
  STAT: 'STAT',
  OTHER: 'Immatriculation',
};

/** L'adresse postale sur une ligne, ou `null` si le salon n'en a pas saisi. */
function addressLines(issuer: ReceiptIssuer): readonly string[] {
  if (issuer.addressLine1 === null || issuer.city === null) {
    return [];
  }

  const locality = [issuer.postalCode, issuer.city].filter((part) => part !== null).join(' ');

  return [issuer.addressLine1, issuer.addressLine2, locality].filter(
    (line): line is string => line !== null && line.trim() !== '',
  );
}

/**
 * Section 1 — l'en-tête : identité légale et coordonnées du salon.
 *
 * ## Le logo, et pourquoi il n'y en a pas
 *
 * Le deuxième critère demande « le logo du salon, s'il en a un ». Aucun salon
 * n'en a : `tenants` ne porte **aucune colonne de logo** — ni fichier, ni clé
 * S3, ni URL — et il n'en existe donc pas à imprimer. Ajouter la colonne aurait
 * demandé une migration Prisma, un envoi de fichier et un écran de réglage,
 * c'est-à-dire un ticket à part entière, hors du périmètre de celui-ci.
 *
 * La condition du critère — « s'il en a un » — est donc satisfaite par le seul
 * chemin qu'elle laisse ouvert : il n'en a pas, rien n'est dessiné, et la place
 * n'est pas réservée à vide. Le jour où la colonne existera, elle se pose ici,
 * au-dessus de l'enseigne.
 */
function header(canvas: ReceiptSurface, receipt: SaleReceipt, context: TemplateContext): void {
  const issuer = receipt.issuer;
  const centred = context.variant === 'ticket-80';
  const align = centred ? 'center' : 'left';

  canvas.text(issuer.name, { weight: 'bold', size: centred ? 13 : 16, align });

  if (issuer.legalName !== null && issuer.legalName !== issuer.name) {
    canvas.text(issuer.legalName, { align });
  }

  for (const line of addressLines(issuer)) {
    canvas.text(line, { align });
  }

  const contacts = [issuer.contactPhone, issuer.contactEmail].filter(
    (value): value is string => value !== null,
  );

  if (contacts.length > 0) {
    canvas.text(contacts.join(' · '), { align });
  }

  const identifiers: string[] = [];

  if (issuer.legalId !== null) {
    const nature = issuer.legalIdType === null ? 'Identifiant' : LEGAL_ID_LABELS[issuer.legalIdType];

    identifiers.push(`${nature} ${issuer.legalId}`);
  }

  if (issuer.vatNumber !== null) {
    identifiers.push(`TVA ${issuer.vatNumber}`);
  }

  if (identifiers.length > 0) {
    canvas.text(identifiers.join(' · '), { align });
  }

  canvas.gap(mm(2));
  canvas.rule();
}

/**
 * Section 2 — numéro de pièce, date et heure ; et le titre de la facture.
 *
 * Les deux instants sont rendus **dans le fuseau du salon** (cinquième critère).
 * La date de la pièce est celle de la clôture ; tant qu'elle n'a pas eu lieu, la
 * pièce n'a ni numéro ni date, et le document se déclare pour ce qu'il est — un
 * proforma. Le taire aurait laissé circuler un document d'allure comptable qui
 * n'en est pas un.
 */
function identification(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
): void {
  const timezone = receipt.issuer.timezone;
  const invoice = context.variant === 'a4';
  const numbered = context.receiptNumber !== null && receipt.issuedAt !== null;

  if (!numbered) {
    canvas.text(invoice ? 'FACTURE PROFORMA' : 'TICKET PROVISOIRE', {
      weight: 'bold',
      size: invoice ? 14 : 12,
      align: invoice ? 'left' : 'center',
    });
    canvas.text('Vente non close — ce document n’est pas une pièce comptable.', {
      align: invoice ? 'left' : 'center',
    });
    canvas.text(`Ticket ouvert le ${formatDateTime(receipt.openedAt, timezone)}`, {
      align: invoice ? 'left' : 'center',
    });
    canvas.gap(mm(2));
    canvas.rule();

    return;
  }

  const number = context.receiptNumber ?? '';
  const issuedAt = receipt.issuedAt ?? receipt.openedAt;

  if (invoice) {
    // Quatrième critère : « la mention *Facture n° …* ». La date et l'heure
    // tiennent sur une seule ligne : les séparer répétait la date deux fois.
    canvas.text(`Facture n° ${number}`, { weight: 'bold', size: 14 });
    canvas.text(`Date : ${formatDateTime(issuedAt, timezone)}`);
  } else {
    canvas.text(number, { weight: 'bold', size: 12, align: 'center' });
    canvas.text(formatDateTime(issuedAt, timezone), { align: 'center' });
  }

  canvas.gap(mm(2));
  canvas.rule();
}

/**
 * Section 3 — le caissier et le praticien ; et, sur la facture, la cliente.
 *
 * ## L'adresse de la cliente, et pourquoi elle est absente
 *
 * Le quatrième critère demande « l'adresse de la cliente **quand elle est
 * connue** ». Elle ne l'est jamais : le modèle ne porte aucune adresse de
 * personne — `users` a un e-mail, un téléphone, un prénom et un nom, et rien de
 * postal. La facture imprime donc le nom seul, ce que la condition du critère
 * prévoit.
 *
 * Ce n'est pas un oubli à rattraper ici : une adresse de cliente est une donnée
 * personnelle de plus à collecter, à afficher, à corriger et à effacer sur
 * demande (CDC §5.1) — une migration, un écran et une politique de rétention,
 * c'est-à-dire son propre ticket.
 */
function parties(canvas: ReceiptSurface, receipt: SaleReceipt, context: TemplateContext): void {
  if (context.variant === 'a4' && receipt.client !== null) {
    canvas.text('Facturé à', { weight: 'bold' });
    canvas.text(receipt.client.displayName);
    canvas.gap(mm(2));
  }

  canvas.row('Caissier', receipt.cashier.displayName);

  if (receipt.practitioner !== null) {
    canvas.row('Praticien', receipt.practitioner.displayName);
  }

  if (context.variant === 'ticket-80' && receipt.client !== null) {
    canvas.row('Cliente', receipt.client.displayName);
  }

  canvas.gap(mm(2));
  canvas.rule();
}

/**
 * Les lignes **vendues** — celles qui ont un prix de catalogue.
 *
 * `composeSale` matérialise la taxe et le pourboire en `sale_items` à part
 * entière (`pos.totals.ts`, `COMPOSED_LINE_ORDER`) : un ticket taxé avec
 * pourboire porte donc quatre articles là où la cliente n'en a choisi que deux.
 * Les imprimer dans la section des lignes **et** dans les sections 5 et 6, dont
 * c'est l'objet, les afficherait deux fois chacun — un ticket dont la colonne
 * de droite ne tombe plus sur son total.
 *
 * C'est exactement ce que la recette de #819 a montré sur une vente réelle, et
 * ce qu'un jeu d'essai composé à la main n'avait pas pu montrer : il portait une
 * ventilation de taxe sans les `sale_items` qui l'accompagnent toujours en base.
 */
const SELLABLE_KINDS: readonly SaleItemKind[] = ['SERVICE', 'PRODUCT'];

/** Section 4 — les lignes, dans l'ordre du reçu, prix unitaire **TTC** (#816). */
function lines(canvas: ReceiptSurface, receipt: SaleReceipt): void {
  for (const line of receipt.lines) {
    if (!SELLABLE_KINDS.includes(line.kind)) {
      continue;
    }

    canvas.row(line.label, formatMoney(line.lineAmount), { weight: 'bold' });

    if (line.quantity !== 1) {
      canvas.text(`${line.quantity} × ${formatMoney(line.unitAmount)}`, { indent: mm(3) });
    }
  }

  canvas.gap(mm(1));
  canvas.rule({ dashed: true });
}

/**
 * Section 5 — la ventilation de la TVA, puis section 6 — le total.
 *
 * La ventilation est **vide** quand l'établissement n'est pas assujetti (#818) :
 * imprimer « 0,00 € à 0 % » sur le ticket d'un salon qui ne collecte rien serait
 * une ligne qui ne veut rien dire.
 */
function totals(canvas: ReceiptSurface, receipt: SaleReceipt, context: TemplateContext): void {
  if (receipt.taxBreakdown.length > 0) {
    canvas.row('Total HT', formatMoney(receipt.subtotal));

    for (const tax of receipt.taxBreakdown) {
      canvas.row(`TVA ${formatTaxRate(tax.rateBps)}`, formatMoney(tax.tax), {
        indent: mm(3),
      });
    }

    canvas.row('Total TVA', formatMoney(receipt.taxTotal));
    canvas.gap(mm(1));
  }

  if (receipt.tip.amountMinor !== 0) {
    canvas.row('Pourboire', formatMoney(receipt.tip));
  }

  canvas.rule();
  canvas.row('TOTAL', formatMoney(receipt.total), {
    weight: 'bold',
    size: context.variant === 'a4' ? 14 : 12,
  });
  canvas.gap(mm(1));
  canvas.rule();
}

/**
 * Section 7 — les règlements et la monnaie rendue.
 *
 * **Tous** les règlements sont listés, et non le dernier : un ticket réglé
 * 50,00 € en espèces puis 28,00 € au terminal porte les deux lignes (#817,
 * septième critère de celui-ci). Les fondre en une seule aurait effacé du
 * rapprochement la moitié de ce qui est entré en caisse.
 *
 * Aucune donnée de carte n'y figure — il n'y en a aucune à porter, voir
 * `formatSettlementMethod`.
 */
function settlements(canvas: ReceiptSurface, receipt: SaleReceipt): void {
  if (receipt.settlements.length === 0) {
    canvas.text('Aucun règlement enregistré.');
    canvas.gap(mm(2));

    return;
  }

  for (const settlement of receipt.settlements) {
    canvas.row(
      // Le règlement entier, et non son seul `method` : c'est le **canal** qui
      // décide du libellé depuis #1027, et la référence du TPE ne se lit que
      // sur le canal qui peut en porter une.
      formatSettlementMethod(settlement),
      formatMoney(settlement.amount),
    );

    renderChange(canvas, settlement);
  }

  canvas.gap(mm(2));
}

/** Le billet tendu et la monnaie rendue — espèces seulement. */
function renderChange(canvas: ReceiptSurface, settlement: ReceiptSettlement): void {
  if (settlement.tendered === null || settlement.change === null) {
    return;
  }

  canvas.row('Reçu', formatMoney(settlement.tendered), { indent: mm(3) });
  canvas.row('Rendu', formatMoney(settlement.change), { indent: mm(3) });
}

/** Les avoirs émis sur cette vente — le sixième critère de #818. */
function refunds(canvas: ReceiptSurface, receipt: SaleReceipt, context: TemplateContext): void {
  if (receipt.refunds.length === 0) {
    return;
  }

  canvas.rule({ dashed: true });
  canvas.text('Avoirs', { weight: 'bold' });

  for (const refund of receipt.refunds) {
    const label =
      context.receiptNumber === null
        ? `Avoir ${refund.rank}`
        : `${context.receiptNumber}-R${refund.rank}`;

    canvas.row(label, formatMoney(refund.amount));
    canvas.text(formatDate(refund.issuedAt, receipt.issuer.timezone), { indent: mm(3) });

    if (refund.reason !== null) {
      canvas.text(refund.reason, { indent: mm(3) });
    }
  }

  canvas.gap(mm(2));
}

/** Section 8 — mentions, remerciement, et le QR code du lien de réservation. */
function footer(canvas: ReceiptSurface, receipt: SaleReceipt, context: TemplateContext): void {
  canvas.rule();

  if (receipt.issuer.footer !== null) {
    canvas.text(receipt.issuer.footer, { size: 7, align: 'center', gapAfter: mm(2) });
  }

  canvas.text('Merci de votre visite !', { weight: 'bold', align: 'center', gapAfter: mm(2) });
  // Le carré demandé porte le symbole **et** sa zone de silence (`ReceiptCanvas.qr`,
  // ISO/IEC 18004 §6.3.8) : les 6 mm de plus qu'avant sont cette marge, et non un
  // code plus gros — le module garde la taille qui se lit à 203 ppp.
  canvas.qr(qrMatrix(context.bookingUrl), context.variant === 'a4' ? mm(34) : mm(30));
  canvas.gap(mm(1.5));
  canvas.text('Reprendre rendez-vous', { size: 7, align: 'center' });
}

/**
 * Le ticket entier, dans l'ordre du troisième critère.
 *
 * Appelée deux fois par `receipt-pdf.service.ts` — une passe de mesure, une
 * passe de rendu —, et c'est le `draw` de la planche qui les distingue. Rien
 * ici n'a à savoir laquelle des deux se déroule : c'est toute la raison d'être
 * de `ReceiptCanvas`.
 */
export function renderReceipt(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
): void {
  header(canvas, receipt, context);
  identification(canvas, receipt, context);
  parties(canvas, receipt, context);
  lines(canvas, receipt);
  totals(canvas, receipt, context);
  settlements(canvas, receipt);
  refunds(canvas, receipt, context);
  footer(canvas, receipt, context);
}
