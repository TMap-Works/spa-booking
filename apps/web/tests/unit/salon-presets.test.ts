import {
  countryCodeSchema,
  currencyCodeSchema,
  isCountryCodeAlpha2,
  timeZoneSchema,
} from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  COUNTRY_PRESETS,
  CURRENCY_CHOICES,
  DEFAULT_COUNTRY,
  TIMEZONE_CHOICES,
  countryChoices,
  countryLabel,
  countryPreset,
  timezoneChoices,
  timezoneLabel,
  timezonesOf,
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

/**
 * Ceux du Canada. L'Eastern en tête : c'est lui que le pays présélectionne.
 *
 * `America/Regina` y est entré avec #1330 : la Saskatchewan ne change pas
 * d'heure, et un salon de Regina n'avait aucun fuseau juste à choisir.
 */
const CA_TIMEZONES = [
  'America/Toronto',
  'America/Halifax',
  'America/St_Johns',
  'America/Winnipeg',
  'America/Regina',
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
      // Et le pays doit **exister**, non seulement avoir la forme d'un code
      // (#1330) : depuis ce ticket l'API refuse l'ouverture d'un salon sur un
      // code non attribué, et un préréglage inventé serait une impasse en bout
      // de formulaire.
      expect(isCountryCodeAlpha2(country.code), country.code).toBe(true);
    }
  });
});

