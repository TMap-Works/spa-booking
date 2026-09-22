import { DEFAULT_LOCALE } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { asLocale, negotiateLocale, resolveLocale, SUPPORTED_LOCALES } from '@/i18n/resolve';

/**
 * L'ordre de résolution de la langue — #845, cinquième critère d'acceptation :
 * *« chaque étape est couverte par un test »*.
 *
 * Les fonctions de `i18n/resolve.ts` sont pures : aucune requête n'est montée
 * ici, ce qui est tout l'intérêt de la séparation d'avec `i18n/server.ts`. Un
 * test qui devrait démarrer un serveur pour éprouver une priorité n'éprouverait
 * pas la priorité.
 */

describe('l’anglais est la langue par défaut du système', () => {
  it('sert `en` quand aucun signal ne dit rien', () => {
    expect(resolveLocale({})).toBe('en');
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('sert `en` quand tous les signaux sont illisibles', () => {
    expect(
      resolveLocale({
        explicit: 'klingon',
        account: '',
        acceptLanguage: '*;q=0.5',
        tenant: 'de',
      }),
    ).toBe('en');
  });
});

describe('l’ordre des cinq étapes', () => {
  it('1. le choix explicite gagne sur tout le reste', () => {
    expect(
      resolveLocale({
        explicit: 'fr',
        account: 'en',
        acceptLanguage: 'en-US,en;q=0.9',
        tenant: 'en',
      }),
    ).toBe('fr');
  });

  it('2. le compte gagne sur le navigateur et l’établissement', () => {
    expect(
      resolveLocale({
        explicit: null,
        account: 'fr',
        acceptLanguage: 'en-US,en;q=0.9',
        tenant: 'en',
      }),
    ).toBe('fr');
  });

  it('3. `Accept-Language` gagne sur l’établissement', () => {
    expect(resolveLocale({ acceptLanguage: 'fr-CA,fr;q=0.9', tenant: 'en' })).toBe('fr');
  });

  it('4. l’établissement tranche quand le reste est muet', () => {
    expect(resolveLocale({ tenant: 'fr' })).toBe('fr');
  });

  it('5. `en` par défaut, jusque sur un établissement sans langue déclarée', () => {
    expect(resolveLocale({ tenant: null })).toBe('en');
  });

  it('une étape illisible ne bloque pas la suivante', () => {
    // Un cookie trafiqué ne doit ni faire tomber la page, ni geler la
    // négociation sur une valeur qui n'existe pas.
    expect(resolveLocale({ explicit: 'es', acceptLanguage: 'fr' })).toBe('fr');
    expect(resolveLocale({ account: 'zz', tenant: 'fr' })).toBe('fr');
  });
});

describe('`asLocale` — ce qui compte comme une langue du contrat', () => {
  it('normalise la casse et les espaces', () => {
    expect(asLocale(' FR ')).toBe('fr');
    expect(asLocale('En')).toBe('en');
  });

  it('refuse tout le reste plutôt que de le corriger', () => {
    for (const value of [null, undefined, '', 'fr-FR', 'français', 'es', '  ']) {
      expect(asLocale(value)).toBeNull();
    }
  });
});

describe('`negotiateLocale` — la lecture d’`Accept-Language`', () => {
  it('une variante régionale compte pour sa langue', () => {
    expect(negotiateLocale('fr-CA')).toBe('fr');
    expect(negotiateLocale('en-GB,en;q=0.9')).toBe('en');
  });

  it('suit les poids, pas l’ordre d’écriture', () => {
    expect(negotiateLocale('en;q=0.3,fr;q=0.9')).toBe('fr');
    expect(negotiateLocale('fr;q=0.2,en;q=0.8')).toBe('en');
  });

  it('départage deux poids égaux par l’ordre d’écriture', () => {
    expect(negotiateLocale('fr,en')).toBe('fr');
    expect(negotiateLocale('en,fr')).toBe('en');
  });

  it('`q=0` est un refus, pas une préférence faible (RFC 9110 §12.5.4)', () => {
    expect(negotiateLocale('fr;q=0,en;q=0.1')).toBe('en');
    expect(negotiateLocale('fr;q=0')).toBeNull();
  });

  it('`*` n’est pas une langue : il laisse la main à l’étape suivante', () => {
    expect(negotiateLocale('*')).toBeNull();
    expect(negotiateLocale('de,*;q=0.5')).toBeNull();
  });

  it('ignore les langues qu’on ne sert pas', () => {
    expect(negotiateLocale('de-DE,de;q=0.9,es;q=0.8')).toBeNull();
    expect(negotiateLocale('de-DE,de;q=0.9,fr;q=0.1')).toBe('fr');
  });

  it('un en-tête vide ou absent ne dit rien', () => {
    for (const header of [null, undefined, '', '   ']) {
      expect(negotiateLocale(header)).toBeNull();
    }
  });

  it('un poids illisible vaut 1, valeur par défaut de la RFC', () => {
    expect(negotiateLocale('fr;q=beaucoup,en;q=0.9')).toBe('fr');
  });
});

describe('les langues servies', () => {
  it('sont exactement celles du contrat, dans l’ordre du sélecteur', () => {
    expect([...SUPPORTED_LOCALES].sort()).toEqual(['en', 'fr']);
  });
});
