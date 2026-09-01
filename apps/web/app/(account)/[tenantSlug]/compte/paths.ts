/**
 * Les chemins de l'espace client — **sans aucune dépendance serveur**.
 *
 * Ce module est séparé de `session.ts` pour une raison que le build a tranchée :
 * les Client Components ont besoin de construire ces URL — un lien « reporter »,
 * une redirection après connexion — et `session.ts` importe `next/headers`, qui
 * n'existe que côté serveur. Les garder ensemble faisait entrer `cookies()` dans
 * le graphe de modules du navigateur, et Next refusait de compiler.
 *
 * Cette séparation est une garantie et pas seulement une commodité : il n'y a
 * rien à lire ici qu'un slug d'établissement, donc rien qui puisse suivre un
 * jeton jusqu'au bundle.
 */

/** Racine de l'espace client d'un établissement — et portée de ses cookies. */
export function accountPath(tenantSlug: string, suffix = ''): string {
  return `/${encodeURIComponent(tenantSlug)}/compte${suffix}`;
}

/** L'écran de connexion, éventuellement avec le motif qui y renvoie. */
export function loginPath(tenantSlug: string, motif?: 'session-expiree'): string {
  return accountPath(tenantSlug, motif === undefined ? '/connexion' : `/connexion?motif=${motif}`);
}

/**
 * La route qui renouvelle la session puis renvoie d'où l'on vient.
 *
 * `next` est un chemin **relatif**, et il est revalidé à l'arrivée : voir
 * `session/refresh/route.ts`.
 */
export function refreshPath(tenantSlug: string, next: string): string {
  return accountPath(tenantSlug, `/session/refresh?next=${encodeURIComponent(next)}`);
}

/** La route qui ferme une session que l'API a révoquée. */
export function sessionEndPath(tenantSlug: string): string {
  return accountPath(tenantSlug, '/session/fin?motif=session-expiree');
}
