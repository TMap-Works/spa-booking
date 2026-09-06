/**
 * Les chemins de l'écran du fichier client (#54).
 *
 * Écrits ici plutôt qu'ajoutés à `../paths.ts`, pour la raison qui a déjà fait
 * naître `../personnel/paths.ts` : ce module-là est partagé par tout le
 * back-office et plusieurs branches du jalon l'allongent en même temps. Deux
 * fichiers qui grandissent chacun de leur côté fusionnent ; un seul que deux
 * branches allongent au même endroit, non. La discipline ne change pas —
 * **aucun composant ne concatène d'URL** —, et la racine vient toujours de
 * `adminPath`.
 *
 * ## Trois paramètres, tous dans l'URL
 *
 * Le terme cherché, la page et la fiche ouverte sont dans l'URL et non dans un
 * état local, pour la raison qui y met la vue du planning et la journée de
 * l'encaissement : l'écran reste ouvert toute la journée, un rafraîchissement ne
 * doit pas refermer la fiche qu'on a sous les yeux avec la cliente au bout du
 * fil, et le lien se passe d'un poste du comptoir à l'autre.
 *
 * C'est aussi ce qui rend la garde de session honnête : la page lui passe **son
 * chemin courant**, si bien qu'un renouvellement silencieux rend la main sur la
 * fiche ouverte et non sur le fichier entier (#458).
 *
 * Les paramètres visibles de ce back-office sont en français, comme `vue`,
 * `date` et `rdv` — d'où `recherche` et `fiche`.
 *
 * ## Aucun identifiant d'établissement
 *
 * Ni ici ni ailleurs : le slug est le segment de route du back-office, et
 * l'établissement dont les fiches sont lues vient du **jeton**, pas du chemin
 * (tenant-isolation §2).
 */

import { adminPath } from '../paths';

/** Le terme cherché — nom, téléphone ou e-mail, d'un seul champ. */
export const CLIENTS_SEARCH_PARAM = 'recherche';

/** La fiche ouverte dans le volet de droite. */
export const CLIENTS_RECORD_PARAM = 'fiche';

/** La page du fichier, quand il dépasse une page. */
export const CLIENTS_PAGE_PARAM = 'page';

/** Ce qui distingue une vue du fichier client d'une autre. */
export interface AdminClientsView {
  /** Terme de recherche, déjà découpé — jamais la saisie brute. */
  readonly term?: string;
  /** Numéro de page, omis quand il vaut la première. */
  readonly page?: number;
  /** Fiche ouverte à droite, omise quand la liste est seule. */
  readonly customerId?: string;
}

/**
 * Le fichier client, éventuellement cherché, paginé et fiche ouverte.
 *
 * Chaque paramètre est **omis quand il vaut son défaut** : l'URL nue
 * `/{slug}/admin/clients` est celle qu'on tape, et elle ouvre le fichier entier
 * sans fiche sélectionnée. Une URL qui porterait `?page=1` à chaque navigation
 * ferait de deux liens identiques deux entrées d'historique distinctes.
 */
export function adminClientsPath(tenantSlug: string, view: AdminClientsView = {}): string {
  const search = new URLSearchParams();

  if (view.term !== undefined && view.term !== '') {
    search.set(CLIENTS_SEARCH_PARAM, view.term);
  }
  if (view.customerId !== undefined) {
    search.set(CLIENTS_RECORD_PARAM, view.customerId);
  }
  if (view.page !== undefined && view.page > 1) {
    search.set(CLIENTS_PAGE_PARAM, String(view.page));
  }

  return `${adminPath(tenantSlug)}/clients${search.size === 0 ? '' : `?${search.toString()}`}`;
}
