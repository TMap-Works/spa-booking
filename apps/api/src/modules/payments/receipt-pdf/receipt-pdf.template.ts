import type { LegalIdType, Locale } from '@spa/shared';

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
import { receiptVocabulary, type ReceiptVocabulary } from './receipt-pdf.vocabulary';

/**
 * Ce qui s'imprime, et dans quel ordre — #819, troisième et quatrième critères ;
 * #1230 pour la langue.
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
 * **Un seul gabarit pour les deux langues**, et pour la même raison : deux
 * gabarits auraient divergé section par section. Pas un mot n'est écrit ici en
 * dur — ils viennent tous de `receipt-pdf.vocabulary.ts`, que le typage oblige à
 * rester complet dans chaque langue. Ce qui reste écrit dans le fichier est ce
 * qui n'est d'aucune langue : le signe « × » d'une quantité, les séparateurs, et
 * les données du salon elles-mêmes — son enseigne, ses mentions de pied, le
 * libellé de ses prestations, le motif d'un avoir. Ce sont des **saisies**, pas
 * des libellés, et les traduire reviendrait à réécrire ce que le salon a écrit.
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
  /**
   * La langue de la pièce — #1230.
   *
   * Résolue par `ReceiptPdfService` avant d'arriver ici : la langue demandée,
   * à défaut celle de l'établissement, à défaut celle du système. Le gabarit ne
   * choisit rien, il écrit dans la langue qu'on lui donne.
   */
  readonly locale: Locale;
}

/**
 * La nature de l'identifiant d'entreprise, en toutes lettres.
 *
 * Les quatre premières sont des **sigles de registre** — le SIRET français, le
 * NIF et le STAT malgaches —, c'est-à-dire des noms propres : ils ne se
 * traduisent pas plus que « IBAN ». Seule la nature générique suit la langue, et
 * elle vient du vocabulaire.
 */
const LEGAL_ID_REGISTRIES: Readonly<Record<LegalIdType, string | null>> = {
  SIRET: 'SIRET',
  SIREN: 'SIREN',
  NIF: 'NIF',
  STAT: 'STAT',
  OTHER: null,
};

