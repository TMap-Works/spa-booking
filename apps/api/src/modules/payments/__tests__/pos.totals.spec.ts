import {
  MAX_SALE_AMOUNT_MINOR,
  TIP_LINE_LABEL,
  composeSale,
  fitsInAmountColumn,
  netOf,
  taxIncludedIn,
  taxLineLabel,
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
 *
 * Depuis #816, les prix du catalogue sont **TTC** et la taxe s'en extrait : ce
 * que cette suite exerce d'abord, c'est cette extraction et son arrondi.
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

describe('netOf / taxIncludedIn — la TVA extraite du prix TTC (#816, critère 1)', () => {
  it('rend l’exemple de l’issue : 65,00 € à 20 % donnent 54,17 € HT et 10,83 € de TVA', () => {
    // `arrondi(6500 × 10000 / 12000)` = `arrondi(5416,66…)` = 5417.
    expect(netOf(6500, 2000)).toBe(5417);
    expect(taxIncludedIn(6500, 2000)).toBe(1083);
  });

  it('ventile 89,00 € à 20 % en 74,17 € HT et 14,83 € de TVA', () => {
    // Le ticket du constat : une prestation à 65,00 € et un article à 24,00 €.
    expect(netOf(8900, 2000)).toBe(7417);
    expect(taxIncludedIn(8900, 2000)).toBe(1483);
  });

  it('laisse le prix intact à taux nul — septième critère de #816', () => {
    expect(netOf(8900, 0)).toBe(8900);
    expect(taxIncludedIn(8900, 0)).toBe(0);
  });

  it('refait exactement le prix affiché, quel que soit le taux', () => {
    // La propriété qui porte tout le reste : la taxe est obtenue **par
    // différence**, donc `ht + tva` ne peut pas s'écarter du TTC d'un centime —
    // c'est ce qui garantit qu'une cliente paie le prix qu'elle a lu.
    for (const taxRateBps of [0, 1, 550, 2000, 2100, 1755, 10_000]) {
      for (const grossAmountMinor of [0, 1, 99, 100, 333, 6500, 8900, 123_457]) {
        expect(netOf(grossAmountMinor, taxRateBps) + taxIncludedIn(grossAmountMinor, taxRateBps)).toBe(
          grossAmountMinor,
        );
      }
    }
  });

  it('arrondit au centime le plus proche, la demie au supérieur', () => {
    // 3 unités à 100 % : la part hors taxe vaut exactement 1,5 — la demie, qui
    // monte. C'est l'arrondi commercial usuel, et il est documenté comme tel
    // dans `roundedQuotient`.
    expect(netOf(3, 10_000)).toBe(2);
    expect(taxIncludedIn(3, 10_000)).toBe(1);
  });

  it('reste exact sur un dénominateur impair', () => {
    // `10 000 + 1` : la demie du dénominateur n'est pas un entier, et c'est
    // précisément le cas que `floor((2n + d) / 2d)` existe pour traiter.
    expect(netOf(10_001, 1)).toBe(10_000);
    expect(taxIncludedIn(10_001, 1)).toBe(1);
  });

  it('n’emploie que des entiers, et reste sûr jusqu’à la borne d’une colonne', () => {
    // `2 × ttc × 10^4` vaut ici ≈ 4,3 × 10^13, deux ordres de grandeur sous
    // `Number.MAX_SAFE_INTEGER` : aucun centime ne se déplace selon la taille du
    // ticket.
    const net = netOf(MAX_SALE_AMOUNT_MINOR, 2000);

    expect(Number.isSafeInteger(net)).toBe(true);
    expect(net + taxIncludedIn(MAX_SALE_AMOUNT_MINOR, 2000)).toBe(MAX_SALE_AMOUNT_MINOR);
  });
});

describe('taxLineLabel — la ligne de taxe dit qu’elle est comprise', () => {
  it('nomme le taux tel qu’il s’imprime sur un reçu français', () => {
    expect(taxLineLabel(2000)).toBe('dont TVA 20 %');
    expect(taxLineLabel(550)).toBe('dont TVA 5,5 %');
    expect(taxLineLabel(1755)).toBe('dont TVA 17,55 %');
    // Le zéro de tête compte : `2,05 %` et non `2,5 %`.
    expect(taxLineLabel(205)).toBe('dont TVA 2,05 %');
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
      label: 'dont TVA 20 %',
      quantity: 1,
      serviceId: null,
      productId: null,
    });
    expect(sale.items[2]).toMatchObject({ label: TIP_LINE_LABEL, quantity: 1 });
  });

  it('porte les prix affichés sur les lignes, et la taxe en **ventilation** — #816, critère 2', () => {
    // Le ticket du constat de l'issue : 65,00 € de prestation et 24,00 €
    // d'article, annoncés TTC. Ce que la cliente doit est 89,00 €, et non
    // 106,80 € comme avant #816.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [
        service({ unitPrice: { amountMinor: 6500, currency: EUR } }),
        product({ unitPrice: { amountMinor: 2400, currency: EUR } }),
      ],
      tipAmountMinor: 0,
    });

    // Les lignes de catalogue gardent le prix affiché, taxe comprise.
    expect(sale.items[0]?.lineAmount.amountMinor).toBe(6500);
    expect(sale.items[1]?.lineAmount.amountMinor).toBe(2400);
    // La ligne de taxe redécoupe ces montants ; elle ne s'y ajoute pas.
    expect(sale.items[2]).toMatchObject({
      kind: 'TAX',
      label: 'dont TVA 20 %',
      lineAmount: { amountMinor: 1483, currency: EUR },
    });

    expect(sale.subtotalAmountMinor).toBe(7417);
    expect(sale.taxAmountMinor).toBe(1483);
    expect(sale.totalAmountMinor).toBe(8900);
  });

  it('rend un total égal à la somme des prix affichés, plus le pourboire', () => {
    // Le deuxième critère de #816, écrit comme une égalité : le total ne dépend
    // plus du taux, seulement de ce qui a été annoncé.
    const items = [service({ quantity: 2 }), product({ quantity: 3 })];
    const displayed = 7000 * 2 + 1850 * 3;

    for (const taxRateBps of [0, 550, 2000, 10_000]) {
      const sale = composeSale({ currency: EUR, taxRateBps, items, tipAmountMinor: 777 });

      expect(sale.totalAmountMinor).toBe(displayed + 777);
      expect(sale.subtotalAmountMinor + sale.taxAmountMinor).toBe(displayed);
    }
  });

  it('laisse un établissement sans taxe totalement inchangé — #816, critère 7', () => {
    // Barber Tana : `tax_rate_bps` à zéro. Aucune ligne de taxe, un sous-total
    // qui vaut les prix affichés, un total qui vaut la somme.
    const sale = composeSale({
      currency: 'MGA',
      taxRateBps: 0,
      items: [service({ unitPrice: { amountMinor: 40_000, currency: 'MGA' } })],
      tipAmountMinor: 5000,
    });

    expect(sale.items.map((item) => item.kind)).toEqual(['SERVICE', 'TIP']);
    expect(sale.subtotalAmountMinor).toBe(40_000);
    expect(sale.taxAmountMinor).toBe(0);
    expect(sale.totalAmountMinor).toBe(45_000);
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

  it('extrait la taxe des seules lignes du catalogue, jamais du pourboire', () => {
    // Un pourboire n'est pas une prestation vendue : le taxer serait une erreur
    // comptable autant qu'un mauvais service rendu à qui l'a laissé. Il entre
    // donc au total sans passer par l'extraction.
    const sale = composeSale({
      currency: EUR,
      taxRateBps: 2000,
      items: [service()],
      tipAmountMinor: 10_000,
    });

    // 70,00 € TTC à 20 % : 58,33 € HT et 11,67 € de TVA.
    expect(sale.subtotalAmountMinor).toBe(5833);
    expect(sale.taxAmountMinor).toBe(1167);
    expect(sale.totalAmountMinor).toBe(7000 + 10_000);
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
