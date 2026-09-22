import { countryCodeSchema, currencyCodeSchema, timeZoneSchema } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  COUNTRY_PRESETS,
  CURRENCY_CHOICES,
  DEFAULT_COUNTRY,
  TIMEZONE_CHOICES,
  countryPreset,
  timezoneChoices,
} from '@/lib/salon-presets';

/**
 * Les préréglages d'ouverture d'un salon (#1103).
 *
 * Ce qui se joue ici n'est pas cosmétique : un salon ouvert dans le mauvais
 * fuseau affiche **tous** ses créneaux décalés, ce que CLAUDE.md classe en
 * sévérité haute et que l'ADR 0006 fonde. Un identifiant IANA mal orthographié
 * dans la liste ne se voit pas à l'œil — il se voit ici.
 */

/** Les fuseaux que le ticket exige des États-Unis, dans l'ordre. */
const US_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
];

/** Ceux du Canada. L'Eastern en tête : c'est lui que le pays présélectionne. */
const CA_TIMEZONES = [
  'America/Toronto',
  'America/Halifax',
  'America/St_Johns',
  'America/Winnipeg',
  'America/Edmonton',
  'America/Vancouver',
];

describe('les pays proposés à l’ouverture d’un salon', () => {
  it('propose les États-Unis en dollar américain', () => {
    const us = countryPreset('US');

    expect(us).toBeDefined();
    expect(us?.currency).toBe('USD');
  });

  it('propose le Canada en dollar canadien', () => {
    const ca = countryPreset('CA');

    expect(ca).toBeDefined();
    expect(ca?.currency).toBe('CAD');
  });

  it('présélectionne les États-Unis', () => {
    expect(DEFAULT_COUNTRY.code).toBe('US');
    expect(DEFAULT_COUNTRY.timezones[0]).toBe('America/New_York');
    expect(DEFAULT_COUNTRY.currency).toBe('USD');
  });

  it('garde les pays déjà proposés avant ce ticket', () => {
    const codes = COUNTRY_PRESETS.map((country) => country.code);

    // La liste d'avant #1103, au complet. Un salon existant garde son fuseau et
    // sa devise, mais encore faut-il pouvoir en ouvrir un nouveau au même
    // endroit.
    for (const code of ['FR', 'MG', 'RE', 'MU', 'BE', 'CH', 'CA', 'SN', 'CI', 'MA']) {
      expect(codes).toContain(code);
    }
  });

  it('garde à chaque pays d’avant son fuseau et sa devise', () => {
    // Le Canada excepté : il ne se limite plus au Québec, et son premier fuseau
    // reste précisément celui que « Canada (Québec) » posait.
    const before: Record<string, readonly [string, string]> = {
      FR: ['Europe/Paris', 'EUR'],
      MG: ['Indian/Antananarivo', 'MGA'],
      RE: ['Indian/Reunion', 'EUR'],
      MU: ['Indian/Mauritius', 'MUR'],
      BE: ['Europe/Brussels', 'EUR'],
      CH: ['Europe/Zurich', 'CHF'],
      CA: ['America/Toronto', 'CAD'],
      SN: ['Africa/Dakar', 'XOF'],
      CI: ['Africa/Abidjan', 'XOF'],
      MA: ['Africa/Casablanca', 'MAD'],
    };

    for (const [code, [timezone, currency]] of Object.entries(before)) {
      const preset = countryPreset(code);
      expect(preset?.timezones[0], code).toBe(timezone);
      expect(preset?.currency, code).toBe(currency);
    }
  });

  it('n’expose aucun pays en double', () => {
    const codes = COUNTRY_PRESETS.map((country) => country.code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('nomme chaque pays par un code ISO 3166-1 alpha-2 et chaque devise par un code ISO 4217', () => {
    // La même règle que celle dont l'API juge la requête d'ouverture
    // (`createTenantRequestSchema`) : un préréglage que le contrat refuserait
    // serait une impasse en bout de formulaire.
    for (const country of COUNTRY_PRESETS) {
      expect(countryCodeSchema.safeParse(country.code).success, country.code).toBe(true);
      expect(currencyCodeSchema.safeParse(country.currency).success, country.currency).toBe(true);
    }
  });
});

describe('les fuseaux proposés', () => {
  it('propose les sept fuseaux des États-Unis, l’Eastern en tête', () => {
    expect(countryPreset('US')?.timezones).toEqual(US_TIMEZONES);
  });

  it('propose les six fuseaux du Canada, l’Eastern en tête', () => {
    expect(countryPreset('CA')?.timezones).toEqual(CA_TIMEZONES);
  });

  it('restreint la liste aux fuseaux du pays choisi', () => {
    expect(timezoneChoices('US')).toEqual(US_TIMEZONES);
    expect(timezoneChoices('CA')).toEqual(CA_TIMEZONES);
    expect(timezoneChoices('FR')).toEqual(['Europe/Paris']);
    // Aucun débordement : un salon américain ne se voit pas proposer La Réunion.
    expect(timezoneChoices('US')).not.toContain('Indian/Reunion');
  });

  it('retombe sur la liste complète pour un pays qu’elle ne connaît pas', () => {
    // Un `<select>` sans option afficherait une valeur que le formulaire ne
    // porte pas — c'est-à-dire un fuseau que personne n'a choisi.
    expect(timezoneChoices('ZZ')).toEqual(TIMEZONE_CHOICES);
    expect(timezoneChoices('ZZ').length).toBeGreaterThan(0);
  });

  it('ne laisse aucun pays sans fuseau', () => {
    for (const country of COUNTRY_PRESETS) {
      expect(country.timezones.length, country.code).toBeGreaterThan(0);
    }
  });

  it('n’expose aucun fuseau en double au sein d’un pays', () => {
    for (const country of COUNTRY_PRESETS) {
      expect(new Set(country.timezones).size, country.code).toBe(country.timezones.length);
    }
  });

  /**
   * Le test qui compte.
   *
   * `Intl` lève sur un identifiant inconnu : c'est la même bibliothèque ICU que
   * celle dont dépend la conversion des créneaux à l'affichage, et celle sur
   * laquelle `timeZoneSchema` fonde son refus côté API. Une faute de frappe
   * (« America/Los_Angelas ») passerait la relecture, passerait le formulaire,
   * et ne se verrait qu'au premier rendez-vous décalé.
   *
   * L'égalité avec la forme canonique est exigée en plus de l'absence de levée :
   * un alias historique (« US/Eastern ») est accepté par ICU mais n'est pas le
   * nom que l'on veut voir stocké dans `tenants.timezone`.
   */
  it('n’offre que des fuseaux qu’`Intl` reconnaît, sous leur nom canonique', () => {
    expect(TIMEZONE_CHOICES.length).toBeGreaterThan(0);

    for (const timezone of TIMEZONE_CHOICES) {
      expect(
        () => new Intl.DateTimeFormat('en-US', { timeZone: timezone }),
        timezone,
      ).not.toThrow();
      expect(
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone,
        timezone,
      ).toBe(timezone);
      // Et la même règle vue depuis le contrat, qui est ce que l'API appliquera.
      expect(timeZoneSchema.safeParse(timezone).success, timezone).toBe(true);
    }
  });

  it('réunit dans `TIMEZONE_CHOICES` les fuseaux de tous les pays, sans doublon', () => {
    for (const country of COUNTRY_PRESETS) {
      for (const timezone of country.timezones) {
        expect(TIMEZONE_CHOICES, `${country.code}/${timezone}`).toContain(timezone);
      }
    }
    expect(new Set(TIMEZONE_CHOICES).size).toBe(TIMEZONE_CHOICES.length);
  });
});

describe('les devises proposées', () => {
  it('propose le dollar américain et le dollar canadien, sans doublon', () => {
    expect(CURRENCY_CHOICES).toContain('USD');
    expect(CURRENCY_CHOICES).toContain('CAD');
    expect(new Set(CURRENCY_CHOICES).size).toBe(CURRENCY_CHOICES.length);
  });
});
