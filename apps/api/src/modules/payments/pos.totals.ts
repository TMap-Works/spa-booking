import type { ComposedSale, PricedCatalogItem, SaleItemDraft } from './pos.types';

/**
 * La composition d'un ticket — **le seul endroit qui calcule un total** (#60).
 *
 * Une fonction pure : ni Nest, ni Prisma, ni HTTP. C'est ce qui la rend
 * exerçable ligne par ligne dans la suite unitaire, sans base ni serveur — et
 * le calcul d'argent est exactement le genre de code dont on veut cette
 * couverture-là (CLAUDE.md, « unitaires : logique métier pure … montants »).
 *
 * ## Les trois invariants qu'elle tient
 *
 * 1. **Aucun montant ne vient de l'appelant, sauf le pourboire.** Les prix
 *    unitaires arrivent déjà résolus au catalogue par le service ; cette
 *    fonction n'a aucun paramètre par lequel un prix envoyé par le front
 *    pourrait entrer. Le pourboire est la seule exception, et il n'en est une
 *    que parce qu'il n'existe dans aucune table à relire.
 * 2. **Rien n'est calculé en flottant.** Tout est entier, dans la plus petite
 *    unité monétaire, et le taux de taxe est en points de base pour que la
 *    seule division du calcul reste entière (payments-stripe §5).
 * 3. **Taxes et pourboires sont des lignes**, jamais des colonnes fondues dans
 *    un prix — cinquième critère de #60, et payments-stripe §5.
 */

/** Le dénominateur des points de base : `2000 bps` valent 20 %. */
const BPS_DENOMINATOR = 10_000;

/**
 * Moitié du dénominateur, pour un arrondi au centime le plus proche.
 *
 * `floor((base × taux + 5000) / 10000)` est l'arrondi arithmétique classique
 * écrit en entiers : il évite `Math.round`, qui aurait exigé de passer par un
 * quotient fractionnaire — donc par le seul type que ce chemin n'admet pas.
 */
const BPS_ROUNDING_OFFSET = BPS_DENOMINATOR / 2;

/**
 * Rang des deux lignes composées par le serveur, relativement aux lignes du
 * catalogue : la taxe d'abord, le pourboire ensuite. C'est l'ordre d'un reçu, et
 * il est stable parce que `position` est écrite en base.
 */
const COMPOSED_LINE_ORDER = ['TAX', 'TIP'] as const;

/**
 * Borne haute d'un montant du schéma — les colonnes sont des entiers 32 bits
 * signés.
 *
 * Elle est vérifiée ici plutôt que laissée à PostgreSQL parce qu'un dépassement
 * y sortirait en erreur de type, donc en 500 : le service veut un refus que le
 * front sait lire.
 */
export const MAX_SALE_AMOUNT_MINOR = 2_147_483_647;

/** Libellés des deux lignes composées, tels qu'ils apparaissent sur le reçu. */
export const TAX_LINE_LABEL = 'Taxe';
export const TIP_LINE_LABEL = 'Pourboire';

export interface SaleComposition {
  /** La devise de l'établissement — celle du ticket entier. */
  readonly currency: string;
  /** Le taux de taxe de l'établissement, en points de base. */
  readonly taxRateBps: number;
  /** Les articles déjà résolus au catalogue, dans l'ordre du comptoir. */
  readonly items: readonly PricedCatalogItem[];
  /** Le pourboire laissé, `0` s'il n'y en a pas. */
  readonly tipAmountMinor: number;
}

/**
 * `true` si le ticket tient dans les bornes des colonnes de montant.
 *
 * Rendu séparément plutôt que levé ici : `composeSale` est une fonction pure du
 * domaine, et lever une erreur de domaine depuis un calcul l'aurait couplée à
 * la table des statuts HTTP. C'est le service qui décide de la conduite.
 */
