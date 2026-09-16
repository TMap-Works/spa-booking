/**
 * La référence courte d'un rendez-vous — `RDV-XXXX-NN` (#736).
 *
 * `docs/design/appointments/wireframes.md` — Étape 6 — écrit « Réf. RDV-8F3K-27 »
 * sur l'écran de confirmation. L'écran y rendait l'identifiant tel quel :
 * `8425dc59-e63d-4ff5-b679-5714157cb046`, trente-six caractères en gris atténué,
 * repliés sur deux lignes à 360 px. Une preuve de réservation se lit, se retient
 * le temps d'un appel et se dicte au comptoir — un UUID ne fait aucun des trois.
 *
 * ## Elle se dérive, elle ne se stocke pas
 *
 * La référence est calculée **côté front, à partir de l'identifiant que l'API
 * rend déjà**. C'est une fonction pure de cet identifiant : le même rendez-vous
 * donne toujours la même référence, sur n'importe quel appareil, sans état à
 * conserver ni colonne à ajouter.
 *
 * L'autre voie — une colonne `appointments.reference` posée à la réservation —
 * donnerait une référence que le salon pourrait chercher en base. Elle demande
 * une migration, un contrat `@spa/shared` et un endpoint : la conception d'un
 * ticket à part entière, pas d'un correctif d'écran. Ce module livre le volet
 * lisible ; ce que la référence ne fait **pas encore**, c'est se retrouver dans
 * le back-office et dans l'e-mail de confirmation, qui ne la connaissent ni l'un
 * ni l'autre. Tant que cette reprise n'a pas eu lieu, la référence identifie le
 * rendez-vous **pour la cliente** — elle ne le résout pas côté salon.
 *
 * ## Pourquoi cet alphabet
 *
 * Trente-deux symboles, ceux de Crockford : les chiffres et les lettres, moins
 * `I`, `L`, `O` et `U`. Les trois premières se confondent avec `1` et `0` dans
 * la plupart des fontes, et une référence est faite pour être recopiée à la main
 * ou dictée au téléphone. `U` part avec elles pour la raison qu'a Crockford :
 * l'écarter met un obscène de moins dans les références qu'on tirera.
 *
 * ## Ce que valent les quatre symboles et les deux chiffres
 *
 * `32⁴ × 100`, soit un peu plus de cent millions de références distinctes. Les
 * bits lus sont les bits **de poids faible** de l'identifiant, qui sont
 * aléatoires dans un UUID v4 — contrairement aux bits de version et de variante,
 * posés au milieu. Deux rendez-vous d'un même salon peuvent donc porter la même
 * référence, et c'est une limite à connaître avant d'en faire une clé de
 * recherche : ce n'en est pas une, et l'écran ne s'en sert pas pour retrouver
 * quoi que ce soit.
 */

import { uuidSchema } from '@spa/shared';

/** Les trente-deux symboles de Crockford — sans `I`, `L`, `O` ni `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Le groupe alphanumérique du milieu : `RDV-8F3K-27`. */
const GROUP_LENGTH = 4;

/** Le suffixe décimal de fin : `RDV-8F3K-27`. */
const SUFFIX_LENGTH = 2;

const SUFFIX_MODULO = 10n ** BigInt(SUFFIX_LENGTH);
const GROUP_MODULO = BigInt(ALPHABET.length) ** BigInt(GROUP_LENGTH);

/** `value` écrit en base 32 sur `GROUP_LENGTH` symboles, complété à gauche. */
function encodeGroup(value: bigint): string {
  const base = BigInt(ALPHABET.length);
  let rest = value;
  let group = '';

  for (let index = 0; index < GROUP_LENGTH; index += 1) {
    // `charAt` et non l'indexation : sous `noUncheckedIndexedAccess`, celle-ci
    // rend `string | undefined` là où le reste d'une division par la taille de
    // l'alphabet est un indice valide par construction.
    group = ALPHABET.charAt(Number(rest % base)) + group;
    rest /= base;
  }

  return group;
}

/**
 * La référence courte de ce rendez-vous, ou `null` si l'identifiant n'en est pas
 * un.
 *
 * Le `null` n'est pas défensif pour la forme : l'appelant en a besoin pour
 * décider quoi montrer. `BookedAppointment.id` est validé par `uuidSchema` — à
 * la réception de l'API comme à la relecture du brouillon (`draft.ts`) — et le
 * cas ne se produit donc pas en service. Mais rendre une référence calculée sur
 * une chaîne qui n'est pas un identifiant ferait passer un bricolage de
 * `sessionStorage` pour une preuve de réservation.
 *
 * C'est `uuidSchema` qui tranche, et non une expression régulière écrite ici :
 * ce que le produit appelle un identifiant se définit à un seul endroit.
 */
export function appointmentReference(appointmentId: string): string | null {
  if (!uuidSchema.safeParse(appointmentId).success) {
    return null;
  }

  // Les tirets d'un UUID n'ont aucune valeur : ils découpent les cinq champs
  // d'un format, ils ne portent pas d'information.
  const value = BigInt(`0x${appointmentId.replace(/-/g, '')}`);
  const reduced = value % (GROUP_MODULO * SUFFIX_MODULO);

  const group = encodeGroup(reduced / SUFFIX_MODULO);
  const suffix = String(reduced % SUFFIX_MODULO).padStart(SUFFIX_LENGTH, '0');

  return `RDV-${group}-${suffix}`;
}
