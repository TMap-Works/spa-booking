import { randomInt } from 'node:crypto';

import {
  APPOINTMENT_REFERENCE_ALPHABET,
  APPOINTMENT_REFERENCE_GROUP_LENGTH,
  APPOINTMENT_REFERENCE_PREFIX,
  APPOINTMENT_REFERENCE_SUFFIX_LENGTH,
} from '@spa/shared';

/**
 * Le tirage de la référence citable — `RDV-8F3K-27` (#796).
 *
 * **Fonction pure d'un générateur d'aléa**, sans Nest, sans Prisma : c'est le
 * repository qui l'appelle, à l'intérieur de la transaction qui insère la ligne.
 *
 * ## Elle tire, elle ne dérive pas
 *
 * #736 calculait la référence à partir de l'identifiant du rendez-vous. C'était
 * la voie économique — rien à stocker, rien à contraindre — et c'est celle que
 * #796 écarte : une fonction de l'identifiant produit des collisions qu'aucune
 * contrainte ne rattrape, et une référence ambiguë résolue au comptoir désigne
 * la mauvaise cliente.
 *
 * Ce qui garantit l'unicité n'est donc pas ce fichier : c'est
 * `appointments_tenant_id_reference_key`. Ici, on tire ; la base tranche, et le
 * repository rejoue le tirage si elle refuse. C'est la doctrine du module,
 * inchangée depuis le créneau — « la base tranche, le code traduit »
 * (booking-engine §1) — et elle vaut pour la même raison : une vérification
 * applicative préalable serait une course de plus, jamais une garantie.
 *
 * ## Pourquoi `node:crypto` et non `Math.random`
 *
 * Parce qu'une référence est ce qu'on cite **à la place d'une preuve** : le
 * comptoir résout un code et ouvre le rendez-vous d'une cliente. Un générateur
 * prédictible laisserait deviner les références du salon — c'est-à-dire
 * énumérer ses rendez-vous à partir d'un seul code observé, ce que `id` en
 * UUID v4 rend impossible (tenant-isolation §4). Le coût est nul : six tirages
 * par réservation.
 *
 * `randomInt` plutôt qu'un `randomBytes` réduit modulo : le second biaise
 * l'alphabet dès que 256 n'est pas un multiple de sa taille, et 32 l'est —
 * mais 100 ne l'est pas, et le suffixe aurait été biaisé. Une seule conduite
 * pour les deux vaut mieux qu'une exception à retenir.
 */
export function generateAppointmentReference(): string {
  let group = '';

  for (let index = 0; index < APPOINTMENT_REFERENCE_GROUP_LENGTH; index += 1) {
    // `charAt` et non l'indexation : sous `noUncheckedIndexedAccess`, celle-ci
    // rend `string | undefined` là où un tirage borné par la taille de
    // l'alphabet est un indice valide par construction.
    group += APPOINTMENT_REFERENCE_ALPHABET.charAt(
      randomInt(APPOINTMENT_REFERENCE_ALPHABET.length),
    );
  }

  const ceiling = 10 ** APPOINTMENT_REFERENCE_SUFFIX_LENGTH;
  const suffix = String(randomInt(ceiling)).padStart(APPOINTMENT_REFERENCE_SUFFIX_LENGTH, '0');

  return `${APPOINTMENT_REFERENCE_PREFIX}-${group}-${suffix}`;
}
