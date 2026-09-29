/**
 * Le code pays d'un établissement — #1330, quatrième critère d'acceptation.
 *
 * ## Ce que cette suite protège
 *
 * Les réglages d'un salon acceptaient n'importe quelles deux lettres majuscules :
 * la recette de traduction du 2026-09-29 y a enregistré « ZZ », que rien ne
 * refusait et que `Intl` ne sait pas nommer. Or la colonne ne sert pas qu'à
 * imprimer un nom de pays — elle décide du pays par défaut d'un numéro national
 * (`e164PhoneSchemaFor`) et de l'ordre d'affichage de l'adresse. Un pays
 * inexistant ne se rattrape nulle part en aval.
 *
 * ## Et la dissymétrie, qui est le vrai sujet
 *
 * Refuser à l'écriture **sans** refuser à la lecture. La ligne « ZZ » est en base :
 * durcir la forme stockée aurait fait tomber la vitrine du salon concerné, sa
 * fiche de console et l'écran même où l'on vient corriger la valeur — le front
 * valide chaque réponse d'API contre le contrat. Les deux derniers `describe`
 * sont cette garde, et ils comptent autant que les premiers.
 */

import type { z } from 'zod';

import { submittedCountryCodeSchema, countryCodeSchema } from '../common/identifiers';
import { ISO_3166_1_ALPHA_2_CODES, isCountryCodeAlpha2 } from '../constants/countries';
import { zodErrorMap } from '../errors/zod-messages';
import type { Locale } from '../locale/index';
import { createTenantRequestSchema } from '../schemas/platform';
import {
  countryUsesAddressRegion,
  postalAddressSchema,
  submittedPostalAddressSchema,
  updateTenantRequestSchema,
} from '../schemas/tenant';

const ADDRESS = { line1: '350 5th Avenue', city: 'New York', country: 'US' } as const;

/** Le premier message rendu par un schéma sous la carte d'une langue. */
function refuse(schema: z.ZodTypeAny, value: unknown, locale: Locale): string {
  const result = schema.safeParse(value, { errorMap: zodErrorMap(locale) });

  if (result.success) {
    throw new Error('la valeur a été acceptée, le test n’a rien à lire');
  }

  return result.error.issues[0]?.message ?? '';
}

describe('la liste des pays attribués', () => {
  it('porte les 249 codes de la norme, sans doublon et triés', () => {
    // Le tri n'est pas cosmétique : c'est ce qui rend lisible le diff du jour où
    // l'ISO ajoute ou retire une entrée.
    expect(ISO_3166_1_ALPHA_2_CODES).toHaveLength(249);
    expect(new Set(ISO_3166_1_ALPHA_2_CODES).size).toBe(ISO_3166_1_ALPHA_2_CODES.length);
    expect([...ISO_3166_1_ALPHA_2_CODES].sort()).toEqual([...ISO_3166_1_ALPHA_2_CODES]);
  });

  it('n’a que des codes que la plateforme sait nommer', () => {
    // Le contre-épreuve de la table figée : si un code y était fautif, ICU
    // rendrait le code tel quel au lieu d'un nom de pays. C'est ainsi qu'une
    // coquille de saisie dans une liste de deux cent quarante-neuf entrées se
    // voit, plutôt qu'à la première adresse refusée en production.
    const names = new Intl.DisplayNames(['en'], { type: 'region' });

    for (const code of ISO_3166_1_ALPHA_2_CODES) {
      expect(`${code} → ${String(names.of(code))}`).not.toBe(`${code} → ${code}`);
    }
  });

  it('exclut les codes réservés, dont l’usage privé d’où « ZZ » vient', () => {
    for (const reserved of ['AA', 'QM', 'QZ', 'XA', 'XZ', 'ZZ', 'OO']) {
      expect(`${reserved}:${String(isCountryCodeAlpha2(reserved))}`).toBe(`${reserved}:false`);
    }
    // Ni les abréviations d'usage qui n'en sont pas : « UK » est le code de
    // domaine du Royaume-Uni, la norme écrit « GB ». « EU » n'est pas un pays.
    expect(isCountryCodeAlpha2('UK')).toBe(false);
    expect(isCountryCodeAlpha2('EU')).toBe(false);
    expect(isCountryCodeAlpha2('GB')).toBe(true);
  });

  it('porte les pays du produit', () => {
    for (const code of ['US', 'CA', 'FR', 'MG', 'RE', 'MU', 'BE', 'CH', 'SN', 'CI', 'MA']) {
      expect(`${code}:${String(isCountryCodeAlpha2(code))}`).toBe(`${code}:true`);
    }
  });

  it('juge sur la casse de la norme, sans normaliser à la place du schéma', () => {
    // La normalisation appartient au schéma ou au DTO qui lit la saisie : un
    // prédicat qui l'aurait faite de son côté aurait laissé passer « fr » jusqu'à
    // la base, où la contrainte `CHECK` l'aurait refusé en 500 plutôt qu'en 400.
    expect(isCountryCodeAlpha2('fr')).toBe(false);
    expect(isCountryCodeAlpha2('FR')).toBe(true);
  });
});

