import {
  addMoney,
  type Locale,
  type Money,
  type ReceiptIssuer,
  type ReceiptLine,
  type ReceiptSettlement,
  type ReceiptTaxLine,
} from '@spa/shared';

import { CHECKOUT_FALLBACK_LOCALE, checkoutWords } from '@/lib/admin/checkout-summary';

/**
 * La mise en forme du ticket de caisse imprimé au comptoir — ce qui se décide
 * sans DOM, et se teste donc sans lui.
 *
 * Le ticket ne calcule **aucun** montant de la vente : total, taxe et assiette
 * viennent de l'API (`GET /sales/{id}/receipt`), qui les a figés à la clôture.
 * La seule addition faite ici est le TTC d'une ligne de la table de TVA —
 * assiette plus taxe, deux montants que l'API rend déjà —, pour la présenter
 * comme sur un ticket de grande surface : taux, HT, TVA, TTC.
 */

const LEGAL_ID_LABELS: Readonly<Record<NonNullable<ReceiptIssuer['legalIdType']>, string>> = {
  SIRET: 'SIRET',
  SIREN: 'SIREN',
  NIF: 'NIF',
  STAT: 'STAT',
  OTHER: 'Immatriculation',
};

/** « SIRET 123 456 789 00012 » — l'identifiant d'entreprise et sa nature. */
export function legalIdLine(issuer: ReceiptIssuer): string | null {
  if (issuer.legalId === undefined) {
    return null;
  }

  const nature =
    issuer.legalIdType === undefined ? 'Identifiant' : LEGAL_ID_LABELS[issuer.legalIdType];

  return `${nature} ${issuer.legalId}`;
}

/**
 * « 01 42 00 00 00 » — le téléphone stocké en E.164, tel qu'on l'écrit dans le
 * pays : un ticket se lit par la cliente, pas par un routeur SMS. Les deux pays
 * servis ont leur découpage (France, Madagascar) ; les autres gardent la forme
 * internationale, qui reste juste.
 */
export function formatReceiptPhone(phone: string): string {
  const france = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(phone);

  if (france !== null) {
    return `0${france.slice(1).join(' ')}`;
  }

  const madagascar = /^\+261(\d{2})(\d{2})(\d{3})(\d{2})$/.exec(phone);

  if (madagascar !== null) {
    return `0${madagascar.slice(1).join(' ')}`;
  }

  return phone;
}

/** Les lignes d'adresse du salon, dans l'ordre d'une enveloppe. */
export function issuerAddressLines(issuer: ReceiptIssuer): readonly string[] {
  const address = issuer.address;

  if (address === undefined) {
    return [];
  }

  const locality = [address.postalCode, address.city].filter(Boolean).join(' ');

  return [address.line1, address.line2, locality].filter(
    (line): line is string => line !== undefined && line.trim() !== '',
  );
}

/**
 * « 20 % », « 5,5 % » — un taux en points de base, jamais un flottant stocké.
 *
 * La division n'a lieu qu'à l'affichage : `550` points de base font 5,5 %, et
 * `Intl` écrit la virgule décimale française.
 */
