import { SLUG_MAX_LENGTH } from '@spa/shared';

import { BusinessRuleError } from '../../common/errors';

/**
 * Dérivation d'un slug d'URL depuis un nom de prestation ou de catégorie.
 *
 * Logique **pure**, sans dépendance ni état : c'est ce qui la rend exerçable
 * sans base ni HTTP, et ce qui justifie qu'elle vive à côté du service plutôt
 * que dedans.
 *
 * ## Pourquoi le serveur dérive plutôt que d'exiger
 *
 * Un formulaire de back-office qui réclamerait le slug à la main le ferait
 * saisir de travers — accents, espaces, majuscules — et l'erreur ne se verrait
 * qu'à la publication de la page de réservation. Le laisser **fournissable**
 * reste utile pour un cas précis : préserver l'URL publique d'une prestation
 * qu'on renomme.
 *
 * ## Ce que le slug n'est pas
 *
 * Ce n'est pas un identifiant : c'est `id` (UUID) qui désigne une ligne dans
 * l'API. Le slug est une commodité d'URL publique, unique par tenant, et il peut
 * changer. Rien ici ne doit donc chercher à le rendre globalement unique — deux
 * salons ont chacun droit à leur `massage-60-min` (tenant-isolation §1).
 */

/**
 * Longueur maximale — celle du slug de tenant (`VARCHAR(63)`, un label DNS) et
 * non celle de la colonne (`VARCHAR(80)`).
 *
 * Le sens du décalage compte : une borne **plus étroite** que la colonne refuse
 * proprement, une borne plus large produit un 500 sur un `VARCHAR` trop court.
 *
 * **Importée du contrat partagé** depuis #510, et réexportée d'ici pour les
 * appelants du module qui la lisaient déjà à cette adresse. Le littéral valait
 * 63 des deux côtés : la substitution n'a donc changé aucune borne, elle a
 * seulement supprimé la seconde écriture qui aurait pu, elle, diverger — et la
 * dérivation ci-dessous tronque désormais exactement là où `slugSchema` de
 * `@spa/shared` refuse.
 */
export { SLUG_MAX_LENGTH };

/**
 * Forme acceptée : minuscules, chiffres, tirets simples, ni en tête ni en fin.
 *
 * Recopié de `slugSchema` faute que `@spa/shared` publie le motif seul — il le
 * porte en ligne dans le `.regex()` du schéma. Il ne valide plus aucun corps de
 * requête : les DTO du module montent le schéma partagé (ADR 0008), et ce motif
 * n'alimente plus que le `pattern` de `/api/docs` et la garde de `slugify`.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Dérive un slug depuis un libellé humain.
 *
 * La décomposition Unicode (`NFD`) sépare « é » en « e » + accent, que la classe
 * `\p{Diacritic}` retire ensuite : « Soin du Visage Éclat » devient
 * `soin-du-visage-eclat`. Faire l'inverse — une table de correspondance
 * caractère à caractère — obligerait à la compléter à chaque langue, et le
 * catalogue d'un salon n'est pas écrit qu'en français.
 *
 * Rend `null` quand il ne reste rien à sluguer : un nom fait de ponctuation ou
 * d'idéogrammes ne donne aucun label DNS. Un slug vide passerait la contrainte
 * d'unicité une fois puis échouerait pour toutes les suivantes, et produirait
 * une URL publique inatteignable — mieux vaut le dire à la saisie. C'est
 * l'appelant qui décide quoi en faire ; ici, on ne devine pas.
 */
export function slugify(label: string): string | null {
  const slug = label
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    // Tout ce qui n'est ni lettre latine ni chiffre devient une frontière de mot.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // La troncature peut retomber sur un tiret : `-salon` et `salon-` ne sont
    // pas des labels DNS valides, et la page publique deviendrait injoignable.
    .replace(/-+$/g, '');

  return slug === '' ? null : slug;
}

/**
 * Le slug à écrire, ou un 422 qui nomme le champ à corriger.
 *
 * Les deux services du module passent par ici — celui des prestations comme
 * celui des catégories — pour que la forme d'un slug soit décidée en un seul
 * endroit. Un slug **fourni** y repasse au lieu d'être pris tel quel : le DTO en
 * a déjà validé la forme, mais laisser la validation et la normalisation vivre
 * chacune de son côté, c'est accepter qu'elles divergent un jour.
 *
 * `field` désigne le champ du corps à corriger : quand le slug est dérivé du
 * nom, c'est le nom que l'appelant doit changer, pas un slug qu'il n'a pas
 * envoyé.
 */
export function requireSlug(source: string, field: 'name' | 'slug'): string {
  const slug = slugify(source);
  if (slug === null) {
    throw new BusinessRuleError('Impossible de dériver un slug d’URL : fournir un slug explicite.', {
      field,
    });
  }
  return slug;
}
