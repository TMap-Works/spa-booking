import {
  APPOINTMENT_REFERENCE_ALPHABET,
  APPOINTMENT_REFERENCE_LENGTH,
  APPOINTMENT_REFERENCE_PATTERN,
} from '@spa/shared';

import { generateAppointmentReference } from '../appointment-reference';

/**
 * Le tirage de la référence citable — #796.
 *
 * Ce que cette suite tient n'est pas l'unicité : celle-ci est garantie par
 * `appointments_tenant_id_reference_key`, et aucun test en mémoire ne peut la
 * démontrer. Ce qui se vérifie ici est ce dont l'index a besoin pour être utile
 * : que le tirage **couvre** son espace, et qu'il n'émette que la forme que le
 * contrat déclare.
 *
 * Un générateur qui rendrait toujours la même valeur satisferait l'index — une
 * seule référence par salon —, et rendrait le produit inutilisable. Un
 * générateur qui émettrait un `I` ou un `O` produirait une référence qu'une
 * cliente recopierait faux, et que la normalisation de la saisie replierait sur
 * une **autre** : la garantie de résolution tomberait sans qu'aucune contrainte
 * ne rougisse.
 */

/**
 * Assez de tirages pour que la couverture soit un fait, pas une chance.
 *
 * Le collecteur de coupons demande de l'ordre de 130 tirages de symbole pour les
 * trente-deux, et 520 tirages de référence pour les cent suffixes. Deux mille
 * références — donc huit mille symboles — laissent une marge de plus d'un ordre
 * de grandeur, sans faire de cette suite la plus lente du paquet.
 */
const DRAWS = 2_000;

describe('generateAppointmentReference', () => {
  it('rend toujours la forme que le contrat déclare', () => {
    for (let index = 0; index < DRAWS; index += 1) {
      const reference = generateAppointmentReference();
      expect(APPOINTMENT_REFERENCE_PATTERN.test(reference)).toBe(true);
      expect(reference).toHaveLength(APPOINTMENT_REFERENCE_LENGTH);
    }
  });

  it('n’émet jamais un symbole que l’alphabet écarte', () => {
    // `I`, `L`, `O` et `U` sont exclus pour qu'une référence se recopie sans
    // ambiguïté. En émettre un ferait diverger ce qu'on montre de ce qu'on sait
    // relire — `normalizeAppointmentReference` replie `I` sur `1`.
    for (let index = 0; index < DRAWS; index += 1) {
      const [, group] = /^RDV-(.{4})-\d{2}$/.exec(generateAppointmentReference()) ?? [];
      for (const symbol of group ?? '') {
        expect(APPOINTMENT_REFERENCE_ALPHABET).toContain(symbol);
      }
    }
  });

  it('couvre les trente-deux symboles et les cent suffixes', () => {
    const symbols = new Set<string>();
    const suffixes = new Set<string>();

    for (let index = 0; index < DRAWS; index += 1) {
      const reference = generateAppointmentReference();
      for (const symbol of reference.slice(4, 8)) {
        symbols.add(symbol);
      }
      suffixes.add(reference.slice(9));
    }

    // Les deux ensembles complets : c'est ce qui distingue un tirage d'une
    // constante, et ce qui fait que l'espace annoncé est l'espace réel.
    expect(symbols.size).toBe(APPOINTMENT_REFERENCE_ALPHABET.length);
    expect(suffixes.size).toBe(100);
  });

  it('ne rend pas deux fois la même valeur sur un petit nombre de tirages', () => {
    // Pas une garantie d'unicité — l'index la porte —, mais la borne inférieure
    // sans laquelle le tirage n'en vaudrait pas la peine : sur 100 tirages dans
    // un espace de 104 857 600, la probabilité d'une collision est de l'ordre de
    // 5 × 10⁻⁵.
    const drawn = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      drawn.add(generateAppointmentReference());
    }

    expect(drawn.size).toBe(100);
  });
});