describe('les fuseaux proposés', () => {
  it('propose les sept fuseaux des États-Unis, l’Eastern en tête', () => {
    expect(countryPreset('US')?.timezones).toEqual(US_TIMEZONES);
  });

  it('propose les sept fuseaux du Canada, l’Eastern en tête', () => {
    expect(countryPreset('CA')?.timezones).toEqual(CA_TIMEZONES);
  });

  it('restreint la liste aux fuseaux du pays choisi', () => {
    expect(timezonesOf('US')).toEqual(US_TIMEZONES);
    expect(timezonesOf('CA')).toEqual(CA_TIMEZONES);
    expect(timezonesOf('FR')).toEqual(['Europe/Paris']);
    // Aucun débordement : un salon américain ne se voit pas proposer La Réunion.
    expect(timezonesOf('US')).not.toContain('Indian/Reunion');
  });

  it('retombe sur la liste complète pour un pays qu’elle ne connaît pas', () => {
    // Un `<select>` sans option afficherait une valeur que le formulaire ne
    // porte pas — c'est-à-dire un fuseau que personne n'a choisi.
    expect(timezonesOf('ZZ')).toEqual(TIMEZONE_CHOICES);
    expect(timezonesOf('ZZ').length).toBeGreaterThan(0);
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

/**
 * Les noms de pays suivent la langue lue — #1105, troisième critère
 * d'acceptation.
 *
 * Le `label` figé des préréglages est français : un salon américain lisait
 * « États-Unis » sur le formulaire qui l'ouvrait. Les noms viennent désormais
 * d'`Intl.DisplayNames`, pour la même raison que les décimales d'une devise
 * viennent d'`Intl` — une table maison aurait fini par diverger de la norme.
 */
describe('les noms de pays (#1105)', () => {
  it('nomme chaque pays dans la langue demandée', () => {
    expect(countryLabel('US', 'en')).toBe('United States');
    expect(countryLabel('US', 'fr')).toBe('États-Unis');
    expect(countryLabel('CA', 'en')).toBe('Canada');
    expect(countryLabel('FR', 'en')).toBe('France');
    expect(countryLabel('FR', 'fr')).toBe('France');
  });

  it('nomme tous les pays proposés, sans jamais rendre un code nu', () => {
    for (const locale of ['fr', 'en'] as const) {
      for (const country of COUNTRY_PRESETS) {
        const label = countryLabel(country.code, locale);

        expect(label, `${country.code}/${locale}`).not.toBe(country.code);
        expect(label.length, `${country.code}/${locale}`).toBeGreaterThan(1);
      }
    }
  });

  it('retombe sur le préréglage, puis sur le code, pour ce qu’`Intl` ne connaît pas', () => {
    // « QQ » est un code à usage privé : ni `Intl` ni les préréglages ne le
    // portent, et il vaut mieux voir le code qu'une case vide dans une liste.
    // (« ZZ », lui, est le code CLDR de la région inconnue — `Intl` le nomme.)
    expect(countryLabel('QQ', 'en')).toBe('QQ');
  });

  it('garde l’ordre des préréglages, qui porte la présélection', () => {
    // Trier sur le nom traduit ferait dépendre de la langue le pays qui ouvre la
    // liste — or ce premier rang est une décision produit (#1103).
    for (const locale of ['fr', 'en'] as const) {
      const choices = countryChoices(locale);

      expect(choices.map((choice) => choice.code)).toEqual(
        COUNTRY_PRESETS.map((country) => country.code),
      );
      expect(choices[0]?.code).toBe(DEFAULT_COUNTRY.code);
    }
  });

  it('rend les mêmes noms que `countryLabel`, choix par choix', () => {
    for (const choice of countryChoices('en')) {
      expect(choice.label).toBe(countryLabel(choice.code, 'en'));
    }
  });
});

/**
 * Les libellés de fuseau — #1330, deuxième critère d'acceptation.
 *
 * Les fuseaux se choisissaient sous leur identifiant IANA nu :
 * « America/St_Johns » demandait de connaître la nomenclature pour ouvrir un
 * salon. Ils portent désormais le nom du fuseau **et** sa ville, le premier
 * traduit par ICU, la seconde laissée telle quelle — c'est un nom de lieu.
 */
describe('les libellés de fuseau (#1330)', () => {
  it('nomme le fuseau et sa ville, dans la langue lue', () => {
    expect(timezoneLabel('America/New_York', 'en')).toBe('Eastern Time (New York)');
    expect(timezoneLabel('America/New_York', 'fr')).toBe('heure de l’Est nord-américain (New York)');
  });

  it('ne nomme pas la saison sur un fuseau qui change d’heure', () => {
    // « Eastern Daylight Time » serait faux la moitié de l'année, et un libellé
    // qui suivrait la saison changerait deux fois par an sous les yeux de
    // l'utilisatrice. C'est la forme `longGeneric` d'ICU qui l'évite.
    //
    // La règle ne vaut **que** pour les fuseaux qui changent d'heure : Phoenix et
    // Regina n'en changent pas, et ICU les nomme « Mountain Standard Time » /
    // « Central Standard Time » — ce qui est exact toute l'année, et précisément
    // ce qui les distingue de Denver et de Winnipeg.
    for (const locale of ['fr', 'en'] as const) {
      for (const timezone of ['America/New_York', 'America/Denver', 'Europe/Paris']) {
        const label = timezoneLabel(timezone, locale);

        expect(label, `${timezone}/${locale}`).not.toMatch(
          /standard|daylight|avancée|d’été|d’hiver/iu,
        );
      }
    }
  });

  it('distingue la Saskatchewan du Manitoba, qui partagent l’heure sans partager l’été', () => {
    // La raison d'être de `America/Regina` dans la liste (#1330) : les deux sont
    // au centre en hiver, une seule avance en été.
    expect(timezoneLabel('America/Regina', 'en')).toBe('Central Standard Time (Regina)');
    expect(timezoneLabel('America/Winnipeg', 'en')).toBe('Central Time (Winnipeg)');
  });

  it('remplace les tirets bas de l’identifiant par des espaces', () => {
    expect(timezoneLabel('America/Los_Angeles', 'en')).toContain('(Los Angeles)');
    expect(timezoneLabel('America/St_Johns', 'en')).toContain('(St Johns)');
  });

  it('ne rend jamais un identifiant IANA nu, dans aucune des deux langues', () => {
    // C'est l'écart que le ticket corrige : une gérante lisait
    // « America/St_Johns » dans le sélecteur qui ouvre son salon.
    for (const locale of ['fr', 'en'] as const) {
      for (const timezone of TIMEZONE_CHOICES) {
        const label = timezoneLabel(timezone, locale);

        expect(label, `${timezone}/${locale}`).not.toBe(timezone);
        expect(label, `${timezone}/${locale}`).not.toContain('/');
        expect(label, `${timezone}/${locale}`).not.toContain('_');
      }
    }
  });

  it('distingue les sept fuseaux d’un même pays', () => {
    // Deux options de même libellé rendraient le sélecteur inutilisable : c'est
    // tout l'objet d'accoler la ville au nom du fuseau, puisque Phoenix et Denver
    // partagent « Mountain Time ».
    for (const code of ['US', 'CA']) {
      const labels = timezoneChoices(code, 'en').map((choice) => choice.label);

      expect(new Set(labels).size, code).toBe(labels.length);
    }
  });

  it('garde l’identifiant IANA comme valeur du choix, et l’ordre du pays', () => {
    // C'est la seule forme que `timeZoneSchema` accepte : le libellé habille
    // l'option, il ne remplace pas ce que le formulaire soumet.
    for (const locale of ['fr', 'en'] as const) {
      const choices = timezoneChoices('CA', locale);

      expect(choices.map((choice) => choice.timezone)).toEqual(CA_TIMEZONES);
      for (const choice of choices) {
        expect(timeZoneSchema.safeParse(choice.timezone).success, choice.timezone).toBe(true);
        expect(choice.label).toBe(timezoneLabel(choice.timezone, locale));
      }
    }
  });

  it('retombe sur la ville seule pour un fuseau qu’`Intl` ne connaît pas', () => {
    // Un sélecteur reste utilisable avec « Nowhere » ; il ne l'est plus avec une
    // option vide, et il ne doit pas faire tomber l'écran.
    expect(timezoneLabel('Mars/Nowhere', 'en')).toBe('Nowhere');
  });
});
