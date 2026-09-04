/**
 * Les chemins du back-office, écrits une fois.
 *
 * Aucun composant ne concatène d'URL : le jour où le préfixe change, il change
 * ici. C'est la même discipline que `paths.ts` de l'espace client, et elle vaut
 * surtout pour le `path` des cookies de session — un cookie posé sur un chemin
 * et effacé sur un autre survit, et la déconnexion ne déconnecte plus.
 */

/** Racine du back-office d'un établissement. */
export function adminPath(tenantSlug: string): string {
  return `/${encodeURIComponent(tenantSlug)}/admin`;
}

/** Écran de connexion du back-office. */
export function adminLoginPath(tenantSlug: string): string {
  return `${adminPath(tenantSlug)}/connexion`;
}

/** Réglages de l'établissement — adresse, horaires, coordonnées (#343). */
export function adminSettingsPath(tenantSlug: string): string {
  return `${adminPath(tenantSlug)}/reglages`;
}

/** Catalogue des prestations — la liste, point d'entrée de #52. */
export function adminCatalogPath(tenantSlug: string): string {
  return `${adminPath(tenantSlug)}/catalogue`;
}

/** Création d'une prestation. */
export function adminNewServicePath(tenantSlug: string): string {
  return `${adminCatalogPath(tenantSlug)}/nouveau`;
}

/**
 * Fiche d'une prestation — modification et affectation des praticiens.
 *
 * L'identifiant est encodé : il vient d'une réponse d'API et non d'une saisie,
 * mais un chemin se construit toujours de la même façon, sans exception qu'il
 * faudrait ensuite se rappeler.
 */
export function adminServicePath(tenantSlug: string, serviceId: string): string {
  return `${adminCatalogPath(tenantSlug)}/${encodeURIComponent(serviceId)}`;
}

/** Rubriques du catalogue. */
export function adminServiceCategoriesPath(tenantSlug: string): string {
  return `${adminCatalogPath(tenantSlug)}/rubriques`;
}

/** Aperçu du catalogue tel que la cliente le voit. */
export function adminCatalogPreviewPath(tenantSlug: string): string {
  return `${adminCatalogPath(tenantSlug)}/apercu`;
}
