import type { PostalAddress } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import { addressLines } from '@/components/salon/salon-address';

/**
 * Les lignes d'une adresse de salon, et la seule d'entre elles qui se traduit —
 * #846, corrigé par #1297.
 *
 * ## Ce que cette suite protège
 *
 * Une adresse est du contenu de salon : la voie, le complément, le code postal et
 * la ville s'affichent tels que la gérante les a saisis. Le **pays** est
 * l'exception — `Intl.DisplayNames` l'écrit dans la langue du lecteur à partir du
 * code ISO du contrat —, et c'est par lui que le français est resté sur les
 * écrans anglais : le paramètre de langue était facultatif, son repli valait
 * `fr-FR`, et cinq surfaces ne le passaient pas. Le pied de page de **toutes** les
 * pages publiques en faisait partie, si bien qu'un visiteur anglais lisait
 * « États-Unis » sous un écran entièrement anglais.
 *
 * Le paramètre est obligatoire depuis : le dernier cas de cette suite est la
 * garde, et c'est `tsc` qui la tient.
 */

const PARIS: PostalAddress = {
  line1: '12 rue des Lilas',
  postalCode: '75011',
  city: 'Paris',
  country: 'FR',
};

describe('addressLines — la forme d’une enveloppe', () => {
  it('rend la voie, la localité et le pays, chacun sur sa ligne', () => {
    // Ni virgules ni format national : une adresse se lit en lignes, et le code
    // postal partage la sienne avec la ville comme sur une enveloppe.
    expect(addressLines(PARIS, { locale: 'fr' })).toEqual([
      '12 rue des Lilas',
      '75011 Paris',
      'France',
    ]);
  });

  it('insère le complément entre la voie et la localité, quand il y en a un', () => {
    expect(addressLines({ ...PARIS, line2: 'Bâtiment B' }, { locale: 'fr' })).toEqual([
      '12 rue des Lilas',
      'Bâtiment B',
      '75011 Paris',
      'France',
    ]);
  });
});

describe('addressLines — le pays suit la langue de l’écran (#1297)', () => {
  it('écrit le même code ISO dans les deux langues', () => {
    const usa: PostalAddress = {
      line1: '1 Market Street',
      postalCode: '94105',
      city: 'San Francisco',
      country: 'US',
    };

    expect(addressLines(usa, { locale: 'fr' }).at(-1)).toBe('États-Unis');
    expect(addressLines(usa, { locale: 'en' }).at(-1)).toBe('United States');
  });

  it('laisse le reste de l’adresse intact : c’est du contenu de salon', () => {
    // La langue ne retouche ni la voie ni la ville — les traduire réécrirait ce
    // que la gérante a saisi, et une cliente qui cherche « rue des Lilas » sur
    // place ne trouverait pas « Lilac Street ».
    const [line1, locality] = addressLines(PARIS, { locale: 'en' });

    expect(line1).toBe('12 rue des Lilas');
    expect(locality).toBe('75011 Paris');
  });

  it('retombe sur le code plutôt que sur une ligne vide, si le code est inconnu', () => {
    // `Intl.DisplayNames` rend son entrée telle quelle sur un code non attribué :
    // mieux vaut « QQ » qu'une ligne blanche au bas d'une adresse. `ZZ` ne
    // conviendrait pas pour l'éprouver — ICU le connaît et l'écrit « Unknown
    // Region », ce qui serait pire qu'un code brut sur une enveloppe.
    expect(addressLines({ ...PARIS, country: 'QQ' }, { locale: 'en' }).at(-1)).toBe('QQ');
    expect(addressLines({ ...PARIS, country: 'QQ' }, { locale: 'fr' }).at(-1)).toBe('QQ');
  });

  it('refuse à la compilation l’appel qui omet la langue', () => {
    // La garde est la **directive**, non l'assertion : rendre le paramètre
    // facultatif à nouveau priverait `@ts-expect-error` de l'erreur qu'il
    // couvre, et `npm run typecheck` échouerait ici — avant qu'un écran ne se
    // remette à annoncer « États-Unis » en anglais.
    // @ts-expect-error — le contexte d'affichage est obligatoire depuis #1297.
    expect(() => addressLines(PARIS)).toBeDefined();
  });
});
