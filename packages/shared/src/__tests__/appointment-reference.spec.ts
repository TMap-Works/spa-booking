/**
 * La référence citable d'un rendez-vous — `RDV-XXXX-NN` (#796).
 *
 * Ce que cette suite tient n'est pas la **forme** pour elle-même : c'est le fait
 * qu'un code lu sur un écran, recopié à la main puis dicté au téléphone
 * retrouve, à l'autre bout, exactement le même rendez-vous. La normalisation est
 * donc le sujet, et la forme émise en est la borne.
 */

import {
  APPOINTMENT_REFERENCE_ALPHABET,
  APPOINTMENT_REFERENCE_LENGTH,
  APPOINTMENT_REFERENCE_PATTERN,
  appointmentReferenceSchema,
  citedAppointmentReferenceSchema,
  isAppointmentReference,
  normalizeAppointmentReference,
} from '../index';

describe('la forme émise', () => {
  it('est celle que le wireframe écrit — « Réf. RDV-8F3K-27 »', () => {
    expect(appointmentReferenceSchema.safeParse('RDV-8F3K-27').success).toBe(true);
    expect('RDV-8F3K-27'.length).toBe(APPOINTMENT_REFERENCE_LENGTH);
  });

  it('exclut les quatre symboles que Crockford écarte', () => {
    // `I`, `L` et `O` se confondent avec `1` et `0` dans la plupart des fontes ;
    // `U` part avec elles. Les émettre ferait recopier des références fausses.
    for (const symbol of ['I', 'L', 'O', 'U']) {
      expect(APPOINTMENT_REFERENCE_ALPHABET).not.toContain(symbol);
      expect(isAppointmentReference(`RDV-${symbol}F3K-27`)).toBe(false);
    }
  });

  it('refuse un suffixe qui n’est pas décimal, et une longueur qui n’est pas la bonne', () => {
    expect(isAppointmentReference('RDV-8F3K-2A')).toBe(false);
    expect(isAppointmentReference('RDV-8F3K-275')).toBe(false);
    expect(isAppointmentReference('RDV-8F3-27')).toBe(false);
    expect(isAppointmentReference('8F3K-27')).toBe(false);
  });

  it('compte exactement trente-deux symboles, tous acceptés par le motif', () => {
    expect(new Set(APPOINTMENT_REFERENCE_ALPHABET).size).toBe(32);

    for (const symbol of APPOINTMENT_REFERENCE_ALPHABET) {
      expect(APPOINTMENT_REFERENCE_PATTERN.test(`RDV-${symbol}${symbol}${symbol}${symbol}-27`)).toBe(
        true,
      );
    }
  });
});

describe('la référence telle qu’on la dicte', () => {
  it('absorbe la casse, les espaces et les séparateurs', () => {
    for (const cited of ['rdv-8f3k-27', 'RDV 8F3K 27', 'rdv8f3k27', '  RDV-8F3K-27  ']) {
      expect(citedAppointmentReferenceSchema.parse(cited)).toBe('RDV-8F3K-27');
    }
  });

  it('accepte les six caractères seuls — c’est ainsi qu’une cliente les lit', () => {
    expect(citedAppointmentReferenceSchema.parse('8F3K-27')).toBe('RDV-8F3K-27');
    expect(citedAppointmentReferenceSchema.parse('8f3k27')).toBe('RDV-8F3K-27');
  });

  it('replie les confusions de fonte, comme le décodage de Crockford le prescrit', () => {
    // Ne pas **émettre** `I`, `L` et `O` ne sert à rien si on refuse de les
    // **lire** : c'est la personne qui recopie qui les produit, pas nous.
    expect(citedAppointmentReferenceSchema.parse('RDV-I23K-27')).toBe('RDV-123K-27');
    expect(citedAppointmentReferenceSchema.parse('RDV-L23K-27')).toBe('RDV-123K-27');
    expect(citedAppointmentReferenceSchema.parse('RDV-O23K-27')).toBe('RDV-023K-27');
    expect(citedAppointmentReferenceSchema.parse('RDV-8F3K-O7')).toBe('RDV-8F3K-07');
  });

  it('ne replie pas `U`, que Crockford ne replie sur rien', () => {
    expect(citedAppointmentReferenceSchema.safeParse('RDV-U23K-27').success).toBe(false);
  });

  it('n’ampute pas une référence dont le groupe commence par « RDV »', () => {
    // Le préfixe ne se retire que si la longueur dit qu'il est là. Un retrait
    // par simple préfixe de chaîne aurait rendu `RDVA-14` illisible.
    expect(citedAppointmentReferenceSchema.parse('RDV-RDVA-14')).toBe('RDV-RDVA-14');
    expect(citedAppointmentReferenceSchema.parse('RDVA-14')).toBe('RDV-RDVA-14');
  });

  it('refuse ce qui n’est pas une référence, plutôt que de deviner', () => {
    for (const cited of ['', 'bonjour', 'RDV-8F3K', '8F3K-275', 'RDV-8F3K-2A']) {
      expect(citedAppointmentReferenceSchema.safeParse(cited).success).toBe(false);
    }
  });

  it('rend la chaîne nettoyée quand elle n’a pas la bonne longueur — au schéma de refuser', () => {
    // La normalisation ne complète rien : un code tronqué reste un code
    // tronqué, et c'est le message du schéma qui nomme le champ fautif.
    expect(normalizeAppointmentReference('8F3K')).toBe('8F3K');
  });
});
