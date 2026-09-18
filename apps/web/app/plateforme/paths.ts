/**
 * Les chemins de la console de l'éditeur — ADR 0012.
 *
 * `plateforme` est un slug réservé (`RESERVED_TENANT_SLUGS`) : aucun salon ne
 * peut s'y ouvrir, et le segment statique l'emporte sur `[tenantSlug]`.
 */

export const PLATFORM_CONSOLE_PATH = '/plateforme';

export const PLATFORM_NEW_TENANT_PATH = `${PLATFORM_CONSOLE_PATH}/salons/nouveau`;

/** Pourquoi on revient sur l'écran de connexion — la session ne se renouvelle pas. */
export type PlatformLoginMotif = 'session-expiree';

export function platformLoginPath(motif?: PlatformLoginMotif): string {
  const login = `${PLATFORM_CONSOLE_PATH}/connexion`;

  return motif === undefined ? login : `${login}?motif=${motif}`;
}

export function platformTenantsPath(page = 1): string {
  return page <= 1 ? PLATFORM_CONSOLE_PATH : `${PLATFORM_CONSOLE_PATH}?page=${String(page)}`;
}
