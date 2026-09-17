import type { ComposedSale, PricedCatalogItem, SaleItemDraft } from './pos.types';

/**
 * La composition d'un ticket — **le seul endroit qui calcule un total** (#60).
 *
 * Une fonction pure : ni Nest, ni Prisma, ni HTTP. C'est ce qui la rend
 * exerçable ligne par ligne dans la suite unitaire, sans base ni serveur — et
 * le calcul d'argent est exactement le genre de code dont on veut cette
 * couverture-là (CLAUDE.md, « unitaires : logique métier pure … montants »).
 *
 * ## Le prix du catalogue est un prix **TTC** (#816)
 *
 * C'est la correction que ce fichier porte, et elle change le sens de deux de
 * ses quatre montants. Jusqu'à #816, la taxe était **ajoutée** au sous-total :
 * un soin annoncé 65,00 € dans le tunnel se facturait 78,00 € à la caisse, et le
 * même rendez-vous réglé au comptoir n'encaissait que 65,00 € — la même
 * prestation avait deux prix selon le chemin d'encaissement.
 *
 * En France, un prix annoncé au consommateur s'entend toutes taxes comprises
 * (arrêté du 3 décembre 1987 relatif à l'information du consommateur sur les
 * prix). Le prix du catalogue est donc le prix **dû**, et la TVA s'en
 * **extrait** :
 *
 * ```
 * ht  = arrondi(ttc × 10 000 / (10 000 + taux))
 * tva = ttc − ht
 * ```
 *
 * 65,00 € à 20 % donnent 54,17 € HT et 10,83 € de TVA, dont la somme fait
 * exactement les 65,00 € affichés. Ce qu'un ticket additionne n'a pas changé de
 * forme — `total = sous-total + taxe + pourboire` reste vrai, et
 * `sales_total_amount_minor_check` le vérifie en base — mais `sous-total` est
 * désormais le **montant hors taxe**, et non plus la somme des prix affichés.
 *
 * ## Les trois invariants qu'elle tient
 *
 * 1. **Aucun montant ne vient de l'appelant, sauf le pourboire.** Les prix
 *    unitaires arrivent déjà résolus au catalogue par le service ; cette
 *    fonction n'a aucun paramètre par lequel un prix envoyé par le front
 *    pourrait entrer. Le pourboire est la seule exception, et il n'en est une
 *    que parce qu'il n'existe dans aucune table à relire.
 * 2. **Rien n'est calculé en flottant.** Tout est entier, dans la plus petite
 *    unité monétaire, et le taux de taxe est en points de base pour que les
 *    deux divisions du calcul restent entières (payments-stripe §5).
 * 3. **La taxe reste une ligne**, jamais un montant fondu dans un prix
 *    (payments-stripe §5, cinquième critère de #60) — mais c'est désormais une
 *    ligne de **ventilation**, « dont TVA 20 % », et non plus un montant ajouté.
 */

/** Le dénominateur des points de base : `2000 bps` valent 20 %. */
const BPS_DENOMINATOR = 10_000;

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

/** Libellé de la ligne de pourboire, tel qu'il apparaît sur le reçu. */
export const TIP_LINE_LABEL = 'Pourboire';

/**
 * Le taux en toutes lettres — `2000` bps donnent `« 20 »`, `550` donnent
 * `« 5,5 »`.
 *
 * Écrit en arithmétique entière comme tout le reste de ce fichier, alors qu'un
 * libellé n'aurait rien fait perdre en passant par un flottant : `bps / 100`
 * rendrait `17.549999999999997` sur un taux de 1755, et un reçu qui affiche un
 * taux faux se lit comme un reçu qui affiche un montant faux.
 *
 * Virgule décimale et non point : c'est un libellé français, imprimé tel quel.
 */
function formatTaxRate(taxRateBps: number): string {
  const units = Math.floor(taxRateBps / 100);
  const hundredths = taxRateBps % 100;

  if (hundredths === 0) {
    return String(units);
  }

  // `5,5 %` et non `5,50 %` — mais `2,05 %` garde son zéro de tête, sans quoi il
  // se lirait `2,5 %`.
  const decimals =
    hundredths % 10 === 0 ? String(hundredths / 10) : String(hundredths).padStart(2, '0');

  return `${units},${decimals}`;
}

/**
 * Le libellé de la ligne de taxe — **une ventilation**, pas un supplément (#816).
 *
 * « dont TVA 20 % » dit ce que la ligne est : la part de taxe **déjà comprise**
 * dans les prix au-dessus. L'ancien libellé, « Taxe », se lisait comme une ligne
 * de plus à payer — ce qu'elle était, et ce qui était le bug.
 */
export function taxLineLabel(taxRateBps: number): string {
  return `dont TVA ${formatTaxRate(taxRateBps)} %`;
}

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
 * `arrondi(numérateur / dénominateur)` au plus proche, la demie au supérieur,
 * **sans jamais former le quotient fractionnaire**.
 *
 * `floor((2n + d) / 2d)` plutôt que `floor((n + d/2) / d)` : `d` vaut ici
 * `10 000 + taux` et peut être **impair** — un taux de 1 point de base suffit —,
 * auquel cas `d / 2` n'est pas un entier et l'arrondi partirait d'un demi-centime
 * décalé. Doubler les deux termes garde chaque étape entière, quel que soit le
 * taux.
 *
 * ## Pourquoi la demie monte, et ce que cela coûte
 *
 * C'est l'arrondi commercial usuel, celui de l'administration fiscale française
 * comme celui que le tunnel affiche. Il fait pencher la part **hors taxe** d'un
 * demi-centime au maximum, jamais le total : la taxe étant obtenue par
 * différence (`ttc − ht`), le prix que la cliente paie reste au centime près
 * celui qui lui a été annoncé — l'écart d'arrondi ne se déplace qu'entre les
 * deux parts d'un montant qui, lui, ne bouge pas.
 *
 * ## Pourquoi il n'y a pas de dépassement
 *
 * `2 × n` vaut au plus `2 × 2^31 × 10^4 ≈ 4,3 × 10^13`, soit deux ordres de
 * grandeur sous `Number.MAX_SAFE_INTEGER` (≈ 9 × 10^15) : le calcul est exact,
 * et le reste pour n'importe quel ticket qu'une colonne `INTEGER` accepte.
 */
