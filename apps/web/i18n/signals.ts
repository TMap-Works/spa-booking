import { cookies, headers } from 'next/headers';

import {
  ACCOUNT_LOCALE_COOKIE,
  ADMIN_WORKSPACE,
  LOCALE_COOKIE,
  TENANT_SLUG_HEADER,
  TENANT_WORKSPACE_HEADER,
} from './cookies';
import type { LocaleSignals } from './resolve';

/**
 * Les signaux de langue portés par la requête — **la feuille** de la résolution,
 * #1286.
 *
 * ## Pourquoi un module de plus entre `cookies.ts` et `server.ts`
 *
 * Deux lecteurs consultent ces signaux, et ils ne peuvent pas s'appeler l'un
 * l'autre :
 *
 * - `i18n/server.ts::requestLocale()` les lit, puis ajoute la seule étape qui
 *   coûte un appel réseau — `Tenant.defaultLocale` (#844) ;
 * - `lib/api-client.ts::refusalLocale()` les lit **seuls**, pour dire dans la
 *   bonne langue ce qu'il n'a pas pu faire (#1234).
 *
 * Le second ne peut pas passer par le premier : `i18n/request.ts` appelle
 * `requestLocale()`, qui appelle `fetchPublicTenant` du client d'API. Un client
 * d'API qui attendrait la résolution de langue attendrait donc la configuration
 * de requête qui l'attend lui-même — un interblocage, sur une branche rare et
 * donc découverte tard. C'est l'arbitrage écrit dans l'en-tête de
 * `refusalLocale`, et il tient toujours.
 *
 * Ce qui ne tenait pas, c'est la **copie** : les trois lectures étaient écrites
 * deux fois, et le jour où un signal s'ajoute avant l'établissement, ou où un
 * cookie change de nom, les deux lecteurs divergent sans qu'aucun test ne le
 * dise — un refus se lit alors dans une langue que la page n'emploie pas.
 *
 * L'argument d'import circulaire n'interdit que d'importer `server.ts`. Une
 * feuille ne le viole pas : ce module n'importe que `cookies.ts` (des noms) et
 * le **type** des signaux de `resolve.ts`. Il n'appelle l'API nulle part, et il
 * ne doit jamais commencer.
 */

/**
 * Les trois signaux que la requête porte d'elle-même, prêts pour
 * `resolveLocale`.
 *
 * `tenant` reste absent — et c'est la propriété de ce module : le quatrième
 * signal de l'ordre demande `GET /public/{slug}`, c'est-à-dire le client d'API,
 * c'est-à-dire la boucle. Il s'ajoute chez l'appelant qui peut se le permettre,
 * `i18n/server.ts` et lui seul.
 */
export interface RequestLocaleSignals extends LocaleSignals {
  /** Le choix du sélecteur de langue (`spa_locale`). */
  readonly explicit: string | null;
  /** La préférence du compte connecté (`spa_account_locale`). */
  readonly account: string | null;
  /** L'en-tête `Accept-Language`, brut. */
  readonly acceptLanguage: string | null;
  /**
   * Toujours absent — `exactOptionalPropertyTypes` en fait une **interdiction**
   * et non un commentaire : ce module ne peut pas porter le quatrième signal
   * sans rappeler l'API, et le compilateur refuse désormais de l'y laisser
   * glisser.
   */
  readonly tenant?: undefined;
}

/**
 * Lit les signaux de la requête en cours. Ne résout rien, ne valide rien : les
 * valeurs partent telles que le navigateur les a écrites, et c'est
 * `resolve.ts` qui dit ce qui compte comme une langue.
 *
 * Lève hors requête — un script, une tâche de fond, une suite de tests :
 * `next/headers` n'a alors aucun contexte à lire. C'est à l'appelant de dire ce
 * qu'il en fait, et les deux le disent différemment : `requestLocale()` s'exécute
 * toujours sous une requête, quand `refusalLocale()` retombe sur
 * `DEFAULT_LOCALE` plutôt que d'ajouter une panne à celle qu'il rapporte.
 */
export async function requestLocaleSignals(): Promise<RequestLocaleSignals> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  return {
    explicit: cookieStore.get(LOCALE_COOKIE)?.value ?? null,
    account: cookieStore.get(ACCOUNT_LOCALE_COOKIE)?.value ?? null,
    acceptLanguage: headerList.get('accept-language'),
  };
}

/**
 * Le salon visité, tel que le middleware l'a posé sur la requête, ou `null`.
 *
 * Ce n'est pas une langue — c'est ce par quoi on va en chercher une, et c'est
 * pourquoi il se lit ici et se résout ailleurs. Une adresse hors salon — l'accueil
 * de la plateforme, l'inscription — n'en porte aucun.
 */
export async function visitedTenantSlug(): Promise<string | null> {
  const slug = (await headers()).get(TENANT_SLUG_HEADER);

  return slug === null || slug === '' ? null : slug;
}

/**
 * Vrai quand la page visitée est le **back-office** de l'établissement — #1326.
 *
 * Ce n'est pas une langue non plus, c'est ce qui décide de l'ordre des deux
 * dernières étapes : l'établissement passe alors avant l'`Accept-Language` du
 * navigateur (`resolve.ts`, « Les deux derniers signaux s'échangent sur le
 * back-office »).
 *
 * Le middleware efface cet en-tête de toute requête entrante avant de le reposer
 * depuis le chemin : sa valeur ne peut donc pas venir du client. Une comparaison
 * stricte plutôt qu'une présence — c'est ce qui laissera un autre espace se
 * nommer ici sans retourner le sens de celui-ci.
 */
export async function visitedAdminWorkspace(): Promise<boolean> {
  return (await headers()).get(TENANT_WORKSPACE_HEADER) === ADMIN_WORKSPACE;
}
