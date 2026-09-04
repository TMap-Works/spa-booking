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
