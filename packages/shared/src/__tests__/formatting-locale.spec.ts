/**
 * La règle de mise en forme, à son unique emplacement — #1343.
 *
 * Ce que cette suite garde tient en deux phrases : **l'étiquette d'écriture est
 * `{langue}-{pays du salon}`**, avec un repli documenté et le refus d'un code
 * pays mal formé ; et **les séparateurs d'un montant sont ceux du nombre
 * ordinaire de la même étiquette**, jamais ceux que CLDR réserve à la monnaie.
 *
 * ## Ce qu'elle ne remplace pas
 *
 * Les deux suites miroir — `apps/web/tests/unit/format.test.ts` et
 * `apps/api/src/modules/payments/__tests__/receipt-pdf.format.spec.ts` — restent
 * en place et inchangées. Elles ne comparent plus deux implémentations mais deux
 * **points d'emploi** : une surface qui repasserait un `hourCycle` ou un
 * séparateur par-dessus `Intl` les ferait rougir sans que celle-ci bouge. Ici on
 * garde la règle ; là-bas on garde son emploi.
 */

import {
  DEFAULT_LOCALE,
  LOCALES,
  formattingLocale,
  separatorsOf,
  withPlainSeparators,
  type Locale,
} from '../locale/index';

/** Les quatre contextes du produit : deux langues × deux marchés. */
const CONTEXTES: ReadonlyArray<[string, Locale, string, string]> = [
  ['un salon parisien lu en français', 'fr', 'FR', 'fr-FR'],
  ['un salon parisien lu en anglais', 'en', 'FR', 'en-FR'],
  ['un salon new-yorkais lu en français', 'fr', 'US', 'fr-US'],
  ['un salon new-yorkais lu en anglais', 'en', 'US', 'en-US'],
];

/** Les régions de repli, telles que le dixième critère de #845 les fige. */
const REPLIS: ReadonlyArray<[Locale, string]> = [
  ['fr', 'fr-FR'],
  ['en', 'en-US'],
];

describe('formattingLocale', () => {
  it.each(CONTEXTES)('compose %s', (_cas, locale, countryCode, expected) => {
    expect(formattingLocale(locale, countryCode)).toBe(expected);
  });

  it('remonte la casse d’un code pays qu’une adresse a saisi en minuscules', () => {
    expect(formattingLocale('fr', 'us')).toBe('fr-US');
  });

  it.each(REPLIS)('replie %s sur la région de son marché, sans pays publié', (locale, expected) => {
    expect(formattingLocale(locale)).toBe(expected);
    expect(formattingLocale(locale, null)).toBe(expected);
    expect(formattingLocale(locale, undefined)).toBe(expected);
    expect(formattingLocale(locale, '')).toBe(expected);
  });

  /**
   * Le point qui compte : `Intl` lève un `RangeError` sur une étiquette mal
   * formée, donc une adresse mal saisie ferait tomber l'écran entier ou
   * l'impression d'un ticket au comptoir. Elle doit dater autrement, pas échouer.
   */
  it.each(['FRA', 'F', 'F1', '75', 'france', 'en-US'])('ignore le pays mal formé %p', (country) => {
    expect(formattingLocale('en', country)).toBe('en-US');
  });

  it('rend, pour chaque langue du contrat, une étiquette qu’`Intl` accepte', () => {
    for (const locale of LOCALES) {
      const tag = formattingLocale(locale);

      expect(() => new Intl.DateTimeFormat(tag)).not.toThrow();
      expect(() => new Intl.NumberFormat(tag)).not.toThrow();
    }
  });

  it('prend la langue par défaut du produit quand l’appelant ne l’a pas résolue', () => {
    expect(formattingLocale()).toBe(formattingLocale(DEFAULT_LOCALE));
  });
});

describe('separatorsOf', () => {
  it('lit le point décimal et la virgule de groupement de l’anglais', () => {
    expect(separatorsOf('en-US')).toEqual({ decimal: '.', group: ',' });
  });

  /**
   * Le français groupe à l'espace — fine insécable (U+202F) sur les ICU récentes,
   * insécable ordinaire (U+00A0) sur les plus anciennes. La suite épingle donc la
   * **fonction** du caractère et non son point de code : la substitution de rendu
   * qu'une police embarquée impose relève de `receipt-pdf.format.ts`.
   */
  it('lit la virgule décimale et l’espace de groupement du français', () => {
    const separators = separatorsOf('fr-FR');

    expect(separators.decimal).toBe(',');
    expect(separators.group).toMatch(/^\s$/u);
  });

  /**
   * `toBe` et non `toEqual` : c'est la **rétention** qui est gardée ici, et deux
   * objets reconstruits seraient de toute façon égaux en profondeur — l'assertion
   * passerait alors sans rien dire, cache ou pas. L'identité, elle, ne tient que
   * si le second appel rend l'objet du premier.
   */
  it('rend au second appel l’objet retenu au premier, sans reconstruire', () => {
    expect(separatorsOf('en-US')).toBe(separatorsOf('en-US'));
  });
});

describe('withPlainSeparators', () => {
  const EUROS = { style: 'currency', currency: 'EUR' } as const;

  /**
   * Le cas qui justifie la fonction : `en-FR` écrit ses nombres à la française et
   * sa monnaie à l'anglaise, et le produit refuse les deux conventions côte à
   * côte sur un même écran ou un même rouleau (#1325, deuxième critère).
   */
  it('aligne le montant d’un salon parisien lu en anglais sur son nombre ordinaire', () => {
    const tag = formattingLocale('en', 'FR');
    const { decimal, group } = separatorsOf(tag);

    // Le constat d'abord : sans alignement, CLDR fait diverger les deux formes.
    expect(new Intl.NumberFormat(tag, EUROS).format(1234.5)).toContain('1,234.50');

    const aligne = withPlainSeparators(1234.5, tag, {
      ...EUROS,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    expect(aligne).toBe(`€1${group}234${decimal}50`);
  });

  it('écrit un taux et un montant du même support avec le même séparateur', () => {
    const tag = formattingLocale('en', 'FR');
    const { decimal } = separatorsOf(tag);

    expect(withPlainSeparators(0.2025, tag, { style: 'percent', maximumFractionDigits: 2 })).toContain(
      `20${decimal}25`,
    );
    expect(withPlainSeparators(20.25, tag, EUROS)).toContain(`20${decimal}25`);
  });

  it('laisse intact un montant dont la monnaie et le nombre s’écrivent déjà pareil', () => {
    const dollars = { style: 'currency', currency: 'USD' } as const;

    expect(withPlainSeparators(1234.5, 'en-US', dollars)).toBe(
      new Intl.NumberFormat('en-US', dollars).format(1234.5),
    );
  });

  it('n’ajoute aucun séparateur là où CLDR n’en met pas', () => {
    const sansGroupe = withPlainSeparators(1234.5, 'en-US', {
      style: 'currency',
      currency: 'USD',
      useGrouping: false,
    });

    expect(sansGroupe).toBe('$1234.50');
  });
});
