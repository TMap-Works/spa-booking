import type { Locale } from '@spa/shared';

import { ACCOUNT_LOCALE_COOKIE, LOCALE_COOKIE, localeCookieOptions } from '@/i18n/cookies';
import { asLocale } from '@/i18n/resolve';

/**
 * La langue **du compte**, telle que l'espace client la pose et la retire —
 * #847, cinquième et quatrième critères d'acceptation.
 *
 * ## Pourquoi ce module existe
 *
 * `i18n/cookies.ts` (#845) déclare `ACCOUNT_LOCALE_COOKIE` et nomme d'avance qui
 * l'écrira : *« les points d'ouverture et de fermeture de session, dans leurs
 * propres tickets de l'épique : la connexion et l'inscription de l'espace
 * client, […] l'écran de coordonnées quand la préférence change »*. C'est ce
 * ticket-ci, et ces trois points sont dans ce dossier. Tant que personne ne
 * l'écrivait, l'étape « compte » de l'ordre de résolution restait inerte.
 *
 * Les gestes sont ici plutôt que recopiés dans `actions.ts` : ils sont quatre —
 * connexion, inscription, enregistrement des coordonnées, changement depuis le
 * sélecteur — et la règle qui les lie tient en une phrase qu'il ne faut écrire
 * qu'une fois.
 *
 * ## La règle, et pourquoi le cookie explicite est **effacé**
 *
 * L'ordre de résolution de #845 met le choix explicite du sélecteur **avant** la
 * préférence du compte (`i18n/resolve.ts`). Poser la seconde ne suffirait donc
 * pas à faire basculer l'écran quand un cookie de sélecteur traîne sur ce
 * navigateur — et le cinquième critère de ce ticket exige précisément que
 * *« après la connexion, l'interface passe dans la langue enregistrée sur le
 * compte »*.
 *
 * Le cookie explicite est donc **effacé**, jamais réécrit avec la valeur du
 * compte. La nuance compte : réécrit, il aurait fait passer pour un choix de
 * sélecteur une préférence qui vient du compte, et le sélecteur n'aurait plus
 * jamais rien eu à réaffirmer. Effacé, l'étape « compte » prend la main
 * d'elle-même, et le premier clic sur le sélecteur repose un vrai choix
 * explicite — que la synchronisation reporte alors sur le compte
 * (`components/account-locale-sync.tsx`).
 *
 * ## Un compte sans préférence ne décide de rien
 *
 * `locale: null` se lit « aucune préférence » et non « anglais » (contrat #844).
 * On efface alors le cookie de compte et on **laisse le choix explicite en
 * place** : une cliente qui avait demandé le français avant de se connecter ne
 * doit pas retomber dans la langue de l'établissement pour s'être identifiée.
 */

/**
 * Le minimum d'un magasin de cookies inscriptible — la même forme que dans
 * `session.ts`, et pour la même raison : le type `ResponseCookies` de Next vit
 * sous un chemin interne que rien ne garantit d'une version à l'autre. Le
 * magasin rendu par `cookies()` et celui d'une `NextResponse` satisfont tous
 * deux cette forme.
 */
interface WritableLocaleCookies {
  set(
    name: string,
    value: string,
    options: {
      readonly httpOnly: true;
      readonly secure: boolean;
      readonly sameSite: 'lax';
      readonly path: string;
      readonly maxAge: number;
    },
  ): unknown;
}

/**
 * Le minimum d'un magasin de cookies **lisible** — la forme que rend `cookies()`
 * dans une action serveur, et celle des `RequestCookies` d'une requête.
 */
interface ReadableLocaleCookies {
  get(name: string): { readonly value: string } | undefined;
}

/**
 * Aligne les cookies de langue sur la préférence du compte qui vient de
 * s'ouvrir — ou de changer.
 *
 * `locale` est ce que l'API rend (`SessionUser.locale`), donc déjà canonique :
 * c'est le contrat qui l'a validé, pas cette fonction.
 */
