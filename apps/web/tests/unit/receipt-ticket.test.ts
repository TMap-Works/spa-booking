import { describe, expect, it } from 'vitest';

import {
  formatReceiptPhone,
  formatTaxRate,
  issuerAddressLines,
  legalIdLine,
  soldLines,
  taxTableRows,
} from '@/lib/admin/receipt-ticket';
import { formatTicketDateTime } from '@/lib/format';

/**
 * La mise en forme du ticket de caisse — ce qui se décide sans DOM.
 */
describe('le ticket de caisse', () => {
  it('écrit un taux en points de base comme un pourcentage français', () => {
    expect(formatTaxRate(2000)).toBe('20 %');
    expect(formatTaxRate(550)).toBe('5,5 %');
    expect(formatTaxRate(210)).toBe('2,1 %');
    expect(formatTaxRate(0)).toBe('0 %');
  });

  it('présente la TVA comme une grande surface : taux, HT, TVA, TTC', () => {
    const [row] = taxTableRows([
      {
        rateBps: 2000,
        base: { amountMinor: 5417, currency: 'EUR' },
        tax: { amountMinor: 1083, currency: 'EUR' },
      },
    ]);

    expect(row?.rate).toBe('20 %');
    expect(row?.total).toEqual({ amountMinor: 6500, currency: 'EUR' });
  });

  it('nomme l’identifiant légal par sa nature — SIRET, NIF, STAT', () => {
    expect(legalIdLine({ name: 'Barber Tana', legalIdType: 'NIF', legalId: '3000123456' })).toBe(
      'NIF 3000123456',
    );
    expect(legalIdLine({ name: 'Barber Tana' })).toBeNull();
  });

  it('écrit l’adresse dans l’ordre d’une enveloppe, sans ligne vide', () => {
    expect(
      issuerAddressLines({
        name: 'Maison Lotus',
        address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
      }),
    ).toEqual(['12 rue des Lilas', '75011 Paris']);
  });

  it('ne compte pas la taxe ni le pourboire parmi les articles vendus', () => {
    const money = { amountMinor: 100, currency: 'EUR' };
    const line = { quantity: 1, unitPrice: money, total: money, label: 'x' };

    expect(
      soldLines([
        { ...line, position: 0, kind: 'SERVICE' },
        { ...line, position: 1, kind: 'PRODUCT' },
        { ...line, position: 2, kind: 'TAX' },
        { ...line, position: 3, kind: 'TIP' },
      ]).map((sold) => sold.kind),
    ).toEqual(['SERVICE', 'PRODUCT']);
  });

  it('horodate dans le fuseau du salon, au format court d’un rouleau', () => {
    expect(formatTicketDateTime('2026-09-05T07:05:00.000Z', 'Indian/Antananarivo')).toBe(
      '05/09/2026 10:05',
    );
  });

  it('écrit le téléphone comme dans le pays, pas en E.164', () => {
    expect(formatReceiptPhone('+33142000000')).toBe('01 42 00 00 00');
    expect(formatReceiptPhone('+261341234567')).toBe('034 12 345 67');
    expect(formatReceiptPhone('+14155550100')).toBe('+14155550100');
  });
});
