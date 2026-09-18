/**
 * Le paramètre de retour des deux écrans d'identité du salon (#1087).
 *
 * ## Ce qu'il sert
 *
 * Le tunnel de réservation offre « Déjà cliente ? Se connecter » en tête de
 * l'étape « Coordonnées » (#1050). Jusqu'ici ce lien déposait la cliente dans
 * son espace client : le brouillon n'était pas perdu — il vit dans
 * `sessionStorage`, qui suit l'onglet —, mais rien ne le lui disait, et il
 * fallait un clic de plus pour revenir finir ce qu'elle avait commencé.
 * `?retour=` porte la destination, et les deux formulaires y reviennent au lieu
 * de retomber sur `accountPath`.
 *
 * ## Pourquoi il est revalidé ici, et pas seulement composé là-bas
 *
 * Parce qu'un paramètre d'URL est fourni par l'appelant, et qu'un écran de
 * connexion est **le pire endroit du produit** où poser une redirection
 * ouverte : c'est la page où l'on tape son mot de passe, celle qu'un courriel
 * d'hameçonnage a tout intérêt à faire ouvrir sous notre domaine avant de
 * renvoyer ailleurs. La destination est donc rejugée à l'arrivée, exactement
 * comme `session/refresh` le fait de son `next` (`session/refresh/route.ts`) et
 * le back-office de `safeAdminNext` (`(admin)/…/admin/paths.ts`).
 *
 * ## Pourquoi ce module vit sous `connexion/`
 *
 * C'est par cet écran que le paramètre **entre** : le tunnel n'écrit le lien
 * qu'ici, et l'inscription ne le reçoit que du lien « Créer mon compte » que la
 * connexion lui passe. La revalidation vit donc là où la valeur arrive, et reste
 * de l'arithmétique de chemins pure — donc éprouvable sans requête ni rendu.
 */

import { sitePath } from '@/lib/site-path';

import { accountPath, salonPath } from '../paths';

/**
 * La clé du paramètre, en français comme le reste des query strings du produit
 * — `?motif=`, `?etape=`, `?vue=`, `?recherche=` (voir `BOOKING_QUERY_KEYS`).
 *
 * Les routes de session, elles, gardent leur `next` : ce sont des routes de
 * redirection interne, jamais une adresse qu'une cliente lit.
 */
export const RETURN_QUERY_KEY = 'retour';

/**
 * Ramène un retour reçu à une destination sûre, ou rend `null` quand il n'y en a
 * pas d'exploitable — auquel cas l'appelant retombe sur `accountPath`.
 *
 * Quatre refus, et chacun ferme quelque chose :
 *
 * 1. **ce qui n'est pas un chemin de ce site.** `https://exemple.test`,
 *    `//exemple.test` — protocole-relative, elle commence par `/` et mène
 *    pourtant ailleurs —, `/\exemple.test`, ou un chemin qui ne s'y ramène
 *    qu'une fois les `..` résolus. `sitePath` les juge sur la forme
 *    **normalisée**, et c'est elle qu'on rend (#856) ;
 * 2. **ce qui sort du salon courant.** Un autre slug est un autre
 *    établissement : y déposer une cliente qui vient de se connecter ici serait
 *    une fuite de parcours, et la session posée ne vaut de toute façon pas
 *    là-bas — les jetons sont portés sur `/{slug}/compte` et la présence sur
 *    `/{slug}` (`session.ts`, `lib/account-presence.ts`) ;
 * 3. **les écrans d'identité eux-mêmes.** Revenir sur la connexion après une
 *    connexion réussie boucle, et chaque tour réussit — rien ne l'arrêterait ;
 * 4. **les routes de session.** `session/refresh` et `session/fin` ne sont pas
 *    des pages : la première repart aussitôt, la seconde ferme la session qu'on
 *    vient d'ouvrir.
 *
 * Les deux derniers se jugent sur le chemin tel que le **routeur** l'appariera —
 * segments décodés, barres redoublées écrasées : voir `routeKey`, sans quoi
 * `…/compte/%63onnexion` rouvrirait la boucle par un lien fabriqué.
 *
 * Le repli n'est pas rendu ici mais laissé à l'appelant : un `null` distingue
 * « aucun retour » de « retour vers l'espace client », et c'est cette distinction
 * qui évite aux liens croisés des deux formulaires de traîner un
 * `?retour=/{slug}/compte` que personne n'a demandé.
 */
export function safeReturnPath(candidate: string | null, tenantSlug: string): string | null {
  if (candidate === null) {
    return null;
  }

  const path = sitePath(candidate);

  if (path === null) {
    return null;
  }

  const salon = salonPath(tenantSlug);

  // La racine du salon est une destination légitime — la vitrine. Ses
  // descendants aussi. Le test porte sur `${salon}/` et non sur `salon` seul :
  // `/salon-des-lilas/...` commence par `/salon` sans appartenir au salon
  // `salon`.
  const insideSalon =
    path === salon || path.startsWith(`${salon}/`) || path.startsWith(`${salon}?`);

  if (!insideSalon) {
    return null;
  }

  const account = accountPath(tenantSlug);
  const forbidden = [`${account}/connexion`, `${account}/inscription`, `${account}/session`];

  return forbidden.some((prefix) => isUnder(path, prefix)) ? null : path;
}

/**
 * Le chemin sous la forme que le **routeur** en retiendra.
 *
 * `sitePath` normalise l'origine et les `..`, mais il ne touche ni à l'encodage
 * des segments ni aux barres redoublées : `/{slug}/compte/%63onnexion` et
 * `/{slug}/compte//connexion` s'écrivent autrement que `/{slug}/compte/connexion`
 * et mènent pourtant au même écran — Next décode les segments avant d'apparier
 * une route, et une barre redoublée ne crée aucun segment. Comparer les chaînes
 * telles quelles laisserait donc passer, par un lien fabriqué, la boucle que le
 * troisième refus ferme : une connexion réussie qui redépose sur la connexion.
 *
 * Seule la partie chemin est décodée — `?` et `#` encodés dans un segment ne
 * doivent pas devenir des séparateurs —, et la query string suit telle quelle :
 * elle ne sert qu'à borner le préfixe.
 */
function routeKey(value: string): string {
  const cut = value.search(/[?#]/);
  const pathname = cut === -1 ? value : value.slice(0, cut);
  const rest = cut === -1 ? '' : value.slice(cut);

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Un `%` esseulé n'est pas décodable : on juge alors la forme brute, qui
    // n'appariera aucune route de toute façon.
    decoded = pathname;
  }

  return `${decoded.replace(/\/{2,}/g, '/')}${rest}`;
}

/** `path` désigne-t-il `prefix` lui-même, ou l'un de ses descendants ? */
function isUnder(path: string, prefix: string): boolean {
  const route = routeKey(path);
  const base = routeKey(prefix);

  return route === base || route.startsWith(`${base}/`) || route.startsWith(`${base}?`);
}

/**
 * Le même chemin, portant le retour quand il y en a un.
 *
 * C'est ce qui fait qu'une cliente venue du tunnel et passée par « Créer mon
 * compte » revient au tunnel et non dans son espace client : le paramètre
 * traverse le lien croisé des deux formulaires au lieu de s'y perdre.
 *
 * `path` peut déjà porter une query string — `connexion?motif=…` : on ajoute
 * plutôt que de remplacer.
 */
export function withReturnPath(path: string, returnTo: string | null): string {
  if (returnTo === null) {
    return path;
  }

  return `${path}${path.includes('?') ? '&' : '?'}${RETURN_QUERY_KEY}=${encodeURIComponent(returnTo)}`;
}