export function attachAccountLocaleCookies(
  target: WritableLocaleCookies,
  locale: Locale | null,
): void {
  setAccountLocaleMirror(target, locale);

  if (locale !== null) {
    // Voir l'en-tête : effacé et non réécrit, pour que l'étape « compte » de
    // l'ordre de résolution prenne réellement la main.
    clearExplicitLocaleCookie(target);
  }
}

/**
 * Les mêmes cookies, mais quand la cliente vient de régler sa langue
 * **elle-même**, sur l'écran des coordonnées.
 *
 * Une seule chose l'y distingue de l'ouverture de session, et elle porte sur le
 * cas `null` — « Langue du salon », c'est-à-dire *retirer* la préférence.
 * `attachAccountLocaleCookies` laisse alors le choix explicite du sélecteur en
 * place, ce qui est juste à la connexion et faux ici : le cookie survivrait à
 * l'effacement, et `AccountLocaleSync` le reporterait au rendu suivant sur le
 * compte (`components/account-locale-sync.tsx`) — réinstallant en silence la
 * préférence que la cliente vient précisément de retirer.
 *
 * Il n'est retiré que si le compte en portait **une**, lue sur le miroir avant
 * d'écrire quoi que ce soit : le formulaire envoie son champ `locale` à chaque
 * enregistrement, y compris ceux qui ne parlent que du téléphone, et effacer
 * sans condition ferait perdre à une visiteuse sans préférence la langue
 * qu'elle était en train de lire.
 */
export function attachProfileLocaleCookies(
  target: WritableLocaleCookies & ReadableLocaleCookies,
  locale: Locale | null,
): void {
  const held = asLocale(target.get(ACCOUNT_LOCALE_COOKIE)?.value) !== null;

  attachAccountLocaleCookies(target, locale);

  if (locale === null && held) {
    clearExplicitLocaleCookie(target);
  }
}

/**
 * Retire le choix explicite du sélecteur.
 *
 * Il n'appartient pas à la session — voir `clearAccountLocaleCookie` —, et n'est
 * donc effacé que par les deux gestes qui le remplacent réellement : une
 * préférence de compte qui prend la main, et son retrait assumé.
 */
export function clearExplicitLocaleCookie(target: WritableLocaleCookies): void {
  target.set(LOCALE_COOKIE, '', { ...localeCookieOptions(), maxAge: 0 });
}

/**
 * Le **miroir** seul : la préférence du compte, sans toucher au choix explicite
 * du sélecteur.
 *
 * C'est ce qu'il faut quand la préférence vient précisément d'être enregistrée
 * *depuis* le sélecteur (`saveAccountLocaleAction`) : le cookie explicite est
 * déjà posé, c'est lui qui a déclenché l'appel, et l'effacer ferait perdre
 * d'une visite à l'autre — le jour de la déconnexion — un choix que #845
 * promet de garder un an.
 *
 * Le miroir, lui, doit être remis à jour : c'est ce qui fait tomber juste la
 * comparaison suivante, et donc ce qui évite un second appel à l'API à chaque
 * rendu de l'espace.
 */
export function setAccountLocaleMirror(
  target: WritableLocaleCookies,
  locale: Locale | null,
): void {
  if (locale === null) {
    clearAccountLocaleCookie(target);
    return;
  }

  target.set(ACCOUNT_LOCALE_COOKIE, locale, localeCookieOptions());
}

/**
 * Retire la préférence du compte des cookies — à la fermeture de session, et
 * quand la cliente efface sa langue préférée.
 *
 * Le cookie explicite n'est pas touché : il appartient au navigateur, pas à la
 * session. Une cliente qui se déconnecte garde la langue qu'elle lisait.
 */
export function clearAccountLocaleCookie(target: WritableLocaleCookies): void {
  target.set(ACCOUNT_LOCALE_COOKIE, '', { ...localeCookieOptions(), maxAge: 0 });
}
