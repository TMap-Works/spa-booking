/**
 * Le vocabulaire des langues — #844, la fondation de l'épique #843.
 *
 * Ce que cette suite garde tient en une phrase : **`fr` et `en`, et rien
 * d'autre**. C'est le neuvième critère d'acceptation du ticket, et c'est une
 * frontière que quatorze tickets vont traverser — parcours public, espace
 * client, back-office, console, notifications. Un `de` accepté ici deviendrait
 * une colonne que la contrainte `CHECK` refuse, donc un 500 sur une saisie.
 */

import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  localeSchema,
  submittedLocaleSchema,
} from '../locale/index';

describe('localeSchema', () => {
  it.each([...LOCALES])('accepte %s', (locale) => {
    expect(localeSchema.parse(locale)).toBe(locale);
  });

  it.each([
    ['une langue hors périmètre', 'de'],
    ['une variante régionale', 'fr-CA'],
    ['la majuscule', 'FR'],
    ['une chaîne vide', ''],
    ['un nom de langue', 'français'],
  ])('refuse %s', (_cas, value) => {
    expect(localeSchema.safeParse(value).success).toBe(false);
  });

  it('refuse ce qui n’est pas une chaîne', () => {
    for (const value of [null, undefined, 1, {}, ['fr']]) {
      expect(localeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rend un message lisible par qui a saisi, pas par une console', () => {
    const refus = localeSchema.safeParse('de');

    expect(refus.success).toBe(false);
    if (!refus.success) {
      // Le défaut de Zod — « Invalid enum value. Expected 'fr' | 'en' » —
      // remonterait tel quel jusqu'au formulaire de réglages.
      expect(refus.error.issues[0]?.message).toBe('langue attendue parmi fr, en');
    }
  });
});

describe('submittedLocaleSchema', () => {
  it.each([
    ['FR', 'fr'],
    [' en ', 'en'],
    ['Fr', 'fr'],
  ])('normalise %s en %s', (submitted, expected) => {
    expect(submittedLocaleSchema.parse(submitted)).toBe(expected);
  });

  it('normalise la casse sans élargir le vocabulaire', () => {
    // La normalisation corrige une saisie qui n'a qu'un sens ; elle n'accepte
    // pas une valeur qui n'en a aucun.
    expect(submittedLocaleSchema.safeParse('DE').success).toBe(false);
    expect(submittedLocaleSchema.safeParse('FR-ca').success).toBe(false);
  });
});

describe('isLocale', () => {
  it('reconnaît les deux langues du contrat, et elles seules', () => {
    expect(isLocale('fr')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('FR')).toBe(false);
    expect(isLocale('de')).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });
});

describe('DEFAULT_LOCALE', () => {
  it('vaut `en` — décision du PO du 2026-09-19, clientèle nord-américaine', () => {
    // La valeur est reprise par la colonne `tenants.default_locale`, par le
    // seed, par l'inscription libre-service (ADR 0016) et par l'ouverture depuis
    // la console (ADR 0012). Ce test est ce qui les tient d'accord : la changer
    // ici sans changer la migration ferait diverger un salon déjà en base d'un
    // salon créé demain.
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale(DEFAULT_LOCALE)).toBe(true);
  });
});
