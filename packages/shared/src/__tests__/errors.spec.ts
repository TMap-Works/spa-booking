/**
 * Codes d'erreur et enveloppe de réponse.
 *
 * L'invariant central : le front réagit sur `code`, et un code qu'il ne connaît
 * pas ne doit **pas** l'empêcher de lire le reste de l'enveloppe. C'est ce que
 * vérifie le couple `apiErrorSchema` permissif / `isKnownErrorCode` strict.
 */

import {
  ERROR_CODE_VALUES,
  apiError,
  apiErrorSchema,
  errorCodeOf,
  isApiError,
} from '../errors/api-error';
import {
  BOOKING_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  ERROR_CODES,
  IDENTITY_ERROR_CODES,
  PAYMENT_ERROR_CODES,
  TRANSPORT_ERROR_CODES,
  isKnownErrorCode,
} from '../errors/error-codes';

/**
 * Les cinq familles qui composent `ERROR_CODES`. Les énumérer ici plutôt que de
 * les recopier dans chaque test : une famille oubliée dans l'une des listes
 * rendrait le test de doublon aveugle à ses codes — c'est exactement la
 * collision silencieuse que le `spread` de `ERROR_CODES` produirait.
 */
const ERROR_CODE_FAMILIES = [
  TRANSPORT_ERROR_CODES,
  DOMAIN_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  BOOKING_ERROR_CODES,
  PAYMENT_ERROR_CODES,
] as const;

describe('codes d’erreur', () => {
  it('associe chaque clé à une valeur identique — le code est son propre nom', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('n’a aucun doublon entre familles', () => {
    const all = ERROR_CODE_FAMILIES.flatMap((family) => Object.values(family));

    expect(new Set(all).size).toBe(all.length);
    // Le spread de `ERROR_CODES` écrase silencieusement un doublon : si les deux
    // comptes ne concordent pas, un code d'une famille en masque un autre.
    expect(Object.keys(ERROR_CODES).length).toBe(all.length);
  });

  it('rassemble toutes les familles dans ERROR_CODES', () => {
    for (const family of ERROR_CODE_FAMILIES) {
      for (const value of Object.values(family)) {
        expect(ERROR_CODE_VALUES).toContain(value);
      }
    }
  });

  it('gèle l’objet — un module ne réécrit pas le contrat du processus', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it('garde isKnownErrorCode contre un code inventé', () => {
    expect(isKnownErrorCode(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE)).toBe(true);
    expect(isKnownErrorCode('HTTP_418')).toBe(false);
    expect(isKnownErrorCode(42)).toBe(false);
    expect(isKnownErrorCode(undefined)).toBe(false);
  });
});

describe('enveloppe d’erreur', () => {
  it('complète details par un objet vide quand il manque', () => {
    const parsed = apiErrorSchema.parse({ code: 'NOT_FOUND', message: 'Introuvable.' });

    expect(parsed.details).toEqual({});
  });

  it('accepte un code inconnu — le front doit garder le message', () => {
    const body = { code: 'HTTP_418', message: 'Je suis une théière.', details: {} };

    expect(isApiError(body)).toBe(true);
    expect(errorCodeOf(body)).toBeUndefined();
  });

  it('rend le code quand il appartient au contrat', () => {
    const body = apiError(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE, 'Créneau pris.');

    expect(errorCodeOf(body)).toBe(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE);
  });

  it('refuse ce qui n’est pas une enveloppe du contrat', () => {
    expect(isApiError('<html>502 Bad Gateway</html>')).toBe(false);
    expect(isApiError({ error: 'boom' })).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(errorCodeOf('<html>502 Bad Gateway</html>')).toBeUndefined();
  });

  it('refuse un champ hors contrat dans l’enveloppe', () => {
    const parsed = apiErrorSchema.safeParse({
      code: 'NOT_FOUND',
      message: 'Introuvable.',
      details: {},
      stack: 'at Object.<anonymous>',
    });

    expect(parsed.success).toBe(false);
  });
});
