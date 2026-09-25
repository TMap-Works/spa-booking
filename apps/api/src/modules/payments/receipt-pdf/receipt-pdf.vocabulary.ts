import type { Locale } from '@spa/shared';

/**
 * Les mots et les conventions d'écriture de la pièce imprimée — #1230.
 *
 * ## Pourquoi une table, et pourquoi ici
 *
 * Le ticket 80 mm et la facture A4 sont **sérialisés par le serveur** : aucun
 * catalogue d'`apps/web/messages/` ne les atteint, et `next-intl` ne tourne pas
 * dans une tâche ECS. Les libellés d'un document produit par l'API vivent donc
 * dans le module qui le sert — même arbitrage que `report-export.vocabulary.ts`
 * chez `reporting` et que les tables `Readonly<Record<Locale, …>>` de
 * `notifications`.
 *
 * Ce ne sont pas non plus les mots de l'écran de caisse : `admin-checkout` écrit
 * « Client » au-dessus d'un champ de recherche, la pièce écrit « Facturé à »
 * au-dessus d'une identité facturée. Les deux catalogues décrivent deux surfaces.
 *
 * ## Ce que la langue décide, et ce qu'elle ne décide pas
 *
 * | Ce qui suit la langue | Ce qui n'en dépend jamais |
 * |---|---|
 * | les libellés et les mentions | les **montants**, entiers en plus petite unité monétaire |
 * | l'ordre et les séparateurs d'une date | le **fuseau** de l'établissement, qui dit de quel jour on parle |
 * | la place du symbole, le séparateur des milliers | le **code devise**, et le nombre de décimales qu'il impose |
 * | le cycle horaire — 24 h en français, 12 h en anglais | le numéro de pièce, composé par `receipt.numbering.ts` |
 *
 * Deux PDF de la même vente dans les deux langues portent donc **exactement les
 * mêmes valeurs**, écrites autrement. C'est ce que `receipt-pdf.template.spec.ts`
 * vérifie montant par montant.
 *
 * ## L'étiquette passée à `Intl` porte une région, la langue non
 *
 * `Locale` est délibérément sans variante régionale (`packages/shared/src/locale`)
 * — le produit sert deux langues, pas quatre marchés. Mais `Intl` a besoin d'une
 * région pour décider de l'ordre d'une date : `en` seul résout sur le défaut de
 * l'ICU embarquée, c'est-à-dire sur une valeur qui n'est écrite nulle part et qui
 * peut changer avec la version de Node. Une pièce comptable ne peut pas dépendre
 * de cela, d'où les deux étiquettes complètes ci-dessous.
 *
 * `en-US` et non `en-GB` : l'anglais du produit est nord-américain — c'est la
 * justification même de `DEFAULT_LOCALE` (#844), « la clientèle du produit est
 * nord-américaine ». La date s'y écrit donc `09/17/2026`, et l'heure en 12 heures.
 */

/** Ce qu'une langue décide de la pièce : ses conventions et ses mots. */
export interface ReceiptVocabulary {
  /** L'étiquette BCP 47 complète donnée à `Intl` — voir l'en-tête. */
  readonly intl: string;
  /** Le cycle horaire de l'heure imprimée : 24 h en français, 12 h en anglais. */
  readonly hourCycle: 'h12' | 'h23';
  /** Ce qui joint la date et l'heure — « 17/09/2026 à 11:30 ». */
  readonly at: string;

  /** En-tête — la nature d'un identifiant d'entreprise sans nature déclarée. */
  readonly legalIdOther: string;
  readonly legalIdUnknown: string;
  /** Le préfixe du numéro de TVA intracommunautaire. */
  readonly vatNumber: string;

  /** Identification — ce qu'une vente encore ouverte se déclare être. */
  readonly provisionalTicket: string;
  readonly proformaInvoice: string;
  readonly notAnAccountingRecord: string;
  /** Suivi de l'instant d'ouverture : « Ticket ouvert le 17/09/2026 à 11:00 ». */
  readonly openedOn: string;
  /** Suivi du numéro de pièce : « Facture n° TIC-2026-000123 ». */
  readonly invoiceNumber: string;
  /** Suivi de l'instant d'émission, deux-points compris. */
  readonly dateLabel: string;

  /** Les parties nommées sur la pièce. */
  readonly billedTo: string;
  readonly cashier: string;
  readonly practitioner: string;
  readonly client: string;

  /** Totaux et ventilation de la taxe. */
  readonly subtotalExcludingTax: string;
  /** Le préfixe d'une ligne de ventilation : « TVA 20 % ». */
  readonly tax: string;
  readonly totalTax: string;
  readonly tip: string;
  readonly total: string;

