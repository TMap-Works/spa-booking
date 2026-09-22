/**
 * Les phrases affichables des codes d'erreur — #845.
 *
 * Ce que cette suite garde : **aucun code du contrat n'est sans message, dans
 * aucune des deux langues**. C'est le onzième critère d'acceptation de #845.
 * L'annotation `Record<ErrorCode, string>` d'`error-messages.ts` le dit déjà à
 * `tsc` ; ce test le dit à l'exécution, ce qui couvre les deux cas que le
 * compilateur laisse passer — une phrase vide, et une phrase recopiée d'une
 * langue à l'autre par étourderie.
 */

import { ERROR_CODES, ERROR_MESSAGES, errorMessage, type ErrorCode } from '../errors/index';
import { LOCALES } from '../locale/index';

const CODES: readonly ErrorCode[] = Object.values(ERROR_CODES);

describe('ERROR_MESSAGES', () => {
  it.each([...LOCALES])('couvre tous les codes du contrat en « %s »', (locale) => {
    const declared = Object.keys(ERROR_MESSAGES[locale]);

    for (const code of CODES) {
      expect(declared).toContain(code);
    }
  });

  it.each([...LOCALES])('n’a aucune phrase vide en « %s »', (locale) => {
    for (const [code, message] of Object.entries(ERROR_MESSAGES[locale])) {
      // Le code est dans le message d'échec : sans lui, un tableau de
      // soixante-seize entrées ne dirait pas laquelle est vide.
      expect({ code, message: message.trim() }).not.toEqual({ code, message: '' });
    }
  });

  it.each([...LOCALES])('ne déclare aucun message pour un code inconnu (%s)', (locale) => {
    for (const code of Object.keys(ERROR_MESSAGES[locale])) {
      expect(CODES).toContain(code);
    }
  });

  it('dit le même refus dans deux phrases différentes', () => {
    // Une phrase identique dans les deux tables est le signe d'une traduction
    // oubliée — recopiée d'une colonne à l'autre.
    for (const code of CODES) {
      expect({ code, same: ERROR_MESSAGES.fr[code] === ERROR_MESSAGES.en[code] }).toEqual({
        code,
        same: false,
      });
    }
  });

  it('ne cite jamais le prestataire de paiement', () => {
    // payments-stripe §1 : un message d'erreur repart dans un journal et dans
    // une capture d'écran de ticket.
    for (const locale of LOCALES) {
      for (const message of Object.values(ERROR_MESSAGES[locale])) {
        expect(message.toLowerCase()).not.toContain('stripe');
      }
    }
  });

  it('est figé', () => {
    expect(Object.isFrozen(ERROR_MESSAGES)).toBe(true);
    expect(Object.isFrozen(ERROR_MESSAGES.fr)).toBe(true);
    expect(Object.isFrozen(ERROR_MESSAGES.en)).toBe(true);
  });
});

describe('errorMessage', () => {
  it('rend la phrase du code, dans la langue demandée', () => {
    expect(errorMessage(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE, 'fr')).toBe(
      ERROR_MESSAGES.fr.SLOT_NO_LONGER_AVAILABLE,
    );
    expect(errorMessage(ERROR_CODES.SLOT_NO_LONGER_AVAILABLE, 'en')).toBe(
      ERROR_MESSAGES.en.SLOT_NO_LONGER_AVAILABLE,
    );
  });

  it('retombe sur la phrase générique pour un code hors contrat', () => {
    // `HTTP_418` : ce que le filtre d'exception fabrique pour un statut qu'il ne
    // sait pas nommer. Il traverse `isKnownErrorCode` sans le heurter, et ne
    // doit pas s'afficher tel quel.
    expect(errorMessage('HTTP_418', 'fr')).toBe(ERROR_MESSAGES.fr.INTERNAL_ERROR);
    expect(errorMessage('HTTP_418', 'en')).toBe(ERROR_MESSAGES.en.INTERNAL_ERROR);
  });
});
