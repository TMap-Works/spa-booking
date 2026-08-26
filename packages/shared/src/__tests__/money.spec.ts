/**
 * Montants — la règle « jamais de flottant » se vérifie ici, une fois, pour tout
 * le dépôt. Ces tests sont la contrepartie exécutable de CLAUDE.md : un montant
 * fractionnaire refusé, deux devises jamais additionnées en silence.
 */

import {
  AMOUNT_MINOR_MAX,
  AMOUNT_MINOR_MIN,
  CurrencyMismatchError,
  addMoney,
  compareMoney,
  currencyCodeSchema,
  isZeroMoney,
  money,
  moneySchema,
  multiplyMoney,
  nonNegativeMoneySchema,
  positiveMoneySchema,
  subtractMoney,
} from '../common/money';
import { ERROR_CODES } from '../errors/error-codes';

describe('montants', () => {
  it('refuse un montant fractionnaire', () => {
    expect(() => money(35.5, 'EUR')).toThrow();
  });

  it('refuse un montant hors des bornes de la colonne integer', () => {
    expect(moneySchema.safeParse({ amountMinor: AMOUNT_MINOR_MAX, currency: 'EUR' }).success).toBe(
      true,
    );
    expect(
      moneySchema.safeParse({ amountMinor: AMOUNT_MINOR_MAX + 1, currency: 'EUR' }).success,
    ).toBe(false);
    expect(
      moneySchema.safeParse({ amountMinor: AMOUNT_MINOR_MIN - 1, currency: 'EUR' }).success,
    ).toBe(false);
  });

  it('normalise le code devise en majuscules', () => {
    expect(money(3500, 'eur').currency).toBe('EUR');
    expect(currencyCodeSchema.parse(' usd ')).toBe('USD');
  });

  it('refuse un code devise qui ne fait pas trois lettres', () => {
    expect(currencyCodeSchema.safeParse('EU').success).toBe(false);
    expect(currencyCodeSchema.safeParse('EURO').success).toBe(false);
    expect(currencyCodeSchema.safeParse('E1R').success).toBe(false);
  });

  it('refuse un champ inconnu à côté du montant', () => {
    const withFloat = { amountMinor: 3500, currency: 'EUR', amount: 35.0 };

    expect(moneySchema.safeParse(withFloat).success).toBe(false);
  });

  it('additionne et soustrait deux montants de même devise', () => {
    const a = money(3500, 'EUR');
    const b = money(1200, 'EUR');

    expect(addMoney(a, b)).toEqual({ amountMinor: 4700, currency: 'EUR' });
    expect(subtractMoney(a, b)).toEqual({ amountMinor: 2300, currency: 'EUR' });
  });

  it('refuse toute opération entre deux devises, sans conversion implicite', () => {
    const euros = money(3500, 'EUR');
    const dollars = money(3500, 'USD');

    expect(() => addMoney(euros, dollars)).toThrow(CurrencyMismatchError);
    expect(() => subtractMoney(euros, dollars)).toThrow(CurrencyMismatchError);
    expect(() => compareMoney(euros, dollars)).toThrow(CurrencyMismatchError);
  });

  it('porte le code d’erreur du contrat sur le conflit de devises', () => {
    const euros = money(1, 'EUR');
    const dollars = money(1, 'USD');

    try {
      addMoney(euros, dollars);
      throw new Error('addMoney aurait dû lever');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe(ERROR_CODES.CURRENCY_MISMATCH);
    }
  });

  it('multiplie par une quantité entière et refuse une quantité fractionnaire', () => {
    const unit = money(1250, 'EUR');

    expect(multiplyMoney(unit, 3)).toEqual({ amountMinor: 3750, currency: 'EUR' });
    expect(() => multiplyMoney(unit, 1.5)).toThrow(TypeError);
  });

  it('ordonne deux montants de même devise', () => {
    expect(compareMoney(money(100, 'EUR'), money(200, 'EUR'))).toBe(-1);
    expect(compareMoney(money(200, 'EUR'), money(100, 'EUR'))).toBe(1);
    expect(compareMoney(money(100, 'EUR'), money(100, 'EUR'))).toBe(0);
  });

  it('reconnaît le montant nul quelle que soit la devise', () => {
    expect(isZeroMoney(money(0, 'EUR'))).toBe(true);
    expect(isZeroMoney(money(0, 'USD'))).toBe(true);
    expect(isZeroMoney(money(1, 'EUR'))).toBe(false);
  });

  it('distingue montant non négatif et montant strictement positif', () => {
    expect(nonNegativeMoneySchema.safeParse({ amountMinor: 0, currency: 'EUR' }).success).toBe(true);
    expect(nonNegativeMoneySchema.safeParse({ amountMinor: -1, currency: 'EUR' }).success).toBe(
      false,
    );
    expect(positiveMoneySchema.safeParse({ amountMinor: 0, currency: 'EUR' }).success).toBe(false);
    expect(positiveMoneySchema.safeParse({ amountMinor: 1, currency: 'EUR' }).success).toBe(true);
  });
});
