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

/**
 * Catalogue des prestations — la liste, point d'entrée de #52.
 *
 * Le filtre « actives seulement » est dans l'URL et non dans un état local, pour
 * la raison qui y met la vue du planning : la liste filtrée se partage et survit
 * à un rafraîchissement. Il est donc **construit ici** plutôt que concaténé par
 * la page, sans quoi le chemin que la garde de session mémorise ne serait pas
 * celui que l'écran affiche — et un renouvellement rendrait la main sur le
 * catalogue entier alors qu'on regardait les seules prestations en ligne.
 */
export function adminCatalogPath(
  tenantSlug: string,
  options: { readonly activeOnly?: boolean } = {},
): string {
  const catalog = `${adminPath(tenantSlug)}/catalogue`;

  return options.activeOnly === true ? `${catalog}?actives=1` : catalog;
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

/**
 * L'encaissement au comptoir (#59).
 *
 * La journée **et** le rendez-vous en cours de règlement sont dans l'URL, pour
 * la raison qui les y met dans le planning : l'écran est ouvert des heures
 * durant, et un rafraîchissement ne doit pas ramener l'opérateur à la liste
 * alors qu'il a une cliente devant lui. C'est aussi ce qui rend le lien
 * partageable d'un poste à l'autre du comptoir.
 *
 * `rdv` et non `appointmentId` : les paramètres visibles de ce back-office sont
 * en français, comme `vue` et `date` ci-dessus.
 *
 * Les deux paramètres sont omis quand ils sont absents : l'URL nue
 * `/{slug}/admin/encaissement` est celle qu'on tape, et elle ouvre la journée
 * courante du salon, sans rendez-vous sélectionné.
 */
export function adminCheckoutPath(
  tenantSlug: string,
  options: { readonly date?: CalendarDate; readonly appointmentId?: string } = {},
): string {
  const search = new URLSearchParams();

  if (options.date !== undefined) {
    search.set('date', options.date);
  }
  if (options.appointmentId !== undefined) {
    search.set('rdv', options.appointmentId);
  }

  return `${adminPath(tenantSlug)}/encaissement${search.size === 0 ? '' : `?${search.toString()}`}`;
}

/**
 * Renouvellement silencieux de la session du back-office (#48).
 *
 * Le chemin est **sous** `adminPath` — donc sous le `path` des deux cookies de
 * session, qui n'atteindraient pas une route posée ailleurs. C'est la seule
 * contrainte réelle sur l'emplacement de cette route, et elle est facile à
 * rompre sans s'en apercevoir : le renouvellement échouerait alors toujours,
 * faute de jeton de rafraîchissement.
 *
 * `next` est la page où revenir, et il est **obligatoire** (#458) : l'omettre
 * déposait l'opérateur sur le planning à chaque renouvellement, en perdant la
 * vue et la date du calendrier ou le filtre du catalogue. Le paramètre facultatif
 * ne servait qu'à laisser oublier de le passer, et c'est exactement ce qui est
 * arrivé aux sept écrans du back-office. La même discipline que l'espace client,
 * dont le `refreshPath` l'exige depuis toujours.
 *
 * Il est de toute façon **revérifié par la route**, qui ne redirige que vers le
 * back-office de cet établissement — un paramètre d'URL est fourni par
 * l'appelant, et le suivre sur parole ferait de ce chemin un tremplin vers un
 * site tiers, sous notre domaine. Voir `safeAdminNext`, dont le repli reste le
 * planning : le rendre obligatoire ici ne dispense de rien là-bas.
 */
export function adminSessionRefreshPath(tenantSlug: string, next: string): string {
  return `${adminSessionPath(tenantSlug)}/refresh?next=${encodeURIComponent(next)}`;
}

/** Racine des routes de session du back-office — jamais une destination. */
function adminSessionPath(tenantSlug: string): string {
  return `${adminPath(tenantSlug)}/session`;
}

/**
 * Ramène un `next` d'URL à une destination sûre du back-office (#48).
 *
 * Écrit ici plutôt que dans la route de renouvellement pour deux raisons : un
 * fichier `route.ts` n'expose que ses verbes HTTP et sa configuration, si bien
 * qu'une fonction exportée à côté n'y a pas sa place ; et c'est de l'arithmétique
 * de chemins, qui est exactement le sujet de ce module — donc testable sans
 * requête.
 *
 * Trois refus, et chacun ferme quelque chose :
 *
 * 1. **hors du back-office de cet établissement.** Un `next` non vérifié est une
 *    redirection ouverte : `?next=https://exemple.test` ferait de la route de
 *    renouvellement un tremplin vers un site tiers, sous notre domaine et avec
 *    notre crédibilité. `//exemple.test` est vérifié aussi — protocole-relative,
 *    elle commence par `/` et mène pourtant ailleurs ;
 * 2. **les routes de session elles-mêmes.** Renvoyer le renouvellement sur le
 *    renouvellement boucle sans fin, et chaque tour réussit — rien ne
 *    l'arrêterait ;
 * 3. **la racine `/{slug}/admin`**, qui ne sert aucune page : y renvoyer
 *    transformerait un renouvellement réussi en 404.
 *
 * Le repli est le planning : l'écran qu'un comptoir garde ouvert, et le seul
 * qu'on puisse ouvrir sans rien savoir de l'intention initiale.
 */
export function safeAdminNext(candidate: string | null, tenantSlug: string): string {
  const fallback = adminCalendarPath(tenantSlug);
  const root = adminPath(tenantSlug);
  const session = adminSessionPath(tenantSlug);

  if (candidate === null || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return fallback;
  }

  if (candidate === session || candidate.startsWith(`${session}/`) || candidate.startsWith(`${session}?`)) {
    return fallback;
  }

  // Seuls les **descendants** de la racine passent : `/{slug}/admin` et
  // `/{slug}/admin?quoi-que-ce-soit` désignent le même segment sans page, et
  // les accepter ferait finir un renouvellement réussi sur un 404.
  return candidate.startsWith(`${root}/`) ? candidate : fallback;
}
