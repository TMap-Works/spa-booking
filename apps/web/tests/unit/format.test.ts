import { describe, expect, it } from 'vitest';

import { addCalendarDays, calendarDateInTimeZone } from '@/lib/booking/calendar';
import {
  formatAmountInput,
  formatAmountMachine,
  formatCalendarDate,
  formatDuration,
  formatMoney,
  formatMoneyCompact,
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

describe('formatMoneyCompact', () => {
  const compact = (amountMinor: number, currency: string): string =>
    formatMoneyCompact({ amountMinor, currency }).replace(NO_BREAK_SPACES, ' ');

  it('dit le même montant que l’affichage humain, en plus court', () => {
    // Le point dur de #614 : l'échelle d'un graphique et le tableau de la même
    // figure lisent la **même** donnée en unité mineure. Si les deux ne
    // convertissent pas au même endroit, l'axe annonce 8 500 € là où la caisse
    // a fait 85 €.
    expect(compact(8_500, 'EUR')).toBe('85 €');
    expect(compact(4_250, 'EUR')).toBe('42,5 €');
    expect(compact(0, 'EUR')).toBe('0 €');
  });

  it('abrège au-delà du millier, là où un montant entier déborderait', () => {
    // Une graduation d'axe dispose d'une quarantaine d'unités de viewBox :
    // « 8 500,00 € » y passerait sur le tracé.
    expect(compact(850_000, 'EUR')).toBe('8,5 k €');
  });

  it('ne divise pas par cent une devise sans décimale', () => {
    // 3500 ariary sont 3500 ariary : le nombre de décimales vient d'`Intl`,
    // comme pour `formatMoney`, et non d'un `10 ** 2` codé en dur.
    expect(compact(3_500, 'MGA')).toBe('3,5 k MGA');
  });

  it('n’écrit pas une décimale que l’échelle n’a pas', () => {
    // `Intl` ramènerait sinon le minimum de l'euro — deux décimales — au
    // maximum demandé, et une graduation ronde s'écrirait « 85,0 € ».
    expect(compact(8_500, 'EUR')).not.toContain(',0');
  });

  it('distingue deux montants voisins sous l’unité principale', () => {
    // #640 : une décimale au plus efface tout ce qui vit sous ~0,05 €. Une
    // période dont le plafond vaut deux centimes se gradue 0 / 1 / 2 unités
    // mineures, et les trois repères s'écrivaient « 0 € », « 0 € », « 0 € ».
    expect(compact(1, 'EUR')).toBe('0,01 €');
    expect(compact(2, 'EUR')).toBe('0,02 €');
    expect(compact(5, 'EUR')).toBe('0,05 €');
    expect(new Set([compact(0, 'EUR'), compact(1, 'EUR'), compact(2, 'EUR')]).size).toBe(3);
  });

  it('ne descend pas sous la précision de la devise pour autant', () => {
    // La précision rendue est celle de la devise, pas une décimale de plus :
    // l'euro n'a rien sous le centime, et l'ariary rien sous l'unité. Un
    // troisième chiffre serait une précision inventée.
    expect(compact(1, 'EUR')).not.toMatch(/\d,\d{3}/);
    expect(compact(3, 'MGA')).not.toContain(',');
    expect(compact(0, 'MGA')).not.toContain(',');
  });
});

describe('forme machine d’un montant', () => {
  /**
   * Les chiffres d'un montant affiché, débarrassés de tout ce qui n'appartient
   * qu'à l'humain : symbole, espaces de groupement, et la virgule décimale
   * ramenée au point. Ce qui reste doit être, caractère pour caractère, la forme
   * machine du même montant.
   */
  const humanDigitsOf = (formatted: string): string =>
    formatted.replace(/[^\d,.-]/g, '').replace(',', '.');

  it('rend l’unité principale avec un point décimal et sans symbole', () => {
    expect(formatAmountMachine({ amountMinor: 3500, currency: 'EUR' })).toBe('35.00');
    expect(formatAmountMachine({ amountMinor: 5, currency: 'EUR' })).toBe('0.05');
    expect(formatAmountMachine({ amountMinor: 0, currency: 'EUR' })).toBe('0.00');
  });

  it('n’invente pas de décimales sur une devise qui n’en a pas', () => {
    // 3500 ariary sont « 3500 », pas « 35.00 » : c'est exactement la divergence
    // que #344 vient fermer — un `10 ** 2` codé en dur côté schema.org aurait
    // publié un prix cent fois trop petit.
    expect(formatAmountMachine({ amountMinor: 3500, currency: 'MGA' })).toBe('3500');
    expect(formatAmountMachine({ amountMinor: 1200, currency: 'JPY' })).toBe('1200');
  });

  it('dit le même montant que l’affichage humain, décimales de la devise comprises', () => {
    // Le point dur du ticket : les deux formes lisent leurs décimales au même
    // endroit, donc elles ne peuvent pas annoncer deux prix différents — ni sur
    // une devise à deux décimales, ni sur une devise à zéro décimale.
    for (const amount of [
      { amountMinor: 3500, currency: 'EUR' },
      { amountMinor: 5, currency: 'EUR' },
      { amountMinor: 123456, currency: 'EUR' },
      { amountMinor: 3500, currency: 'MGA' },
      { amountMinor: 1, currency: 'MGA' },
      { amountMinor: 1200, currency: 'JPY' },
    ] as const) {
      expect(humanDigitsOf(formatMoney(amount))).toBe(formatAmountMachine(amount));
    }
  });

  it('ne perd pas un centième, là où un flottant en perdrait un', () => {
    // `(115 / 100).toFixed(2)` s'en tire, mais la conversion se fait en chaîne
    // pour la même raison que `parseAmountInput` : un prix faux d'un centime
    // reste un prix faux, et un analyseur schema.org le republiera tel quel.
    expect(formatAmountMachine({ amountMinor: 115, currency: 'EUR' })).toBe('1.15');
    expect(formatAmountMachine({ amountMinor: 829, currency: 'EUR' })).toBe('8.29');
  });

  it('se relit par l’analyseur de saisie, qui accepte le point', () => {
    for (const amount of [
      { amountMinor: 3500, currency: 'EUR' },
      { amountMinor: 3500, currency: 'MGA' },
    ] as const) {
      expect(parseAmountInput(formatAmountMachine(amount), amount.currency)).toEqual(amount);
    }
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

describe('saisie d’un montant — dans la langue de l’écran (#1123)', () => {
  const FR = { locale: 'fr' } as const;
  const EN = { locale: 'en' } as const;

  it('pré-remplit le champ avec le séparateur décimal de la langue', () => {
    // Le défaut restait figé sur la virgule : un écran anglais affichait
    // « $1,200.00 » au-dessus d'un champ pré-rempli « 1200,00 ».
    expect(formatAmountInput({ amountMinor: 3500, currency: 'EUR' }, FR)).toBe('35,00');
    expect(formatAmountInput({ amountMinor: 3500, currency: 'EUR' }, EN)).toBe('35.00');
    expect(formatAmountInput({ amountMinor: 5, currency: 'EUR' }, EN)).toBe('0.05');
    // Une devise sans décimale n'a pas de séparateur à traduire.
    expect(formatAmountInput({ amountMinor: 3500, currency: 'MGA' }, EN)).toBe('3500');
  });

  it('ne fait pas dépendre le séparateur de la région du salon', () => {
    // `fr-CA` groupe à l'espace fine comme `fr-FR`, `en-GB` à la virgule comme
    // `en-US` : c'est la langue qui décide, et le pays n'a rien à dire ici.
    const amount = { amountMinor: 3500, currency: 'EUR' } as const;

    expect(formatAmountInput(amount, { locale: 'fr', countryCode: 'CA' })).toBe('35,00');
    expect(formatAmountInput(amount, { locale: 'en', countryCode: 'GB' })).toBe('35.00');
  });

  it('relit dans les deux langues ce qu’il vient d’écrire — le premier critère', () => {
    // L'aller-retour affichage → édition → soumission : c'est lui qui était rompu
    // dès qu'un écran de saisie passait `locale: 'en'`.
    for (const display of [FR, EN] as const) {
      for (const amount of [
        { amountMinor: 3500, currency: 'EUR' },
        { amountMinor: 5, currency: 'EUR' },
        { amountMinor: 0, currency: 'EUR' },
        { amountMinor: 120000, currency: 'EUR' },
        { amountMinor: 3500, currency: 'MGA' },
      ] as const) {
        expect(
          parseAmountInput(formatAmountInput(amount, display), amount.currency, display),
        ).toEqual(amount);
      }
    }
  });

  it('relit le montant recopié depuis l’affichage, séparateurs de milliers compris', () => {
    // Ce que la gérante colle dans le champ, c'est ce qu'elle vient de lire :
    // « 1 200,00 » en français — espace fine insécable —, « 1,200.00 » en anglais.
    expect(parseAmountInput('1 200,00', 'EUR', FR)?.amountMinor).toBe(120000);
    expect(parseAmountInput('1,200.00', 'EUR', EN)?.amountMinor).toBe(120000);
    expect(parseAmountInput('1,234,567.89', 'EUR', EN)?.amountMinor).toBe(123456789);
    // Sans décimale : le groupement se lit seul, et n'invente aucun centime.
    expect(parseAmountInput('1,200', 'EUR', EN)?.amountMinor).toBe(120000);
    expect(parseAmountInput('12,000', 'MGA', EN)?.amountMinor).toBe(12000);
  });

  it('relit aussi le groupement d’une région qui n’emploie ni virgule ni point', () => {
    // Un salon suisse anglophone : `formatMoney` y écrit « CHF 1’200.00 », et
    // l'apostrophe typographique n'est dans aucune des deux expressions groupées.
    // L'opérateur se voyait refuser le montant que sa propre pile de totaux
    // affichait — exactement ce que #1123 corrige ailleurs.
    const swiss = { locale: 'en', countryCode: 'CH' } as const;

    expect(parseAmountInput('1’200.00', 'EUR', swiss)?.amountMinor).toBe(120000);
    // Rien ne se perd de la lecture simple ni de la tolérance.
    expect(parseAmountInput('35.00', 'EUR', swiss)?.amountMinor).toBe(3500);
    expect(parseAmountInput('35,00', 'EUR', swiss)?.amountMinor).toBe(3500);
    // Et l'aller-retour tient là aussi.
    const amount = { amountMinor: 120000, currency: 'EUR' } as const;

    expect(parseAmountInput(formatAmountInput(amount, swiss), 'EUR', swiss)).toEqual(amount);
  });

  it('reste tolérant à ce qu’une personne tape vraiment — le troisième critère', () => {
    // Une virgule sur un écran anglais, un point sur un écran français : les deux
    // arrivent, et aucun des deux n'est une erreur de saisie.
    expect(parseAmountInput('19,90', 'EUR', EN)?.amountMinor).toBe(1990);
    expect(parseAmountInput('19.90', 'EUR', FR)?.amountMinor).toBe(1990);
    // Trois chiffres après la virgule, et c'est le groupement qui l'emporte :
    // « 1,200 » sur un écran anglais est mille deux cents, pas un euro vingt.
    expect(parseAmountInput('1,20', 'EUR', EN)?.amountMinor).toBe(120);
  });

  it('refuse ce qui est ambigu plutôt que de deviner un prix', () => {
    // Aucune des deux lectures ne convient : un et deux dixièmes, ou mille deux
    // cents ? Le refus est lisible, un prix faux ne l'est pas.
    expect(parseAmountInput('1.200,50', 'EUR', EN)).toBeNull();
    expect(parseAmountInput('1,200', 'EUR', FR)).toBeNull();
    // La précision de la devise fait toujours foi, quelle que soit la langue.
    expect(parseAmountInput('35.005', 'EUR', EN)).toBeNull();
    expect(parseAmountInput('3.5', 'MGA', EN)).toBeNull();
    expect(parseAmountInput('35.00', 'EUR', EN)?.currency).toBe('EUR');
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
