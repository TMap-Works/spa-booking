import {
  MAX_SALE_AMOUNT_MINOR,
  TAX_LINE_LABEL,
  TIP_LINE_LABEL,
  composeSale,
  fitsInAmountColumn,
  taxOn,
} from '../pos.totals';
import type { PricedCatalogItem } from '../pos.types';

/**
 * Le calcul du ticket — la logique métier pure que CLAUDE.md range explicitement
 * dans les tests unitaires (« calcul de créneaux, règles d'annulation,
 * **montants** »).
 *
 * Aucune base, aucun serveur, aucun double : `composeSale` est une fonction, et
 * c'est précisément ce qui rend le calcul d'argent exerçable centime par
 * centime.
 */

const EUR = 'EUR';

function service(overrides: Partial<PricedCatalogItem> = {}): PricedCatalogItem {
  return {
    kind: 'SERVICE',
    referenceId: '11111111-1111-4111-8111-111111111111',
    label: 'Massage 60 min',
    unitPrice: { amountMinor: 7000, currency: EUR },
    quantity: 1,
    ...overrides,
  };
}

function product(overrides: Partial<PricedCatalogItem> = {}): PricedCatalogItem {
  return {
    kind: 'PRODUCT',
    referenceId: '22222222-2222-4222-8222-222222222222',
    label: 'Shampoing hydratant 250 ml',
    unitPrice: { amountMinor: 1850, currency: EUR },
    quantity: 1,
    ...overrides,
  };
}

describe('taxOn — la taxe en points de base', () => {
  it('ne compose rien à taux nul', () => {
    expect(taxOn(10_000, 0)).toBe(0);
  });

  it('applique un taux entier exactement', () => {
    // 20 % de 100,00 € = 20,00 €.
    expect(taxOn(10_000, 2000)).toBe(2000);
  });

  it('arrondit au centime le plus proche, sans jamais passer par un flottant', () => {
    // 5,5 % de 3,33 € vaut 0,18315 € : le centime le plus proche est 18.
    expect(taxOn(333, 550)).toBe(18);
    // 5,5 % de 1,00 € vaut 0,055 € — la demie exacte, arrondie au supérieur.
    expect(taxOn(100, 550)).toBe(6);
  });

  it('reste exact sur une base proche de la borne d’une colonne', () => {
    // Le produit `base × taux` vaut ici ≈ 2,1 × 10^13, très en deçà de
    // `Number.MAX_SAFE_INTEGER` : aucune perte de précision, donc aucun centime
    // qui se déplacerait selon la taille du ticket.
    expect(Number.isSafeInteger(taxOn(MAX_SALE_AMOUNT_MINOR, 10_000))).toBe(true);
    expect(taxOn(MAX_SALE_AMOUNT_MINOR, 10_000)).toBe(MAX_SALE_AMOUNT_MINOR);
  });
});

