import { describe, expect, it } from 'vitest';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import {
  formatAmountInput,
  formatCalendarDate,
  formatDuration,
  formatMoney,
  formatTimeInTimeZone,
  parseAmountInput,
} from '@/lib/format';

/**
 * `Intl` sépare un montant de son symbole par une espace insécable — étroite
 * (U+202F) ou non (U+00A0) selon la version d'ICU embarquée par Node. Les
 * ramener à une espace ordinaire évite un test qui rougirait à la prochaine
 * version de Node sans qu'aucun code de production n'ait changé.
 */
const NO_BREAK_SPACES = /[\u202f\u00a0]/g;

describe('affichage des heures dans le fuseau du salon', () => {
  it('affiche un instant UTC à l’heure murale de l’établissement', () => {
    // 06:00 UTC vaut 09:00 à Antananarivo (UTC+3, sans heure d'été).
    expect(formatTimeInTimeZone('2026-09-01T06:00:00.000Z', 'Indian/Antananarivo')).toBe('09:00');
  });

  it('ne rend pas la même heure dans deux fuseaux — c’est tout l’enjeu', () => {
    const instant = '2026-09-01T06:00:00.000Z';

    expect(formatTimeInTimeZone(instant, 'Indian/Antananarivo')).not.toBe(
      formatTimeInTimeZone(instant, 'Europe/Paris'),
    );
  });

  it('affiche une date civile sans la décaler, quel que soit le fuseau', () => {
    // La date vient déjà découpée dans le fuseau du salon : elle se met en forme
    // telle quelle. La reprojeter décalerait d'un jour au-delà d'UTC+12 —
    // `2026-09-01T12:00Z` est déjà le 2 septembre à Auckland.
    expect(formatCalendarDate('2026-09-01')).toContain('1 septembre 2026');
    expect(formatCalendarDate('2026-01-01')).toContain('1 janvier 2026');
  });
});

describe('formatMoney', () => {
  it('rend un montant entier dans la précision de sa devise', () => {
    const formatted = formatMoney({ amountMinor: 3500, currency: 'EUR' }).replace(
      NO_BREAK_SPACES,
      ' ',
    );

    expect(formatted).toBe('35,00 €');
  });

  it('ne divise pas par cent une devise sans décimale', () => {
    // 3500 ariary sont 3500 ariary, pas 35 : diviser par cent partout est le bug
    // classique d'un affichage qui suppose l'euro.
    const formatted = formatMoney({ amountMinor: 3500, currency: 'MGA' });

    expect(formatted).toContain('3');
    expect(formatted).not.toContain('35,00');
  });
});

describe('saisie d’un montant — jamais de flottant', () => {
  it('convertit une saisie en entier de plus petite unité', () => {
    expect(parseAmountInput('35,00', 'EUR')).toEqual({ amountMinor: 3500, currency: 'EUR' });
    expect(parseAmountInput('35', 'EUR')).toEqual({ amountMinor: 3500, currency: 'EUR' });
    expect(parseAmountInput('0', 'EUR')).toEqual({ amountMinor: 0, currency: 'EUR' });
  });

  it('n’arrondit jamais par un flottant', () => {
    // `Number('1.15') * 100` vaut 114.99999999999999 : arrondi au plus proche il
    // retombe sur 115, mais tronqué il donne 114 — un centime perdu, sur chaque
    // prestation, à chaque enregistrement. La conversion se fait donc en chaîne.
    for (const [text, minor] of [
      ['1,15', 115],
      ['8,29', 829],
      ['1234,56', 123456],
    ] as const) {
      expect(parseAmountInput(text, 'EUR')?.amountMinor).toBe(minor);
    }
  });

  it('suit la précision de la devise, et non celle de l’euro', () => {
    // L'ariary n'a pas de décimale : « 3500 » vaut 3500 ariary, pas 350 000.
    expect(parseAmountInput('3500', 'MGA')).toEqual({ amountMinor: 3500, currency: 'MGA' });
  });

  it('accepte le point, la virgule et les espaces de groupement', () => {
    // Un montant recopié depuis l'écran arrive avec l'espace fine insécable
    // qu'`Intl` y a mise.
    expect(parseAmountInput('1 200.50', 'EUR')?.amountMinor).toBe(120050);
    expect(parseAmountInput(' 12,5 ', 'EUR')?.amountMinor).toBe(1250);
  });

  it('refuse plutôt que d’arrondir en silence', () => {
    // Arrondir déciderait à la place de la gérante du prix qu'elle vend.
    expect(parseAmountInput('35,005', 'EUR')).toBeNull();
    expect(parseAmountInput('3,5', 'MGA')).toBeNull();
    expect(parseAmountInput('-1', 'EUR')).toBeNull();
    expect(parseAmountInput('gratuit', 'EUR')).toBeNull();
    expect(parseAmountInput('', 'EUR')).toBeNull();
    // Au-delà de la largeur de la colonne `integer` qui l'accueille.
    expect(parseAmountInput('99999999999', 'EUR')).toBeNull();
  });

  it('fait l’aller-retour sans perte, pour que la modification ne change pas le prix', () => {
    for (const amount of [
      { amountMinor: 3500, currency: 'EUR' },
      { amountMinor: 5, currency: 'EUR' },
      { amountMinor: 0, currency: 'EUR' },
      { amountMinor: 3500, currency: 'MGA' },
    ] as const) {
      expect(parseAmountInput(formatAmountInput(amount), amount.currency)).toEqual(amount);
    }
  });

  it('pré-remplit un champ sans symbole ni séparateur de milliers', () => {
    expect(formatAmountInput({ amountMinor: 3500, currency: 'EUR' })).toBe('35,00');
    expect(formatAmountInput({ amountMinor: 5, currency: 'EUR' })).toBe('0,05');
    expect(formatAmountInput({ amountMinor: 3500, currency: 'MGA' })).toBe('3500');
  });
});

describe('formatDuration', () => {
  it.each([
    [45, '45 min'],
    [60, '1 h'],
    [75, '1 h 15'],
    [120, '2 h'],
  ])('rend %i minutes en « %s »', (minutes, expected) => {
    expect(formatDuration(minutes)).toBe(expected);
  });
});

describe('dates civiles de l’établissement', () => {
  it('rend la journée du salon, pas celle du navigateur', () => {
    // 22:30 UTC le 31 août est déjà le 1er septembre à Antananarivo.
    expect(calendarDateInTimeZone(new Date('2026-08-31T22:30:00Z'), 'Indian/Antananarivo')).toBe(
      '2026-09-01',
    );
  });

  it('décale une date civile sans la faire retomber sur la veille', () => {
    expect(addCalendarDays('2026-09-01', 13)).toBe('2026-09-14');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    // Bascule d'heure d'été en Europe : un décalage en heures se tromperait ici.
    expect(addCalendarDays('2026-03-28', 1)).toBe('2026-03-29');
  });
});
