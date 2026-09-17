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

import type { SessionNotice } from '@/lib/session-refresh';

/** Racine de l'espace client d'un établissement — et portée de ses cookies. */
export function accountPath(tenantSlug: string, suffix = ''): string {
  return `/${encodeURIComponent(tenantSlug)}/compte${suffix}`;
}

/**
 * La vitrine publique de l'établissement — son catalogue et ses tarifs.
 *
 * ## Pourquoi l'espace client construit ces deux chemins lui-même
 *
 * Le groupe `(booking)` en expose déjà des jumeaux (`salon-data.ts`), mais ce
 * module-là porte aussi les **chargements** du salon : l'importer ferait entrer
 * `cache()` et les appels API du tunnel dans le graphe de l'espace client pour
 * deux concaténations de chaîne. Ces chemins sont par ailleurs des URL publiques
 * stables, décrites par la structure de `app/` — la duplication est celle du
 * routeur, pas d'une règle métier.
 */
export function salonPath(tenantSlug: string): string {
  return `/${encodeURIComponent(tenantSlug)}`;
}

/** Le tunnel de réservation de l'établissement — la sortie de l'espace client. */
export function bookingPath(tenantSlug: string): string {
  return `${salonPath(tenantSlug)}/reservation`;
}

/**
 * L'écran de connexion, éventuellement avec le motif qui y renvoie.
 *
 * Le motif vient de `lib/session-refresh.ts`, en `import type` : les Client
 * Components construisent ces chemins, et une importation de valeur ferait
 * entrer le client d'API dans leur graphe de modules — exactement ce que
 * l'en-tête de ce fichier interdit. Un type, lui, ne survit pas à la
 * compilation.
 */
export function loginPath(tenantSlug: string, motif?: SessionNotice): string {
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
