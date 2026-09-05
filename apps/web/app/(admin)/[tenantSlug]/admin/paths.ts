/**
 * Les chemins du back-office, écrits une fois.
 *
 * Aucun composant ne concatène d'URL : le jour où le préfixe change, il change
 * ici. C'est la même discipline que `paths.ts` de l'espace client, et elle vaut
 * surtout pour le `path` des cookies de session — un cookie posé sur un chemin
 * et effacé sur un autre survit, et la déconnexion ne déconnecte plus.
 */

import type { CalendarDate } from '@spa/shared';

import { DEFAULT_CALENDAR_VIEW, type CalendarView } from '@/lib/admin/calendar-range';

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

/**
 * Le planning — vues jour et semaine (#49).
 *
 * La vue et la date sont dans l'URL et non dans un état local : un planning se
 * partage (« regarde jeudi »), se met en favori, et surtout survit à un
 * rafraîchissement. Un état local ramènerait l'opérateur à aujourd'hui à chaque
 * rechargement, sur l'écran qui reste ouvert toute la journée.
 *
 * Les deux paramètres sont omis quand ils valent le défaut : l'URL nue
 * `/{slug}/admin/calendrier` est celle qu'on tape, et elle ouvre la journée
 * courante.
 */
export function adminCalendarPath(
  tenantSlug: string,
  options: { readonly view?: CalendarView; readonly date?: CalendarDate } = {},
): string {
  const search = new URLSearchParams();

  if (options.view !== undefined && options.view !== DEFAULT_CALENDAR_VIEW) {
    search.set('vue', options.view);
  }
  if (options.date !== undefined) {
    search.set('date', options.date);
  }

  return `${adminPath(tenantSlug)}/calendrier${search.size === 0 ? '' : `?${search.toString()}`}`;
}
