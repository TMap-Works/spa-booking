/**
 * L'ordre de la localité dans une adresse de salon — #1330, monté dans le
 * contrat par #1334.
 *
 * ## Ce que cette suite protège
 *
 * Une adresse nord-américaine écrit « New York 10118 », une adresse française
 * « 75011 Paris ». La règle vivait dans un module du front
 * (`apps/web/components/salon/salon-address.ts`), d'où trois surfaces ne
 * pouvaient pas l'atteindre : le ticket de caisse, le PDF du reçu et les e-mails.
 * Elles recomposaient chacune la leur et gardaient l'ordre français sur un salon
 * de Manhattan.
 *
 * Elle est ici parce que c'est le seul endroit que le front **et** le serveur
 * voient — même raison que `formatReceiptNumber`. Ce que cette suite fige, c'est
 * la règle elle-même ; chaque surface a son propre cas, sur un salon US et un
 * salon FR, là où elle est écrite.
 *
 * ## Le critère est le pays du salon, jamais la langue du lecteur
 *
 * Aucun paramètre de langue n'entre dans ces fonctions, et c'est délibéré :
 * l'adresse d'un salon parisien lu en anglais reste « 75011 Paris », parce que
 * c'est ce qu'on écrit sur l'enveloppe qu'on lui poste.
 */

import {
  addressLocalityLine,
  addressLocalityParts,
  CITY_BEFORE_POSTAL_CODE_COUNTRIES,
} from '../schemas/tenant';

describe('addressLocalityLine — l’ordre suit le pays du salon', () => {
  it('écrit la ville avant le code postal en Amérique du Nord', () => {
    expect(
      addressLocalityLine({ postalCode: '10118', city: 'New York', country: 'US' }),
    ).toBe('New York 10118');
    expect(
      addressLocalityLine({ postalCode: 'M5V 3L9', city: 'Toronto', country: 'CA' }),
    ).toBe('Toronto M5V 3L9');
  });

  it('écrit le code postal en tête partout ailleurs', () => {
    expect(addressLocalityLine({ postalCode: '75011', city: 'Paris', country: 'FR' })).toBe(
      '75011 Paris',
    );
    expect(
      addressLocalityLine({ postalCode: '1000', city: 'Bruxelles', country: 'BE' }),
    ).toBe('1000 Bruxelles');
    // Un pays inconnu du contrat — « ZZ » est en base (#1330) — retombe sur la
    // forme majoritaire plutôt que de rendre une ligne vide.
    expect(addressLocalityLine({ postalCode: '75011', city: 'Paris', country: 'ZZ' })).toBe(
      '75011 Paris',
    );
  });

  it('omet le morceau qui manque, sans espace en trop', () => {
    // Tous les pays n'ont pas de code postal (`postalAddressSchema`).
    expect(addressLocalityLine({ city: 'Dakar', country: 'SN' })).toBe('Dakar');
    expect(addressLocalityLine({ postalCode: null, city: 'New York', country: 'US' })).toBe(
      'New York',
    );
    // Côté serveur, les colonnes sont nullables et une adresse peut être vide.
    expect(addressLocalityLine({ postalCode: null, city: null, country: null })).toBe('');
    // Une colonne blanchie par une reprise de données n'est pas un morceau écrit.
    expect(addressLocalityLine({ postalCode: '   ', city: 'Paris', country: 'FR' })).toBe(
      'Paris',
    );
  });

  it('sépare la ville de l’État par une virgule, jamais du code postal — #1335', () => {
    expect(
      addressLocalityLine({
        postalCode: '10118',
        city: 'New York',
        region: 'NY',
        country: 'US',
      }),
    ).toBe('New York, NY 10118');
    // Sans État, pas de virgule du tout : « New York, 10118 » n'est la forme
    // d'aucune convention postale.
    expect(
      addressLocalityLine({
        postalCode: '10118',
        city: 'New York',
        region: null,
        country: 'US',
      }),
    ).toBe('New York 10118');
    // Un salon passé des États-Unis à la France garde « NY » en colonne : on ne
    // l'écrit pas dans une adresse qui ne sait pas où le mettre.
    expect(
      addressLocalityLine({ postalCode: '75011', city: 'Paris', region: 'NY', country: 'FR' }),
    ).toBe('75011 Paris');
  });
});

describe('addressLocalityParts — le même ordre, une autre ponctuation', () => {
  it('rend les morceaux dans l’ordre du pays, l’État compris', () => {
    expect(
      addressLocalityParts({
        postalCode: '10118',
        city: 'New York',
        region: 'NY',
        country: 'US',
      }),
    ).toEqual(['New York', 'NY', '10118']);
    expect(addressLocalityParts({ postalCode: '75011', city: 'Paris', country: 'FR' })).toEqual(
      ['75011', 'Paris'],
    );
  });
});

describe('la liste des pays à ville en tête', () => {
  /**
   * Le garde-fou du choix écrit sur la constante : ce n'est pas une table des
   * conventions postales du monde. Un pays qu'on y ajoute doit se voir sur une
   * ligne de diff, et ce cas est ce qui l'y oblige.
   */
  it('ne compte que le périmètre nord-américain', () => {
    expect([...CITY_BEFORE_POSTAL_CODE_COUNTRIES]).toEqual(['US', 'CA']);
  });

  it('est sensible à la casse, comme le reste du contrat', () => {
    // Le contrat porte ces codes en majuscules : la normalisation appartient au
    // schéma qui lit la saisie, pas à la composition de l'adresse.
    expect(addressLocalityLine({ postalCode: '10118', city: 'New York', country: 'us' })).toBe(
      '10118 New York',
    );
  });
});
