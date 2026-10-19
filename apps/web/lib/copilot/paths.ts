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
 * Les paramètres d'adresse que le chat peut lire : ceux des **filtres** des
 * écrans (inventaire §1 à §3). Une liste fermée, et non tout ce que l'adresse
 * porte : `?recherche=` peut contenir un nom ou un téléphone tapé à la main, et
 * un jeton d'invitation n'a rien à faire dans le contexte du modèle
 * (minimisation, spécification §8).
 */
export const PAGE_FILTER_KEYS: readonly string[] = [
  'etape',
  'prestation',
  'praticien',
  'creneau',
  'jour',
  'plage',
  'mois',
  'vue',
  'date',
  'annules',
  'rdv',
  'periode',
  'du',
  'au',
  'filtre',
  'fiche',
  'page',
];

/** « /salon/admin/calendrier · vue=semaine, date=2026-10-23 » : la page et ses filtres. */
export function describePage(pathname: string, search: URLSearchParams): string {
  const filters = PAGE_FILTER_KEYS.flatMap((key) => {
    const value = search.get(key);
    return value === null ? [] : [`${key}=${value.slice(0, 64)}`];
  });
  return filters.length === 0 ? pathname : `${pathname} · ${filters.join(', ')}`;
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
