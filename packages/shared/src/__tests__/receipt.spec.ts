import {
  DEFAULT_RECEIPT_PREFIX,
  formatReceiptNumber,
  formatRefundReceiptNumber,
  isLegalIdType,
  isReceiptPrefix,
  isValidFrenchVatNumber,
  isValidLegalId,
  isValidSiren,
  isValidSiret,
  isValidVatNumber,
  LEGAL_ID_TYPES,
} from '../constants/receipt';
import { receiptPrefixSchema, saleReceiptSchema } from '../schemas/receipt';

/**
 * Le contrat du ticket de caisse — #818, deuxième, quatrième et septième
 * critères.
 *
 * Ce qui se prouve ici et nulle part ailleurs : la **forme** d'un numéro de
 * pièce, et le jugement porté sur un identifiant d'entreprise. Les deux sont
 * partagés — l'API les applique à l'écriture, le front les affiche et les
 * pré-valide —, et deux implémentations auraient fini par diverger sur le seul
 * cas qui compte : la saisie fautive qu'on veut refuser.
 */

describe('Numéro de pièce — le format du deuxième critère', () => {
  it('compose `{PRÉFIXE}-{AAAA}-{000123}`', () => {
    expect(formatReceiptNumber('TIC', 2026, 123)).toBe('TIC-2026-000123');
  });

  it('remplit le rang sur six chiffres, à partir de 1', () => {
    expect(formatReceiptNumber(DEFAULT_RECEIPT_PREFIX, 2026, 1)).toBe('TIC-2026-000001');
  });

  it('laisse **déborder** un rang de plus de six chiffres plutôt que de le tronquer', () => {
    // Un numéro tronqué désignerait deux ventes à la fois — exactement ce que
    // `sales_tenant_id_receipt_number_key` interdit de représenter.
    expect(formatReceiptNumber('TIC', 2026, 1_234_567)).toBe('TIC-2026-1234567');
  });

  it('accepte un préfixe de deux à huit caractères, chiffres compris', () => {
    expect(formatReceiptNumber('BT2026', 2026, 7)).toBe('BT2026-2026-000007');
  });

  describe('la pièce d’avoir — sixième critère', () => {
    it('cite le numéro d’origine et porte son propre rang', () => {
      expect(formatRefundReceiptNumber('TIC-2026-000123', 1)).toBe('TIC-2026-000123-R1');
      expect(formatRefundReceiptNumber('TIC-2026-000123', 2)).toBe('TIC-2026-000123-R2');
    });

    it('ne renumérote jamais la vente — elle **garde** son numéro', () => {
      const origin = formatReceiptNumber('TIC', 2026, 123);

      expect(formatRefundReceiptNumber(origin, 1).startsWith(origin)).toBe(true);
    });
  });
});

describe('Préfixe de numérotation', () => {
  it.each(['TIC', 'BT', 'BT2026', 'ABCDEFGH'])('accepte « %s »', (prefix) => {
    expect(isReceiptPrefix(prefix)).toBe(true);
  });

  it.each([
    ['T', 'un seul caractère'],
    ['ABCDEFGHI', 'neuf caractères'],
    ['TI-C', 'un tiret — c’est le séparateur du format'],
    ['TI C', 'une espace'],
    ['tic', 'des minuscules non normalisées'],
    ['', 'le vide'],
  ])('refuse « %s » — %s', (prefix) => {
    expect(isReceiptPrefix(prefix)).toBe(false);
  });

  it('normalise la casse à la lecture — « tic » et « TIC » sont un seul préfixe', () => {
    expect(receiptPrefixSchema.parse('  tic ')).toBe('TIC');
  });
});

describe('Identifiant d’entreprise — la validation du quatrième critère', () => {
  it('reconnaît les cinq natures, et rien d’autre', () => {
    expect([...LEGAL_ID_TYPES]).toEqual(['SIRET', 'SIREN', 'NIF', 'STAT', 'OTHER']);
    expect(isLegalIdType('SIRET')).toBe(true);
    expect(isLegalIdType('KBIS')).toBe(false);
  });

  describe('SIRET — 14 chiffres et une clé de Luhn', () => {
    it('accepte un SIRET dont la clé est juste', () => {
      expect(isValidSiret('73282932000074')).toBe(true);
    });

    it('refuse le même SIRET avec **un chiffre changé** — c’est l’objet de la clé', () => {
      // La faute de frappe que l'on veut attraper : un ticket qui porte un
      // SIRET faux est un ticket qu'aucune comptabilité ne peut rapprocher, et
      // l'erreur ne se découvre qu'au contrôle.
      expect(isValidSiret('73282932000075')).toBe(false);
    });

    it('refuse une longueur qui n’est pas 14, et tout ce qui n’est pas un chiffre', () => {
      expect(isValidSiret('732829320')).toBe(false);
      expect(isValidSiret('7328293200007A')).toBe(false);
      expect(isValidSiret('')).toBe(false);
    });
  });

  describe('SIREN — les neuf premiers chiffres, même clé', () => {
    it('accepte un SIREN valide et refuse sa faute de frappe', () => {
      expect(isValidSiren('732829320')).toBe(true);
      expect(isValidSiren('732829321')).toBe(false);
    });

    it('refuse un SIRET là où un SIREN est attendu', () => {
      expect(isValidSiren('73282932000074')).toBe(false);
    });
  });

  describe('les pays que le MVP ne sait pas juger', () => {
    it('accepte un NIF ou un numéro STAT en format libre borné', () => {
      expect(isValidLegalId('NIF', '3000123456')).toBe(true);
      expect(isValidLegalId('STAT', '96222112019000123')).toBe(true);
      expect(isValidLegalId('OTHER', 'BE-0123/456-789')).toBe(true);
    });

    it('refuse malgré tout ce qui n’est pas un identifiant', () => {
      expect(isValidLegalId('OTHER', 'abc')).toBe(false);
      expect(isValidLegalId('OTHER', 'trop court'.repeat(10))).toBe(false);
      expect(isValidLegalId('NIF', '')).toBe(false);
    });

    it('n’applique la clé de Luhn qu’aux natures françaises', () => {
      // `73282932000075` est un SIRET fautif ; en `OTHER`, ce n'est plus qu'une
      // chaîne de chiffres, et rien n'autorise à la refuser.
      expect(isValidLegalId('SIRET', '73282932000075')).toBe(false);
      expect(isValidLegalId('OTHER', '73282932000075')).toBe(true);
    });
  });
});

