/**
 * Les chemins de la console de l'éditeur — écrits une fois.
 *
 * `/plateforme` est le **tableau de bord** ; la liste des salons vit sous
 * `/plateforme/salons`, la fiche d'un salon sous `/plateforme/salons/{id}`.
 * Le cookie de session est posé sur `/plateforme` : il couvre tout l'espace.
 */

export const PLATFORM_CONSOLE_PATH = '/plateforme';

/** La liste des salons. */
export const PLATFORM_TENANTS_PATH = `${PLATFORM_CONSOLE_PATH}/salons`;

/** Ouvrir un salon. */
export const PLATFORM_NEW_TENANT_PATH = `${PLATFORM_TENANTS_PATH}/nouveau`;

/** L'export CSV de la liste, avec les mêmes filtres. */
export const PLATFORM_TENANTS_EXPORT_PATH = `${PLATFORM_TENANTS_PATH}/export`;

/** Le motif qui renvoie à la connexion. */
export type PlatformLoginMotif = 'session-expiree';

export function platformLoginPath(motif?: PlatformLoginMotif): string {
  const login = `${PLATFORM_CONSOLE_PATH}/connexion`;

  return motif === undefined ? login : `${login}?motif=${motif}`;
}

/** La liste des salons, avec ses filtres déjà mis en paramètres d'adresse. */
export function platformTenantsPath(search?: URLSearchParams): string {
  return search === undefined || search.size === 0
    ? PLATFORM_TENANTS_PATH
    : `${PLATFORM_TENANTS_PATH}?${search.toString()}`;
}

/** La fiche d'un salon. */
export function platformTenantPath(tenantId: string): string {
  return `${PLATFORM_TENANTS_PATH}/${encodeURIComponent(tenantId)}`;
}
