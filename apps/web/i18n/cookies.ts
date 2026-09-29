import type { Locale } from '@spa/shared';

/**
 * Les cookies qui portent la langue — #845.
 *
 * Ils sont dans un module à part de `server.ts` parce que le **middleware** les
 * lit aussi, et qu'il s'exécute sur le runtime Edge : tout ce qu'il importe doit
 * se passer de `node:fs` et de `next/headers`. Ici, il n'y a que des noms et des
 * attributs.
 */

/**
 * Le choix explicite du sélecteur de langue.
 *
 * `httpOnly` : rien côté navigateur n'a besoin de le lire — la langue arrive
 * déjà rendue dans le HTML, et `<html lang>` la dit à qui l'interroge. Un cookie
 * lisible par script serait une surface de plus pour une extension ou une XSS,
 * sans rien apporter.
 *
 * `path: '/'` et non `/{slug}` : la langue est une préférence de **personne**,
 * pas d'établissement. Qui choisit l'anglais chez un salon le garde sur la page
 * d'accueil de la plateforme et chez le salon suivant — c'est le sens même du
 * critère « le choix est conservé d'une visite à l'autre ».
 */
export const LOCALE_COOKIE = 'spa_locale';

/**
 * La préférence du **compte** connecté (`users.locale`, #844), recopiée à
 * l'ouverture de session.
 *
 * ## Pourquoi un cookie plutôt qu'un appel à `GET /auth/me`
 *
 * La langue est résolue pour **chaque requête**, y compris celles du parcours
 * public, qui ne porte aucun jeton (`compte/session.ts` borne les cookies de
 * session à `/{slug}/compte`). Interroger l'API à chaque page pour lire une
 * préférence aurait ajouté un aller-retour au chemin critique de la réservation,
 * là où la valeur ne change qu'à la connexion et au moment où la personne la
 * modifie.
 *
 * Il ne porte **que** la langue : ni identifiant, ni rôle, ni jeton. Il
 * n'autorise rien et ne décide de rien d'autre que d'un affichage — même régime
 * que le cookie de présence (`lib/account-presence.ts`), dont il suit les
 * attributs.
 *
 * ## Qui l'écrit
 *
 * Les points d'ouverture et de fermeture de session, dans leurs propres tickets
 * de l'épique : la connexion et l'inscription de l'espace client, la connexion
 * du back-office, l'écran de coordonnées quand la préférence change. Tant qu'ils
 * ne l'écrivent pas, l'étape « compte » de l'ordre de résolution est inerte et
 * la négociation `Accept-Language` prend la main — ce qui est exactement le
 * comportement attendu d'un compte sans préférence (`locale: null`).
 */
export const ACCOUNT_LOCALE_COOKIE = 'spa_account_locale';

/**
 * Un an : la langue n'est pas une session, c'est une préférence. La reposer à
 * chaque visite ferait retomber en anglais qui a choisi le français il y a un
 * mois.
 */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Les attributs du cookie de langue — les mêmes pour les deux. */
export function localeCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
  } as const;
}

/** L'en-tête par lequel le middleware transmet le salon visité à la résolution. */
export const TENANT_SLUG_HEADER = 'x-spa-tenant-slug';

/**
 * L'en-tête par lequel le middleware dit **de quel côté de l'établissement** la
 * page visitée se trouve — #1326.
 *
 * Il ne porte qu'une valeur, `admin`, et n'est posé que sur `/{slug}/admin/…`.
 * C'est ce qui permet à la résolution de placer `Tenant.defaultLocale` avant
 * l'`Accept-Language` du navigateur sur le back-office, et **là seulement** :
 * l'ordre des deux derniers signaux n'est pas le même selon que la page
 * appartienne à l'établissement ou à son visiteur (voir `resolve.ts`).
 *
 * Même régime que le slug : il vient du chemin et de nulle part ailleurs, et le
 * middleware l'efface de toute requête entrante avant de le reposer lui-même.
 * Un `x-spa-tenant-workspace: admin` envoyé à la main ne peut donc rien changer.
 */
export const TENANT_WORKSPACE_HEADER = 'x-spa-tenant-workspace';

/**
 * La seule valeur de cet en-tête : le back-office de l'établissement.
 *
 * Une valeur nommée plutôt qu'un booléen implicite — l'espace client
 * (`/{slug}/compte`) et la vitrine sont eux aussi des pages d'établissement, et
 * un jour où l'un d'eux voudrait sa propre règle, il se nommera ici plutôt que
 * de retourner le sens d'un en-tête vide.
 */
export const ADMIN_WORKSPACE = 'admin';

/** Ce qu'un cookie de langue porte — une étiquette du contrat, rien d'autre. */
export type LocaleCookieValue = Locale;
