import {
  bookingUrl,
  contentDisposition,
  formatDate,
  formatDateTime,
  formatMoney,
  formatSettlementMethod,
  formatTaxRate,
  printable,
  receiptFileName,
} from '../receipt-pdf/receipt-pdf.format';

/**
 * La mise en forme de ce qui s'imprime — #819, cinquième et septième critères.
 *
 * Ce qui se prouve ici : qu'un entier devient le bon montant dans sa devise, que
 * les instants sont rendus dans le fuseau du salon, et qu'aucune ligne de
 * règlement ne porte quoi que ce soit d'une carte.
 */

const PARIS = 'Europe/Paris';
const TANA = 'Indian/Antananarivo';

describe('formatMoney', () => {
  it('rend un montant en euros avec ses deux décimales', () => {
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' })).toContain('65,00');
    expect(formatMoney({ amountMinor: 6500, currency: 'EUR' })).toContain('€');
  });

  /**
   * Le cœur du cinquième critère : « les décimales de la devise : 0 pour le
   * MGA ». Un `/100` en dur aurait rendu « 65,00 Ar » d'un ticket de 6 500 Ar.
   */
  it('rend un montant en ariary sans décimale, et sans le diviser', () => {
    const formatted = formatMoney({ amountMinor: 6500, currency: 'MGA' });

    expect(formatted).toContain('6');
    expect(formatted).toContain('500');
    expect(formatted).toContain('Ar');
    expect(formatted).not.toContain('65,00');
    expect(formatted).not.toContain(',');
  });

  it('rend le symbole étroit, jamais le code à trois lettres', () => {
    expect(formatMoney({ amountMinor: 24_000, currency: 'MGA' })).not.toContain('MGA');
  });

  it('ne perd pas un centime sur un montant qui n’est pas rond', () => {
    expect(formatMoney({ amountMinor: 1, currency: 'EUR' })).toContain('0,01');
    expect(formatMoney({ amountMinor: 9_999_99, currency: 'EUR' })).toContain('99,99');
  });

  /**
   * La panne que la police a révélée : `Intl` sépare les milliers par U+202F en
   * `fr-FR`, et **Roboto ne porte pas ce caractère**. Sans substitution, la
   * séparation s'imprime en rectangle vide — invisible ici, visible sur le
   * papier de la cliente.
   */
  it('n’émet jamais l’espace fine insécable, que la police embarquée ignore', () => {
    for (const currency of ['EUR', 'MGA']) {
      expect(formatMoney({ amountMinor: 1_234_567, currency })).not.toContain(' ');
    }

    expect(printable('6 500')).toBe('6 500');
  });
});

describe('formatTaxRate', () => {
  it('rend les points de base en pourcentage', () => {
    expect(formatTaxRate(2000)).toContain('20');
    expect(formatTaxRate(2000)).toContain('%');
    expect(formatTaxRate(550)).toContain('5,5');
  });

  it('n’imprime pas de décimales inutiles', () => {
    expect(formatTaxRate(2000)).not.toContain('20,00');
  });
});

describe('les dates', () => {
  /**
   * Cinquième critère : « les dates sont dans le fuseau du salon ». Le même
   * instant tombe le 17 à Paris et le 17 à Tananarive, mais à deux heures
   * différentes — et à 21 h 30 UTC, il tomberait le 18 chez l'un et pas l'autre.
   */
  it('rend l’instant dans le fuseau du salon, et non en UTC', () => {
    const instant = new Date('2026-09-17T09:30:00.000Z');

    expect(formatDateTime(instant, PARIS)).toBe('17/09/2026 à 11:30');
    expect(formatDateTime(instant, TANA)).toBe('17/09/2026 à 12:30');
  });

  it('date la pièce du bon jour de part et d’autre de minuit local', () => {
    const instant = new Date('2026-09-17T22:30:00.000Z');

    expect(formatDate(instant, PARIS)).toBe('18/09/2026');
    expect(formatDate(instant, 'UTC')).toBe('17/09/2026');
  });
});

describe('formatSettlementMethod', () => {
  it('nomme les espèces', () => {
    expect(formatSettlementMethod('CASH')).toBe('Espèces');
  });

  /**
   * **Septième critère.** La référence du ticket TPE est l'objet de #834, qui
   * n'est pas traitée : aucun règlement n'en porte, et la ligne s'imprime seule.
   */
  it('nomme la carte sans aucune donnée de carte', () => {
    const label = formatSettlementMethod('CARD');

    expect(label).toBe('Carte bancaire (TPE)');
    expect(label).not.toMatch(/\d{4}/);
    expect(label).not.toMatch(/visa|mastercard|cb|\*{4}/i);
  });

  it('porte la référence TPE le jour où le caissier la saisira (#834)', () => {
    expect(formatSettlementMethod('CARD', 'A0000123')).toBe('Carte bancaire (TPE) — réf. A0000123');
    expect(formatSettlementMethod('CARD', '   ')).toBe('Carte bancaire (TPE)');
  });
});

describe('bookingUrl', () => {
  it('pointe le tunnel de réservation du salon', () => {
    expect(bookingUrl('https://app.spa.test', 'barber-tana')).toBe(
      'https://app.spa.test/barber-tana/reservation',
    );
  });

  it('ne double pas la barre oblique quand l’origine en porte une', () => {
    expect(bookingUrl('https://app.spa.test/', 'barber-tana')).toBe(
      'https://app.spa.test/barber-tana/reservation',
    );
  });

  it('encode le slug plutôt que de le recopier', () => {
    expect(bookingUrl('https://app.spa.test', 'a/b')).toBe('https://app.spa.test/a%2Fb/reservation');
  });
});

describe('receiptFileName', () => {
  /** Sixième critère : « `Content-Disposition` porte le numéro de pièce ». */
  it('porte le numéro de pièce', () => {
    expect(receiptFileName('TIC-2026-000123', 'ticket-80')).toBe('ticket-TIC-2026-000123.pdf');
    expect(receiptFileName('TIC-2026-000123', 'a4')).toBe('facture-TIC-2026-000123.pdf');
  });

  it('se rabat sur « proforma » tant que la vente n’est pas close', () => {
    expect(receiptFileName(null, 'ticket-80')).toBe('ticket-proforma.pdf');
  });

  /**
   * Le préfixe de numérotation est saisi par le salon : rien ne garantit qu'il
   * ne porte ni accent, ni séparateur de chemin. Les deux disparaissent — et le
   * nom reste de toute façon préfixé par « ticket- » ou « facture- », si bien
   * qu'il ne peut pas commencer par une remontée de répertoire.
   */
  it('borne le nom à l’ASCII sûr', () => {
    expect(receiptFileName('../../etc/passwd', 'a4')).toBe('facture-..-..-etc-passwd.pdf');
    expect(receiptFileName('TIC é 1', 'a4')).toBe('facture-TIC---1.pdf');
    expect(receiptFileName('a b"c', 'ticket-80')).toBe('ticket-a-b-c.pdf');
  });
});

describe('contentDisposition', () => {
  it('sert les deux formes de la RFC 6266', () => {
    expect(contentDisposition('ticket-TIC-2026-000123.pdf')).toBe(
      'inline; filename="ticket-TIC-2026-000123.pdf"; ' +
        "filename*=UTF-8''ticket-TIC-2026-000123.pdf",
    );
  });

  it('retire les deux caractères qui refermeraient la chaîne citée', () => {
    expect(contentDisposition('a"b\\c.pdf')).toContain('filename="abc.pdf"');
  });
});