function legalIdLabel(type: LegalIdType, words: ReceiptVocabulary): string {
  return LEGAL_ID_REGISTRIES[type] ?? words.legalIdOther;
}

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
function header(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
  words: ReceiptVocabulary,
): void {
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
    const nature =
      issuer.legalIdType === null ? words.legalIdUnknown : legalIdLabel(issuer.legalIdType, words);

    identifiers.push(`${nature} ${issuer.legalId}`);
  }

  if (issuer.vatNumber !== null) {
    identifiers.push(`${words.vatNumber} ${issuer.vatNumber}`);
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
  words: ReceiptVocabulary,
): void {
  const timezone = receipt.issuer.timezone;
  const locale = context.locale;
  const invoice = context.variant === 'a4';
  const numbered = context.receiptNumber !== null && receipt.issuedAt !== null;

  if (!numbered) {
    canvas.text(invoice ? words.proformaInvoice : words.provisionalTicket, {
      weight: 'bold',
      size: invoice ? 14 : 12,
      align: invoice ? 'left' : 'center',
    });
    canvas.text(words.notAnAccountingRecord, {
      align: invoice ? 'left' : 'center',
    });
    canvas.text(`${words.openedOn} ${formatDateTime(receipt.openedAt, timezone, locale)}`, {
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
    canvas.text(`${words.invoiceNumber} ${number}`, { weight: 'bold', size: 14 });
    canvas.text(`${words.dateLabel} ${formatDateTime(issuedAt, timezone, locale)}`);
  } else {
    canvas.text(number, { weight: 'bold', size: 12, align: 'center' });
    canvas.text(formatDateTime(issuedAt, timezone, locale), { align: 'center' });
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
function parties(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
  words: ReceiptVocabulary,
): void {
  if (context.variant === 'a4' && receipt.client !== null) {
    canvas.text(words.billedTo, { weight: 'bold' });
    canvas.text(receipt.client.displayName);
    canvas.gap(mm(2));
  }

  canvas.row(words.cashier, receipt.cashier.displayName);

  if (receipt.practitioner !== null) {
    canvas.row(words.practitioner, receipt.practitioner.displayName);
  }

  if (context.variant === 'ticket-80' && receipt.client !== null) {
    canvas.row(words.client, receipt.client.displayName);
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
function lines(canvas: ReceiptSurface, receipt: SaleReceipt, locale: Locale): void {
  for (const line of receipt.lines) {
    if (!SELLABLE_KINDS.includes(line.kind)) {
      continue;
    }

    // `line.label` est la saisie du salon — le nom de sa prestation. Il
    // s'imprime tel quel dans les deux langues : c'est une donnée, pas un
    // libellé (voir l'en-tête de ce fichier).
    canvas.row(line.label, formatMoney(line.lineAmount, locale), { weight: 'bold' });

    if (line.quantity !== 1) {
      canvas.text(`${line.quantity} × ${formatMoney(line.unitAmount, locale)}`, { indent: mm(3) });
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
function totals(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
  words: ReceiptVocabulary,
): void {
  const locale = context.locale;

  if (receipt.taxBreakdown.length > 0) {
    canvas.row(words.subtotalExcludingTax, formatMoney(receipt.subtotal, locale));

    for (const tax of receipt.taxBreakdown) {
      canvas.row(
        `${words.tax} ${formatTaxRate(tax.rateBps, locale)}`,
        formatMoney(tax.tax, locale),
        { indent: mm(3) },
      );
    }

    canvas.row(words.totalTax, formatMoney(receipt.taxTotal, locale));
    canvas.gap(mm(1));
  }

  if (receipt.tip.amountMinor !== 0) {
    canvas.row(words.tip, formatMoney(receipt.tip, locale));
  }

  canvas.rule();
  canvas.row(words.total, formatMoney(receipt.total, locale), {
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
function settlements(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  locale: Locale,
  words: ReceiptVocabulary,
): void {
  if (receipt.settlements.length === 0) {
    canvas.text(words.noSettlement);
    canvas.gap(mm(2));

    return;
  }

  for (const settlement of receipt.settlements) {
    canvas.row(
      // Le règlement entier, et non son seul `method` : c'est le **canal** qui
      // décide du libellé depuis #1027, et la référence du TPE ne se lit que
      // sur le canal qui peut en porter une.
      formatSettlementMethod(settlement, locale),
      formatMoney(settlement.amount, locale),
    );

    renderChange(canvas, settlement, locale, words);
  }

  canvas.gap(mm(2));
}

/** Le billet tendu et la monnaie rendue — espèces seulement. */
function renderChange(
  canvas: ReceiptSurface,
  settlement: ReceiptSettlement,
  locale: Locale,
  words: ReceiptVocabulary,
): void {
  if (settlement.tendered === null || settlement.change === null) {
    return;
  }

  canvas.row(words.tendered, formatMoney(settlement.tendered, locale), { indent: mm(3) });
  canvas.row(words.change, formatMoney(settlement.change, locale), { indent: mm(3) });
}

/** Les avoirs émis sur cette vente — le sixième critère de #818. */
function refunds(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
  words: ReceiptVocabulary,
): void {
  if (receipt.refunds.length === 0) {
    return;
  }

  const locale = context.locale;

  canvas.rule({ dashed: true });
  canvas.text(words.refunds, { weight: 'bold' });

  for (const refund of receipt.refunds) {
    // Le numéro d'avoir composé — `…-R1` — ne suit **pas** la langue : c'est
    // l'identifiant d'une pièce comptable, et le même avoir doit se retrouver
    // sous le même nom dans les deux langues.
    const label =
      context.receiptNumber === null
        ? `${words.refund} ${refund.rank}`
        : `${context.receiptNumber}-R${refund.rank}`;

    canvas.row(label, formatMoney(refund.amount, locale));
    canvas.text(formatDate(refund.issuedAt, receipt.issuer.timezone, locale), { indent: mm(3) });

    if (refund.reason !== null) {
      canvas.text(refund.reason, { indent: mm(3) });
    }
  }

  canvas.gap(mm(2));
}

/** Section 8 — mentions, remerciement, et le QR code du lien de réservation. */
function footer(
  canvas: ReceiptSurface,
  receipt: SaleReceipt,
  context: TemplateContext,
  words: ReceiptVocabulary,
): void {
  canvas.rule();

  if (receipt.issuer.footer !== null) {
    // Les mentions de pied sont saisies par le salon dans ses réglages : elles
    // s'impriment telles quelles, la langue du document n'ayant pas à réécrire
    // ce qu'un gérant a rédigé.
    canvas.text(receipt.issuer.footer, { size: 7, align: 'center', gapAfter: mm(2) });
  }

  canvas.text(words.thankYou, { weight: 'bold', align: 'center', gapAfter: mm(2) });
  // Le carré demandé porte le symbole **et** sa zone de silence (`ReceiptCanvas.qr`,
  // ISO/IEC 18004 §6.3.8) : les 6 mm de plus qu'avant sont cette marge, et non un
  // code plus gros — le module garde la taille qui se lit à 203 ppp.
  canvas.qr(qrMatrix(context.bookingUrl), context.variant === 'a4' ? mm(34) : mm(30));
  canvas.gap(mm(1.5));
  canvas.text(words.bookAgain, { size: 7, align: 'center' });
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
  // Résolu une fois pour tout le document : les huit sections écrivent dans la
  // même langue par construction, et non parce qu'elles pensent à la relire.
  const words = receiptVocabulary(context.locale);

  header(canvas, receipt, context, words);
  identification(canvas, receipt, context, words);
  parties(canvas, receipt, context, words);
  lines(canvas, receipt, context.locale);
  totals(canvas, receipt, context, words);
  settlements(canvas, receipt, context.locale, words);
  refunds(canvas, receipt, context, words);
  footer(canvas, receipt, context, words);
}