describe('le code pays soumis', () => {
  it('normalise la casse puis exige un pays existant', () => {
    expect(submittedCountryCodeSchema.parse(' us ')).toBe('US');
    expect(submittedCountryCodeSchema.safeParse('ZZ').success).toBe(false);
    expect(submittedCountryCodeSchema.safeParse('France').success).toBe(false);
  });

  it('nomme le refus dans la langue de qui lit, non par une phrase figée', () => {
    // #1232 : le schéma pose une **clé**, la carte contextuelle rend la phrase.
    // Un message écrit en dur ici aurait court-circuité la carte, et un gérant
    // anglophone aurait lu le français.
    expect(refuse(submittedCountryCodeSchema, 'ZZ', 'fr')).toContain('n’existe pas');
    expect(refuse(submittedCountryCodeSchema, 'ZZ', 'en')).toContain('no such country');
  });

  it('rend une chaîne, non l’union des deux cent quarante-neuf littéraux', () => {
    // La garde de la lambda annotée `boolean` dans `submittedCountryCodeSchema` :
    // sans elle, TypeScript déduit la garde de type du prédicat, `zod` affine la
    // sortie, et un formulaire qui compose sa charge utile depuis des champs de
    // saisie ne s'assigne plus au contrat. L'assertion est ici une **directive** :
    // c'est `tsc` qui la tient, et il échouerait sur ce fichier.
    const parsed: string = submittedCountryCodeSchema.parse('US');

    expect(parsed).toBe('US');
  });
});

