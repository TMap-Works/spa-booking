import {
  addMoney,
  type Money,
  type ReceiptIssuer,
  type ReceiptLine,
  type ReceiptSettlement,
  type ReceiptTaxLine,
} from '@spa/shared';

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

/** Le moyen de règlement tel qu'il s'imprime. */
export function settlementLabel(settlement: ReceiptSettlement): string {
  return settlement.method === 'CASH' ? 'Espèces' : 'Carte bancaire';
}
