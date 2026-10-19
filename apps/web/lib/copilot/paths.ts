import type { CopilotSpace } from './session';

/**
 * Où le copilot est servi dans chaque espace — sous le chemin de ses cookies de
 * session (inventaire §6.1). Un module à part, léger : les gabarits qui montent
 * le chat n'ont pas à charger le runtime pour connaître son adresse.
 */
const SPACE_PATH: Record<CopilotSpace, string> = {
  public: 'copilot',
  compte: 'compte/copilot',
  admin: 'admin/copilot',
};

export function copilotBasePath(space: CopilotSpace, tenantSlug: string): string {
  return `/${tenantSlug}/${SPACE_PATH[space]}`;
}

/**
 * Une adresse du salon courant, et rien d'autre : pas d'autre origine, pas
 * d'autre salon, pas de `//` ni de `\\` qui feraient sortir du site. C'est la
 * garde de l'exécutant `naviguer` : une adresse que le serveur n'aurait pas
 * dû produire n'est jamais suivie.
 */
export function isSalonPath(chemin: string, tenantSlug: string): boolean {
  if (!chemin.startsWith('/') || chemin.startsWith('//') || chemin.includes('\\')) return false;
  const url = new URL(chemin, 'https://salon.invalid');
  return (
    url.origin === 'https://salon.invalid' &&
    (url.pathname === `/${tenantSlug}` || url.pathname.startsWith(`/${tenantSlug}/`))
  );
}