describe('Numéro de TVA — quatrième critère', () => {
  it('recalcule la clé d’un numéro français', () => {
    expect(isValidFrenchVatNumber('FR40303265045')).toBe(true);
    expect(isValidFrenchVatNumber('FR44732829320')).toBe(true);
  });

  it('refuse une clé fausse, et un SIREN fautif sous une clé juste', () => {
    expect(isValidFrenchVatNumber('FR41303265045')).toBe(false);
    expect(isValidFrenchVatNumber('FR40303265046')).toBe(false);
  });

  it('accepte une clé alphabétique sur sa seule forme, le SIREN restant vérifié', () => {
    // Les clés alphabétiques — entreprises créées depuis 2009 — ne se
    // recalculent pas. Le SIREN qui les suit, lui, se vérifie toujours.
    expect(isValidFrenchVatNumber('FRAB303265045')).toBe(true);
    expect(isValidFrenchVatNumber('FRAB303265046')).toBe(false);
  });

  it('borne les autres pays en forme, sans prétendre les juger', () => {
    expect(isValidVatNumber('BE0123456789')).toBe(true);
    expect(isValidVatNumber('XX1')).toBe(false);
    expect(isValidVatNumber('1234567890')).toBe(false);
  });
});

describe('Le contrat du reçu — septième critère', () => {
  /** Le reçu minimal : un salon sans identité légale, un ticket encore ouvert. */
  const proforma = {
    saleId: '6a7f1f52-3f1e-4b19-9c0a-1d4e2f5b6c7d',
    number: null,
    sequence: null,
    issuedAt: null,
    openedAt: '2026-09-17T09:00:00.000Z',
    timezone: 'Europe/Paris',
    issuer: { name: 'Barber Tana' },
    cashier: { displayName: 'Camille Roux' },
    client: null,
    practitioner: null,
    lines: [],
    taxBreakdown: [],
    subtotal: { amountMinor: 0, currency: 'EUR' },
    taxTotal: { amountMinor: 0, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 0, currency: 'EUR' },
    settlements: [],
    refunds: [],
  };

  it('accepte un ticket **ouvert** — le numéro n’est attribué qu’à la clôture', () => {
    expect(saleReceiptSchema.safeParse(proforma).success).toBe(true);
  });

  it('accepte une pièce close, avec sa ventilation, ses règlements et ses avoirs', () => {
    const closed = {
      ...proforma,
      number: 'TIC-2026-000123',
      sequence: 123,
      issuedAt: '2026-09-17T09:30:00.000Z',
      client: { displayName: 'Alice Martin' },
      practitioner: { displayName: 'Camille' },
      lines: [
        {
          position: 0,
          kind: 'SERVICE' as const,
          label: 'Soin éclat 45 min',
          quantity: 1,
          unitPrice: { amountMinor: 6500, currency: 'EUR' },
          total: { amountMinor: 6500, currency: 'EUR' },
        },
      ],
      taxBreakdown: [
        {
          rateBps: 2000,
          base: { amountMinor: 5417, currency: 'EUR' },
          tax: { amountMinor: 1083, currency: 'EUR' },
        },
      ],
      subtotal: { amountMinor: 5417, currency: 'EUR' },
      taxTotal: { amountMinor: 1083, currency: 'EUR' },
      total: { amountMinor: 6500, currency: 'EUR' },
      settlements: [
        {
          method: 'CASH' as const,
          amount: { amountMinor: 6500, currency: 'EUR' },
          tendered: { amountMinor: 10_000, currency: 'EUR' },
          change: { amountMinor: 3500, currency: 'EUR' },
          capturedAt: '2026-09-17T09:30:00.000Z',
        },
      ],
      refunds: [
        {
          number: 'TIC-2026-000123-R1',
          origin: 'TIC-2026-000123',
          amount: { amountMinor: 1000, currency: 'EUR' },
          issuedAt: '2026-09-17T10:00:00.000Z',
          reason: 'Prestation écourtée',
        },
      ],
    };

    expect(saleReceiptSchema.safeParse(closed).success).toBe(true);
  });

  it('refuse un rang nul ou négatif — `0` n’est pas une pièce', () => {
    expect(saleReceiptSchema.safeParse({ ...proforma, sequence: 0 }).success).toBe(false);
    expect(saleReceiptSchema.safeParse({ ...proforma, sequence: -1 }).success).toBe(false);
  });

  it('refuse un taux hors de [0, 10000]', () => {
    const outOfRange = {
      ...proforma,
      taxBreakdown: [
        {
          rateBps: 10_001,
          base: { amountMinor: 1, currency: 'EUR' },
          tax: { amountMinor: 1, currency: 'EUR' },
        },
      ],
    };

    expect(saleReceiptSchema.safeParse(outOfRange).success).toBe(false);
  });
});
