/**
 * Montants — règle non négociable du projet : **jamais de flottant**.
 *
 * Un montant est un couple indissociable : un entier dans la plus petite unité
 * de la devise (`3500`) et le code ISO 4217 qui lui donne son sens (`EUR`).
 * Les deux voyagent ensemble, dans ce type, parce que les séparer est
 * exactement ce qui produit une addition d'euros et de dollars.
 *
 * Pourquoi l'entier : `0.1 + 0.2 !== 0.3` en IEEE 754. Sur un panier, l'écart
 * est invisible ; sur un rapprochement bancaire de fin de mois, il ne l'est
 * plus, et il n'est pas rattrapable après coup.
 */

import { z } from 'zod';

import { ERROR_CODES } from '../errors/error-codes';

/**
 * Bornes d'un `integer` PostgreSQL (32 bits signés) — la largeur réellement
 * déclarée par `price_amount_minor` et `amount_minor` dans
 * `apps/api/prisma/schema.prisma`.
 *
 * Les valider ici plutôt qu'à l'insertion change la nature de l'échec : un
 * dépassement devient un 422 nommant le champ, au lieu d'un
 * `numeric value out of range` remonté en 500 depuis le pilote Postgres.
 */
export const AMOUNT_MINOR_MIN = -2_147_483_648;
export const AMOUNT_MINOR_MAX = 2_147_483_647;

/**
 * Code devise ISO 4217, normalisé en majuscules.
 *
 * La normalisation est faite **ici** et pas dans chaque appelant : `eur` et
 * `EUR` désignent la même devise, et deux montants qui ne diffèrent que par la
 * casse de leur code doivent pouvoir s'additionner.
 */
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3, { message: 'un code devise ISO 4217 fait exactement trois lettres' })
  .regex(/^[A-Z]{3}$/, { message: 'code devise ISO 4217 invalide' });

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** Montant en plus petite unité — entier, borné par la colonne qui l'accueille. */
export const amountMinorSchema = z
  .number()
  .int({ message: 'un montant est un entier dans la plus petite unité monétaire' })
  .min(AMOUNT_MINOR_MIN)
  .max(AMOUNT_MINOR_MAX);

/**
 * Le type monétaire du contrat. `.strict()` : un objet qui porterait un champ
 * `amount` flottant à côté de `amountMinor` est refusé plutôt que silencieusement
 * ignoré — c'est la fuite qu'on cherche à rendre impossible.
 */
export const moneySchema = z
  .object({
    amountMinor: amountMinorSchema,
    currency: currencyCodeSchema,
  })
  .strict();

export type Money = z.infer<typeof moneySchema>;

/** Montant qui ne peut pas être négatif — un prix affiché, un encaissement. */
export const nonNegativeMoneySchema = moneySchema.extend({
  amountMinor: amountMinorSchema.min(0, { message: 'ce montant ne peut pas être négatif' }),
});

/** Montant strictement positif — un remboursement de zéro n'est pas une opération. */
export const positiveMoneySchema = moneySchema.extend({
  amountMinor: amountMinorSchema.min(1, { message: 'ce montant doit être strictement positif' }),
});

/**
 * Devises différentes de part et d'autre d'une opération.
 *
 * Porte le code d'erreur du contrat : le module `payments` peut la laisser
 * remonter telle quelle, le front réagit sur `CURRENCY_MISMATCH` sans avoir à
 * connaître cette classe. **Aucune conversion implicite** n'est faite — un taux
 * de change choisi en silence est une perte d'argent qui ne se voit qu'au
 * rapprochement.
 */
export class CurrencyMismatchError extends Error {
  public readonly code = ERROR_CODES.CURRENCY_MISMATCH;

  public constructor(
    public readonly left: CurrencyCode,
    public readonly right: CurrencyCode,
  ) {
    super(`Devises incompatibles : « ${left} » et « ${right} ».`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Construit un montant validé.
 *
 * Passer par cette fonction plutôt que par un littéral `{ amountMinor, currency }`
 * garantit l'entier et la forme du code devise au point de création, là où la
 * pile d'appel désigne encore le coupable.
 */
export function money(amountMinor: number, currency: string): Money {
  return moneySchema.parse({ amountMinor, currency });
}

/** `true` si les deux montants sont libellés dans la même devise. */
export function isSameCurrency(left: Money, right: Money): boolean {
  return left.currency === right.currency;
}

/** Lève `CurrencyMismatchError` si les devises diffèrent. */
export function assertSameCurrency(left: Money, right: Money): void {
  if (!isSameCurrency(left, right)) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

/** Somme de deux montants de même devise. */
export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.amountMinor + right.amountMinor, left.currency);
}

/** Différence de deux montants de même devise — peut être négative. */
export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.amountMinor - right.amountMinor, left.currency);
}

/** Multiplie un montant par une quantité entière (une ligne de vente retail). */
export function multiplyMoney(amount: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new TypeError('La quantité doit être un entier.');
  }
  return money(amount.amountMinor * quantity, amount.currency);
}

/** `true` si le montant est nul, quelle que soit sa devise. */
export function isZeroMoney(amount: Money): boolean {
  return amount.amountMinor === 0;
}

/**
 * Compare deux montants de même devise : `-1`, `0` ou `1`.
 *
 * Sert au plafonnement d'un remboursement — d'où le refus, ici aussi, de
 * comparer deux devises différentes plutôt que de renvoyer un ordre arbitraire.
 */
export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.amountMinor < right.amountMinor) {
    return -1;
  }
  return left.amountMinor > right.amountMinor ? 1 : 0;
}