export function formatTaxRate(rateBps: number): string {
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(rateBps / 100)} %`;
}

/** Une ligne de la table de TVA : taux, assiette HT, taxe, et leur somme TTC. */
export interface TaxTableRow {
  readonly rate: string;
  readonly base: Money;
  readonly tax: Money;
  readonly total: Money;
}

export function taxTableRows(breakdown: readonly ReceiptTaxLine[]): readonly TaxTableRow[] {
  return breakdown.map((line) => ({
    rate: formatTaxRate(line.rateBps),
    base: line.base,
    tax: line.tax,
    total: addMoney(line.base, line.tax),
  }));
}

/**
 * Les lignes **vendues** — prestations et produits.
 *
 * `TAX` n'en est pas une : c'est une ventilation des prix affichés, qui
 * s'entendent TTC, et l'imprimer parmi les articles la ferait lire comme un
 * supplément. `TIP` non plus : le pourboire a sa ligne sous le sous-total.
 */
export function soldLines(lines: readonly ReceiptLine[]): readonly ReceiptLine[] {
  return lines.filter((line) => line.kind === 'SERVICE' || line.kind === 'PRODUCT');
}

/**
 * Le moyen de règlement tel qu'il s'imprime — **sur le canal, jamais sur le
 * seul moyen** (#1217).
 *
 * ## Pourquoi `cardChannel` et non `method`
 *
 * Une carte peut être passée par deux tuyaux qui se rapprochent de deux relevés
 * différents : le TPE autonome du salon (`TERMINAL`, ADR 0015) et l'intention du
 * tunnel public (`STRIPE`). `method` ne distingue pas les deux — il dit `CARD`
 * dans les deux cas —, si bien qu'un libellé qui le lit seul envoie le
 * rapprochement de fin de journée chercher sur le relevé du TPE une ligne
 * Stripe qui n'y est pas. Le PDF le sait depuis #1027 ; l'écran ne le savait
 * pas, et c'est exactement le bug de ce ticket : deux rendus de la même pièce
 * qui ne portaient pas la même mention.
 *
 * La `terminalReference` seule n'aurait pas suffi à trancher : elle est
 * facultative, et un passage au terminal dont le caissier n'a rien relevé
 * resterait indiscernable d'une carte en ligne.
 *
 * ## Le canal nul est une carte **en ligne**
 *
 * `null` — ou absent — sur une carte ne peut désigner qu'un règlement antérieur
 * à #834, que la migration n'a pas repris. Le TPE n'existait pas alors : une
 * telle carte ne peut être qu'une intention Stripe, et s'imprime donc comme une
 * carte en ligne. La nommer « TPE » inventerait un passage au terminal qui n'a
 * jamais eu lieu — c'est le sens de la comparaison `!== 'TERMINAL'`, qui range
 * le nul du bon côté sans avoir à l'énumérer.
 *
 * ## Le même mot que le PDF, et une seule écriture
 *
 * La logique est celle de `formatSettlementMethod`
 * (`apps/api/src/modules/payments/receipt-pdf/receipt-pdf.format.ts`), au cas
 * près : c'est la même pièce, elle ne peut pas se lire autrement à l'écran et
 * sur le papier. Les mots, eux, viennent du catalogue `admin-checkout` — lu par
 * `checkoutWords`, comme le fait déjà tout le comptoir — et non de ce fichier :
 * le produit sert l'anglais par défaut et le français en option, et un libellé
 * écrit en dur ici serait la seule ligne du ticket que la traduction ne pourrait
 * pas atteindre. `method.cash` et `method.card` sont **ceux que le sélecteur de
 * moyen affiche déjà** ; seul « en ligne » manquait, parce que le comptoir ne le
 * propose pas.
 *
 * Aucune donnée de carte n'entre ici : ni marque, ni porteur, ni chiffre. Le
 * canal est le nom d'un tuyau, et la référence est le numéro d'opération que le
 * terminal imprime — du même rang qu'un `pi_…` (payments-stripe §1).
 *
 * `locale` a le défaut du comptoir, `fr`, pour la raison qui vaut déjà pour
 * `lib/appointment-status.ts` : le composant qui appelle cette fonction
 * (`admin/components/receipt-ticket.tsx`) n'est pas encore branché sur la langue
 * résolue, et le reste de son rouleau est en français. Basculer cette seule
 * ligne en anglais ferait un ticket bilingue. Le jour où l'écran passe à
 * l'épique #843, il passera la langue et le défaut tombera.
 */
export function settlementLabel(
  settlement: Pick<ReceiptSettlement, 'method' | 'cardChannel' | 'terminalReference'>,
  locale: Locale = CHECKOUT_FALLBACK_LOCALE,
): string {
  const words = checkoutWords(locale);

  if (settlement.method === 'CASH') {
    return words.method.cash;
  }

  if (settlement.cardChannel !== 'TERMINAL') {
    return words.method.cardOnline;
  }

  const label = words.method.card;
  const reference = settlement.terminalReference;

  // Le contrat partagé **omet** la clé quand la colonne est nulle
  // (`receiptSettlementSchema`, `z.string().optional()`), là où l'API la porte
  // en `string | null` : les deux formes se lisent « rien à citer », et une
  // référence blanche n'a rien à accoler non plus.
  if (reference === undefined || reference.trim() === '') {
    return label;
  }

  // Les deux valeurs sont rendues par une **fonction** et non par une chaîne :
  // `replaceAll` interprète `$&`, `` $` ``, `$'` et `$1` dans une chaîne de
  // remplacement, et la référence du terminal est une donnée relue, non bornée
  // en lecture par le contrat (`receiptSettlementSchema`, `z.string()` — une
  // reprise de données ou un import peut en porter n'importe quelle ponctuation).
  // Un `A$&B` s'imprimerait alors dédoublé, là où le PDF, qui compose par
  // littéral gabarit, le recopie tel quel.
  return words.receipt.settlementReference
    .replaceAll('{method}', () => label)
    .replaceAll('{reference}', () => reference);
}