function roundedQuotient(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

/**
 * La part **hors taxe** d'un prix toutes taxes comprises, au centime le plus
 * proche — `ht = arrondi(ttc × 10 000 / (10 000 + taux))` (#816, critère 1).
 *
 * 65,00 € à 20 % rendent 54,17 € : `arrondi(6500 × 10000 / 12000)` vaut
 * `arrondi(5416,66…)`, donc `5417`.
 *
 * Le court-circuit à taux nul n'est pas qu'une économie : il rend littéral le
 * septième critère de #816 — un établissement sans taux garde des totaux
 * inchangés, et le prix affiché *est* le montant hors taxe.
 */
export function netOf(grossAmountMinor: number, taxRateBps: number): number {
  if (taxRateBps === 0) {
    return grossAmountMinor;
  }

  return roundedQuotient(grossAmountMinor * BPS_DENOMINATOR, BPS_DENOMINATOR + taxRateBps);
}

/**
 * La taxe **comprise dans** un prix toutes taxes comprises — `tva = ttc − ht`.
 *
 * Obtenue par différence et non par un second arrondi : c'est ce qui garantit
 * que `ht + tva` refait exactement le prix affiché, quel que soit le taux. Un
 * `arrondi(ttc × taux / (10 000 + taux))` calculé séparément pourrait, lui,
 * rendre un centime de trop ou de moins.
 */
export function taxIncludedIn(grossAmountMinor: number, taxRateBps: number): number {
  return grossAmountMinor - netOf(grossAmountMinor, taxRateBps);
}

/**
 * Compose le ticket définitif : les lignes, leur ordre, et les quatre montants.
 *
 * ## Ce que chaque montant veut dire (#816, critère 3)
 *
 * | Montant | Ce qu'il porte |
 * |---|---|
 * | `subtotalAmountMinor` | la part **hors taxe** des lignes du catalogue |
 * | `taxAmountMinor` | la taxe **comprise dans** les prix affichés |
 * | `tipAmountMinor` | le pourboire, hors taxe par nature |
 * | `totalAmountMinor` | ce que la cliente doit : `sous-total + taxe + pourboire`, c'est-à-dire la somme des prix affichés plus le pourboire |
 *
 * Le pourboire n'est **pas** taxé, et n'entre donc dans aucune extraction : ce
 * n'est pas une prestation vendue, le taxer serait une erreur comptable autant
 * qu'un mauvais service rendu à la personne qui l'a laissé.
 *
 * ## Ce que la somme des lignes vaut, et ce qu'elle ne vaut pas
 *
 * Les lignes `SERVICE` et `PRODUCT` portent des prix **TTC** — ceux du
 * catalogue, ceux du reçu. La ligne `TAX` en est la ventilation : elle
 * **redécoupe** ces montants, elle ne s'y ajoute pas. Additionner les
 * `lineAmount` d'un ticket compterait donc la taxe deux fois, et ne donne pas le
 * total. Le total est `totalAmountMinor`, écrit par le serveur et vérifié en
 * base — c'est déjà la règle que le front suit (`saleTotalRows` ne somme rien).
 *
 * Les lignes `TAX` et `TIP` ne sont composées que si elles portent quelque
 * chose. Un ticket sans taxe et sans pourboire n'a donc que ses articles — deux
 * lignes à zéro n'auraient rien dit et se seraient lues comme une anomalie sur
 * le reçu.
 */
export function composeSale(input: SaleComposition): ComposedSale {
  const items: SaleItemDraft[] = [];
  let position = 0;

  /**
   * La somme des prix **affichés** — ce que la cliente a lu dans le tunnel ou
   * au comptoir, taxe comprise. C'est de ce montant que la taxe s'extrait, et
   * c'est lui qu'on retrouve au centime près dans le total.
   */
  let grossAmountMinor = 0;

  for (const item of input.items) {
    const lineAmountMinor = item.unitPrice.amountMinor * item.quantity;
    grossAmountMinor += lineAmountMinor;

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

  const subtotalAmountMinor = netOf(grossAmountMinor, input.taxRateBps);
  // Par différence, jamais par un second arrondi : `sous-total + taxe` doit
  // refaire exactement la somme des prix affichés.
  const taxAmountMinor = grossAmountMinor - subtotalAmountMinor;
  const tipAmountMinor = input.tipAmountMinor;

  const composed: Record<(typeof COMPOSED_LINE_ORDER)[number], { amount: number; label: string }> =
    {
      TAX: { amount: taxAmountMinor, label: taxLineLabel(input.taxRateBps) },
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
    // `grossAmountMinor + tipAmountMinor` écrit autrement : la taxe étant
    // extraite, `sous-total + taxe` **est** la somme des prix affichés. La forme
    // est gardée parce que c'est celle que `sales_total_amount_minor_check`
    // vérifie en base.
    totalAmountMinor: subtotalAmountMinor + taxAmountMinor + tipAmountMinor,
    items,
  };
}