export function fitsInAmountColumn(sale: ComposedSale): boolean {
  return (
    sale.subtotalAmountMinor <= MAX_SALE_AMOUNT_MINOR &&
    sale.taxAmountMinor <= MAX_SALE_AMOUNT_MINOR &&
    sale.tipAmountMinor <= MAX_SALE_AMOUNT_MINOR &&
    sale.totalAmountMinor <= MAX_SALE_AMOUNT_MINOR &&
    sale.items.every((item) => item.lineAmount.amountMinor <= MAX_SALE_AMOUNT_MINOR)
  );
}

/**
 * La taxe due sur une base hors taxe, au centime le plus proche.
 *
 * Le produit `base × taux` peut atteindre `2^31 × 10^4 ≈ 2,1 × 10^13`, très en
 * deçà de `Number.MAX_SAFE_INTEGER` : le calcul reste exact en entiers, sans
 * qu'aucune étape ne passe par une valeur fractionnaire.
 */
export function taxOn(baseAmountMinor: number, taxRateBps: number): number {
  if (taxRateBps === 0) {
    return 0;
  }

  return Math.floor((baseAmountMinor * taxRateBps + BPS_ROUNDING_OFFSET) / BPS_DENOMINATOR);
}

/**
 * Compose le ticket définitif : les lignes, leur ordre, et les quatre montants.
 *
 * La taxe porte sur le **sous-total hors pourboire**, et non sur le total : un
 * pourboire n'est pas une prestation vendue, le taxer serait une erreur
 * comptable autant qu'un mauvais service rendu à la personne qui l'a laissé.
 *
 * Les lignes `TAX` et `TIP` ne sont composées que si elles portent quelque
 * chose. Un ticket sans taxe et sans pourboire n'a donc que ses articles — deux
 * lignes à zéro n'auraient rien dit et se seraient lues comme une anomalie sur
 * le reçu.
 */
export function composeSale(input: SaleComposition): ComposedSale {
  const items: SaleItemDraft[] = [];
  let position = 0;
  let subtotalAmountMinor = 0;

  for (const item of input.items) {
    const lineAmountMinor = item.unitPrice.amountMinor * item.quantity;
    subtotalAmountMinor += lineAmountMinor;

    items.push({
      kind: item.kind,
      // La référence est portée par le champ de sa nature, et l'autre reste
      // nul : c'est ce que `sale_items_reference_check` impose en base.
      serviceId: item.kind === 'SERVICE' ? item.referenceId : null,
      productId: item.kind === 'PRODUCT' ? item.referenceId : null,
      label: item.label,
      quantity: item.quantity,
      unitAmount: { amountMinor: item.unitPrice.amountMinor, currency: input.currency },
      lineAmount: { amountMinor: lineAmountMinor, currency: input.currency },
      position,
    });

    position += 1;
  }

  const taxAmountMinor = taxOn(subtotalAmountMinor, input.taxRateBps);
  const tipAmountMinor = input.tipAmountMinor;

  const composed: Record<(typeof COMPOSED_LINE_ORDER)[number], { amount: number; label: string }> =
    {
      TAX: { amount: taxAmountMinor, label: TAX_LINE_LABEL },
      TIP: { amount: tipAmountMinor, label: TIP_LINE_LABEL },
    };

  for (const kind of COMPOSED_LINE_ORDER) {
    const line = composed[kind];

    if (line.amount === 0) {
      continue;
    }

    items.push({
      kind,
      serviceId: null,
      productId: null,
      label: line.label,
      // `1` et non `0` : une ligne de quantité nulle se lirait comme une erreur
      // de saisie, et `sale_items_quantity_check` la refuse de toute façon.
      quantity: 1,
      unitAmount: { amountMinor: line.amount, currency: input.currency },
      lineAmount: { amountMinor: line.amount, currency: input.currency },
      position,
    });

    position += 1;
  }

  return {
    currency: input.currency,
    subtotalAmountMinor,
    taxAmountMinor,
    tipAmountMinor,
    totalAmountMinor: subtotalAmountMinor + taxAmountMinor + tipAmountMinor,
    items,
  };
}