describe('composeSale — le ticket composé côté serveur', () => {
  it('somme les lignes du catalogue en sous-total', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service(), product({ quantity: 2 })],
      tipAmountMinor: 0,
    });

    expect(sale.subtotalAmountMinor).toBe(7000 + 1850 * 2);
    expect(sale.totalAmountMinor).toBe(sale.subtotalAmountMinor);
  });

  it('multiplie le prix unitaire par la quantité sur chaque ligne', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [product({ quantity: 3 })],
      tipAmountMinor: 0,
    });

    const [line] = sale.items;
    expect(line?.unitAmount.amountMinor).toBe(1850);
    expect(line?.quantity).toBe(3);
    expect(line?.lineAmount.amountMinor).toBe(5550);
  });

  it('regroupe services et produits sur un même ticket — premier critère de #60', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service(), product()],
      tipAmountMinor: 0,
    });

    expect(sale.items.map((item) => item.kind)).toEqual(['SERVICE', 'PRODUCT']);
  });

  it('porte la référence dans le champ de sa nature, et laisse l’autre nulle', () => {
    // C'est ce que `sale_items_reference_check` impose en base : une ligne
    // `SERVICE` ne référence pas d'article, et réciproquement.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service(), product()],
      tipAmountMinor: 0,
    });

    expect(sale.items[0]).toMatchObject({
      serviceId: '11111111-1111-4111-8111-111111111111',
      productId: null,
    });
    expect(sale.items[1]).toMatchObject({
      serviceId: null,
      productId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('compose taxe et pourboire en **lignes distinctes** — cinquième critère de #60', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [service()],
      tipAmountMinor: 500,
    });

    expect(sale.items.map((item) => item.kind)).toEqual(['SERVICE', 'TAX', 'TIP']);
    expect(sale.items[1]).toMatchObject({
      label: TAX_LINE_LABEL,
      quantity: 1,
      serviceId: null,
      productId: null,
    });
    expect(sale.items[2]).toMatchObject({ label: TIP_LINE_LABEL, quantity: 1 });
  });

  it('n’ajoute aucune ligne pour une taxe ou un pourboire nuls', () => {
    // Deux lignes à zéro se liraient comme une anomalie sur le reçu.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service()],
      tipAmountMinor: 0,
    });

    expect(sale.items).toHaveLength(1);
    expect(sale.taxAmountMinor).toBe(0);
    expect(sale.tipAmountMinor).toBe(0);
  });

  it('assoit la taxe sur le sous-total, jamais sur le pourboire', () => {
    // Un pourboire n'est pas une prestation vendue : le taxer serait une erreur
    // comptable autant qu'un mauvais service rendu à qui l'a laissé.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [service()],
      tipAmountMinor: 10_000,
    });

    expect(sale.taxAmountMinor).toBe(1400);
    expect(sale.totalAmountMinor).toBe(7000 + 1400 + 10_000);
  });

  it('numérote les lignes dans l’ordre du comptoir, taxe et pourboire en queue', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [product(), service()],
      tipAmountMinor: 300,
    });

    expect(sale.items.map((item) => item.position)).toEqual([0, 1, 2, 3]);
  });

  it('libelle chaque montant dans la devise de l’établissement, sans exception', () => {
    const sale = composeSale({
      currency: 'MGA',
      taxRateBps: 2000,
      items: [service()],
      tipAmountMinor: 1000,
    });

    expect(sale.currency).toBe('MGA');
    for (const item of sale.items) {
      expect(item.unitAmount.currency).toBe('MGA');
      expect(item.lineAmount.currency).toBe('MGA');
    }
  });

  it('rend un total qui somme exactement ses trois parts', () => {
    // La même égalité que `sales_total_amount_minor_check` vérifie en base : le
    // calcul et la contrainte disent la même chose, et c'est voulu.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 550,
      items: [service({ quantity: 2 }), product({ quantity: 3 })],
      tipAmountMinor: 777,
    });

    expect(sale.totalAmountMinor).toBe(
      sale.subtotalAmountMinor + sale.taxAmountMinor + sale.tipAmountMinor,
    );
  });

  it('n’emploie que des entiers, à chaque montant rendu', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 550,
      items: [service({ unitPrice: { amountMinor: 333, currency: EUR }, quantity: 7 })],
      tipAmountMinor: 111,
    });

    const amounts = [
      sale.subtotalAmountMinor,
      sale.taxAmountMinor,
      sale.tipAmountMinor,
      sale.totalAmountMinor,
      ...sale.items.flatMap((item) => [item.unitAmount.amountMinor, item.lineAmount.amountMinor]),
    ];

    for (const amount of amounts) {
      expect(Number.isInteger(amount)).toBe(true);
    }
  });
});

describe('fitsInAmountColumn — la borne des colonnes de montant', () => {
  it('accepte un ticket ordinaire', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [service(), product({ quantity: 2 })],
      tipAmountMinor: 500,
    });

    expect(fitsInAmountColumn(sale)).toBe(true);
  });

  it('refuse un ticket dont une ligne dépasse ce qu’une colonne peut porter', () => {
    // Cent lignes de mille unités à un prix quelconque y suffisent, et rien dans
    // le corps de la requête ne coûte cher à fabriquer : la borne est vérifiée
    // avant l'écriture pour que le refus soit celui que le front sait lire, et
    // non l'erreur de type que PostgreSQL rendrait en 500.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service({ unitPrice: { amountMinor: 3_000_000, currency: EUR }, quantity: 1000 })],
      tipAmountMinor: 0,
    });

    expect(sale.items[0]?.lineAmount.amountMinor).toBeGreaterThan(MAX_SALE_AMOUNT_MINOR);
    expect(fitsInAmountColumn(sale)).toBe(false);
  });

  it('refuse un ticket dont seul le total déborde', () => {
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 0,
      items: [service({ unitPrice: { amountMinor: MAX_SALE_AMOUNT_MINOR, currency: EUR } })],
      tipAmountMinor: 1,
    });

    expect(sale.subtotalAmountMinor).toBe(MAX_SALE_AMOUNT_MINOR);
    expect(fitsInAmountColumn(sale)).toBe(false);
  });
});
