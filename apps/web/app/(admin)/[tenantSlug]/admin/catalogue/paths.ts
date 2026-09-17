/**
 * Les chemins propres au catalogue que `../paths.ts` ne portait pas (#769).
 *
 * Écrits ici plutôt qu'ajoutés à `../paths.ts`, pour la raison qui a déjà fait
 * naître `../personnel/paths.ts` puis `../clients/paths.ts` : ce module-là est
 * partagé par tout le back-office et plusieurs branches du jalon l'allongent en
 * même temps. Deux fichiers qui grandissent chacun de leur côté fusionnent ; un
 * seul que deux branches allongent au même endroit, non.
 *
 * La discipline ne change pas — **aucun composant ne concatène d'URL** —, et la
 * racine vient toujours d'un seul endroit : `adminServiceCategoriesPath`, que ce
 * module prolonge au lieu de le recopier.
 */

import { adminServiceCategoriesPath } from '../paths';

/**
 * L'écran d'une rubrique — renommage, description, adresse publique.
 *
 * C'est l'adresse que le nom de la rubrique ouvre depuis la liste, comme le nom
 * d'une prestation ouvre sa fiche. Les deux listes du catalogue ouvrent le même
 * type d'objet du même geste : l'édition en place, dépliée dans la cellule du
 * tableau, était l'écart de cohérence relevé par l'audit `d20260916-1`.
 *
 * L'identifiant est encodé bien qu'il vienne d'une réponse d'API et non d'une
 * saisie : un chemin se construit toujours de la même façon, sans exception
 * qu'il faudrait ensuite se rappeler. C'est la règle d'`adminServicePath` et
 * d'`adminStaffMemberPath`.
 */
export function adminServiceCategoryPath(tenantSlug: string, categoryId: string): string {
  return `${adminServiceCategoriesPath(tenantSlug)}/${encodeURIComponent(categoryId)}`;
}