  /** Règlements et monnaie rendue. */
  readonly noSettlement: string;
  readonly tendered: string;
  readonly change: string;
  readonly cash: string;
  readonly cardTerminal: string;
  readonly cardOnline: string;
  /** Ce qui introduit la référence du ticket du TPE, tiret compris. */
  readonly terminalReferencePrefix: string;

  /** Avoirs. */
  readonly refunds: string;
  /** Suivi du rang de l'avoir, tant que la vente n'a pas de numéro. */
  readonly refund: string;

  /** Pied de page. */
  readonly thankYou: string;
  readonly bookAgain: string;

  /** Le nom du fichier servi, et le titre porté par les métadonnées du PDF. */
  readonly ticketFileStem: string;
  readonly invoiceFileStem: string;
  readonly documentTitle: string;
}

const FRENCH: ReceiptVocabulary = {
  intl: 'fr-FR',
  hourCycle: 'h23',
  at: 'à',

  legalIdOther: 'Immatriculation',
  legalIdUnknown: 'Identifiant',
  vatNumber: 'TVA',

  provisionalTicket: 'TICKET PROVISOIRE',
  proformaInvoice: 'FACTURE PROFORMA',
  notAnAccountingRecord: 'Vente non close — ce document n’est pas une pièce comptable.',
  openedOn: 'Ticket ouvert le',
  invoiceNumber: 'Facture n°',
  dateLabel: 'Date :',

  billedTo: 'Facturé à',
  cashier: 'Caissier',
  practitioner: 'Praticien',
  client: 'Cliente',

  subtotalExcludingTax: 'Total HT',
  tax: 'TVA',
  totalTax: 'Total TVA',
  tip: 'Pourboire',
  total: 'TOTAL',

  noSettlement: 'Aucun règlement enregistré.',
  tendered: 'Reçu',
  change: 'Rendu',
  cash: 'Espèces',
  cardTerminal: 'Carte bancaire (TPE)',
  cardOnline: 'Carte bancaire (en ligne)',
  terminalReferencePrefix: '— réf.',

  refunds: 'Avoirs',
  refund: 'Avoir',

  thankYou: 'Merci de votre visite !',
  bookAgain: 'Reprendre rendez-vous',

  ticketFileStem: 'ticket',
  invoiceFileStem: 'facture',
  documentTitle: 'Reçu',
};

const ENGLISH: ReceiptVocabulary = {
  intl: 'en-US',
  hourCycle: 'h12',
  at: 'at',

  legalIdOther: 'Registration no.',
  legalIdUnknown: 'Identifier',
  vatNumber: 'VAT',

  provisionalTicket: 'PROVISIONAL RECEIPT',
  proformaInvoice: 'PRO FORMA INVOICE',
  notAnAccountingRecord: 'Sale not closed — this document is not an accounting record.',
  openedOn: 'Sale opened on',
  invoiceNumber: 'Invoice no.',
  dateLabel: 'Date:',

  billedTo: 'Billed to',
  cashier: 'Cashier',
  practitioner: 'Practitioner',
  client: 'Client',

  subtotalExcludingTax: 'Subtotal excl. tax',
  tax: 'VAT',
  totalTax: 'Total VAT',
  tip: 'Tip',
  total: 'TOTAL',

  noSettlement: 'No payment recorded.',
  tendered: 'Tendered',
  change: 'Change',
  cash: 'Cash',
  cardTerminal: 'Card (terminal)',
  cardOnline: 'Card (online)',
  terminalReferencePrefix: '— ref.',

  refunds: 'Refunds',
  refund: 'Refund',

  thankYou: 'Thank you for your visit!',
  bookAgain: 'Book again',

  ticketFileStem: 'receipt',
  invoiceFileStem: 'invoice',
  documentTitle: 'Receipt',
};

/**
 * Les deux vocabulaires, par langue.
 *
 * Le typage `Readonly<Record<Locale, …>>` est ce qui tient la **parité** : une
 * troisième langue ajoutée à `LOCALES` sans sa table ne compilerait pas, et un
 * champ ajouté à l'interface sans sa traduction non plus. C'est une garantie du
 * compilateur, pas une consigne de relecture.
 */
const VOCABULARIES: Readonly<Record<Locale, ReceiptVocabulary>> = {
  fr: FRENCH,
  en: ENGLISH,
};

/**
 * Le vocabulaire d'une langue.
 *
 * La langue est déjà validée — par le DTO de la route, ou par la normalisation
 * de `tenants.default_locale` à la lecture. Le `?? ENGLISH` ne double donc pas
 * cette validation : il rend la fonction **totale**, pour qu'une langue ajoutée
 * au contrat sans sa table sorte dans la langue par défaut du système plutôt que
 * de faire tomber l'impression d'un ticket au comptoir.
 */
export function receiptVocabulary(locale: Locale): ReceiptVocabulary {
  return VOCABULARIES[locale] ?? ENGLISH;
}
