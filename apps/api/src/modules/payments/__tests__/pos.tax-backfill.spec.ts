import { auditSaleTax, legacyTaxOn, type SaleTaxFacts } from '../pos.tax-backfill';
import { composeSale } from '../pos.totals';
import type { PricedCatalogItem } from '../pos.types';

/**
 * La reprise des tickets d'avant #816 — cinquième critère de l'issue.
 *
 * Seule la partie **pure** est exercée ici, et c'est délibéré : c'est elle qui
 * décide si un ticket est réécrit, et une décision qui porte sur une pièce
 * comptable mérite d'être exerçable sans base. Le script, lui, n'est qu'une
 * boucle autour de cette fonction.
 */

const EUR = 'EUR';

function facts(overrides: Partial<SaleTaxFacts> = {}): SaleTaxFacts {
  return {
    taxRateBps: 2000,
    catalogAmountMinor: 8900,
    subtotalAmountMinor: 7417,
    taxAmountMinor: 1483,
    tipAmountMinor: 0,
    totalAmountMinor: 8900,
    ...overrides,
  };
}

/** Un ticket tel que l'**ancienne** règle l'inscrivait : la taxe ajoutée. */
function legacyFacts(catalogAmountMinor: number, taxRateBps: number, tip = 0): SaleTaxFacts {
  const taxAmountMinor = legacyTaxOn(catalogAmountMinor, taxRateBps);

  return {
    taxRateBps,
    catalogAmountMinor,
    subtotalAmountMinor: catalogAmountMinor,
    taxAmountMinor,
    tipAmountMinor: tip,
    totalAmountMinor: catalogAmountMinor + taxAmountMinor + tip,
  };
}

describe('legacyTaxOn — la règle que #816 retire', () => {
  it('reproduit la taxe ajoutée d’avant #816', () => {
    // C'est ce calcul-là qui a produit la vente de Spa Lumière du constat :
    // 89,00 € de lignes, 17,80 € de « TVA », 106,80 € au total.
    expect(legacyTaxOn(8900, 2000)).toBe(1780);
    expect(legacyTaxOn(10_000, 0)).toBe(0);
  });
});

describe('auditSaleTax — reconnaître un ticket de l’ancienne règle', () => {
  it('classe `conforme` ce que `composeSale` produit aujourd’hui', () => {
    // La garantie qui compte : ce que le module écrit maintenant n'est jamais
    // candidat à une reprise. Elle est vérifiée sur la vraie fonction, et non
    // sur des chiffres recopiés à la main.
    const items: PricedCatalogItem[] = [
      {
        kind: 'SERVICE',
        referenceId: '11111111-1111-4111-8111-111111111111',
        label: 'Soin éclat 45 min',
        unitPrice: { amountMinor: 6500, currency: EUR },
        quantity: 1,
      },
      {
        kind: 'PRODUCT',
        referenceId: '22222222-2222-4222-8222-222222222222',
        label: 'Huile d’argan 100 ml',
        unitPrice: { amountMinor: 2400, currency: EUR },
        quantity: 1,
      },
    ];

    for (const taxRateBps of [0, 550, 2000, 10_000]) {
      for (const tipAmountMinor of [0, 500]) {
        const sale = composeSale({ currency: EUR, taxRateBps, items, tipAmountMinor });

        expect(
          auditSaleTax({
            taxRateBps,
            catalogAmountMinor: 8900,
            subtotalAmountMinor: sale.subtotalAmountMinor,
            taxAmountMinor: sale.taxAmountMinor,
            tipAmountMinor: sale.tipAmountMinor,
            totalAmountMinor: sale.totalAmountMinor,
          }),
        ).toEqual({ verdict: 'conforme', corrected: null });
      }
    }
  });

  it('reconnaît la vente du constat et rend les montants corrigés', () => {
    // Spa Lumière, taux de 2 000 points de base : 89,00 € de lignes inscrits
    // 106,80 €. Le total revient à ce qui a été affiché, la TVA se ventile.
    expect(auditSaleTax(legacyFacts(8900, 2000))).toEqual({
      verdict: 'ancienne-regle',
      corrected: {
        subtotalAmountMinor: 7417,
        taxAmountMinor: 1483,
        totalAmountMinor: 8900,
      },
    });
  });

  it('reporte le pourboire tel quel dans le total corrigé', () => {
    // Le pourboire n'a jamais été taxé, ni avant ni après : il traverse la
    // reprise sans changer d'un centime.
    expect(auditSaleTax(legacyFacts(8900, 2000, 500)).corrected).toEqual({
      subtotalAmountMinor: 7417,
      taxAmountMinor: 1483,
      totalAmountMinor: 9400,
    });
  });

  it('ne trouve rien à reprendre dans un établissement sans taux — septième critère', () => {
    // Barber Tana : les deux règles coïncident, et c'est `conforme` qui
    // l'emporte. Aucune écriture, donc aucun total qui bougerait.
    expect(auditSaleTax(legacyFacts(45_000, 0, 5000))).toEqual({
      verdict: 'conforme',
      corrected: null,
    });
  });

  it('signale sans réécrire un ticket dont les montants ne correspondent à aucune règle', () => {
    expect(auditSaleTax(facts({ subtotalAmountMinor: 7000, taxAmountMinor: 1900 }))).toEqual({
      verdict: 'indeterminee',
      corrected: null,
    });
  });

  it('signale sans réécrire un ticket dont le total ne somme pas ses parts', () => {
    // `sales_total_amount_minor_check` l'interdit en base : un tel ticket n'a pas
    // été écrit par ce module, et le « corriger » serait inventer.
    expect(auditSaleTax(facts({ totalAmountMinor: 9999 }))).toEqual({
      verdict: 'indeterminee',
      corrected: null,
    });
  });

  it('ne rend jamais que des entiers', () => {
    const corrected = auditSaleTax(legacyFacts(3333, 550, 777)).corrected;

    expect(corrected).not.toBeNull();
    for (const amount of Object.values(corrected ?? {})) {
      expect(Number.isInteger(amount)).toBe(true);
    }
  });
});