describe('l’adresse soumise', () => {
  it('refuse un pays inventé, et accepte les pays réels', () => {
    expect(submittedPostalAddressSchema.safeParse(ADDRESS).success).toBe(true);
    expect(submittedPostalAddressSchema.safeParse({ ...ADDRESS, country: 'ZZ' }).success).toBe(
      false,
    );
  });

  it('garde la strictesse et le triplet minimal de l’adresse', () => {
    // `.extend()` ne relâche ni le `.strict()` ni les champs requis : une clé
    // inconnue et une ville manquante restent refusées.
    //
    // `region` était l'exemple de clé inconnue de ce test jusqu'à #1335, qui l'a
    // fait entrer au contrat. C'est `state` qui tient désormais le rôle — et le
    // choix n'est pas anodin : c'est le nom qu'un formulaire américain aurait
    // spontanément donné au champ, et le refuser est exactement ce que cette
    // garde doit faire.
    expect(submittedPostalAddressSchema.safeParse({ ...ADDRESS, state: 'NY' }).success).toBe(
      false,
    );
    expect(submittedPostalAddressSchema.safeParse({ line1: 'a', country: 'FR' }).success).toBe(
      false,
    );
  });

  it('accepte l’État en facultatif, sur les deux formes de l’adresse — #1335', () => {
    // La forme soumise l'accepte…
    expect(submittedPostalAddressSchema.safeParse({ ...ADDRESS, region: 'NY' }).success).toBe(
      true,
    );
    // …et la forme stockée aussi, puisque l'une étend l'autre.
    expect(postalAddressSchema.safeParse({ ...ADDRESS, region: 'NY' }).success).toBe(true);

    // Facultative veut dire **absente**, pas vide : une chaîne vide en base
    // produirait « New York,  10118 » — une virgule sans État derrière elle.
    expect(submittedPostalAddressSchema.safeParse({ ...ADDRESS, region: '' }).success).toBe(
      false,
    );

    // Aucune contrainte de pays à la saisie : c'est une règle de présentation
    // (`countryUsesAddressRegion`), pas une règle de données — le jour où le
    // produit ouvre l'Australie, rien ici n'aura à changer.
    expect(
      submittedPostalAddressSchema.safeParse({ ...ADDRESS, country: 'FR', region: 'Bretagne' })
        .success,
    ).toBe(true);
  });

  it('dit quels pays écrivent un État dans leur adresse — #1335', () => {
    expect(countryUsesAddressRegion('US')).toBe(true);
    expect(countryUsesAddressRegion('CA')).toBe(true);
    expect(countryUsesAddressRegion('FR')).toBe(false);
    // Sensible à la casse, comme `isCountryCodeAlpha2` : la normalisation
    // appartient au schéma qui lit la saisie, pas à ce prédicat.
    expect(countryUsesAddressRegion('us')).toBe(false);
    // Un formulaire dont le pays n'est pas encore choisi ne demande pas d'État.
    expect(countryUsesAddressRegion('')).toBe(false);
    expect(countryUsesAddressRegion(null)).toBe(false);
    expect(countryUsesAddressRegion(undefined)).toBe(false);
  });

  it('refuse le pays inventé sur le chemin des réglages du salon', () => {
    expect(updateTenantRequestSchema.safeParse({ address: { ...ADDRESS, country: 'ZZ' } }).success)
      .toBe(false);
    expect(updateTenantRequestSchema.safeParse({ address: ADDRESS }).success).toBe(true);
    // Effacer l'adresse reste possible : `null` retire les cinq colonnes d'un
    // coup, et ce ticket ne change pas ce régime.
    expect(updateTenantRequestSchema.safeParse({ address: null }).success).toBe(true);
  });

  it('refuse le pays inventé sur les deux portes d’ouverture d’un salon', () => {
    const OPENING = {
      slug: 'maison-lotus',
      name: 'Maison Lotus',
      timezone: 'America/New_York',
      defaultCurrency: 'USD',
      addressLine1: '350 5th Avenue',
      city: 'New York',
      adminEmail: 'gerante@maison-lotus.test',
      adminFirstName: 'Ada',
      adminLastName: 'Lovelace',
    };

    expect(createTenantRequestSchema.safeParse({ ...OPENING, countryCode: 'US' }).success).toBe(
      true,
    );
    expect(createTenantRequestSchema.safeParse({ ...OPENING, countryCode: 'ZZ' }).success).toBe(
      false,
    );
  });
});

describe('la forme stockée reste lisible', () => {
  it('sert encore une adresse dont la colonne porte un pays non attribué', () => {
    // La garde qui compte. « ZZ » est en base depuis la recette de #1330 : si la
    // vitrine, la fiche de console et l'écran de réglages ne savaient plus lire
    // cet établissement, on aurait cassé la lecture pour corriger l'écriture — et
    // rendu la valeur fautive impossible à corriger depuis le produit.
    const parsed = postalAddressSchema.parse({ ...ADDRESS, country: 'ZZ' });

    expect(parsed.country).toBe('ZZ');
  });

  it('continue de refuser ce qui n’a pas la forme d’un code pays', () => {
    // Le stock est permissif sur l'existence, pas sur la forme : la colonne est
    // un `CHAR(2)` avec une borne sur les majuscules, et « France » n'y entrerait
    // pas — le refuser ici le dit en 400 plutôt qu'en 500.
    expect(countryCodeSchema.safeParse('France').success).toBe(false);
    expect(countryCodeSchema.parse('zz')).toBe('ZZ');
  });
});
