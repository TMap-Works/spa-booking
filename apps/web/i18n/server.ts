import type { Locale } from '@spa/shared';
import { cookies, headers } from 'next/headers';

import { fetchPublicTenant } from '@/lib/api-client';

import { ACCOUNT_LOCALE_COOKIE, LOCALE_COOKIE, TENANT_SLUG_HEADER } from './cookies';
import { asLocale, negotiateLocale, resolveLocale } from './resolve';

/**
 * La lecture des signaux de langue sur la requête en cours — #845.
 *
 * La **règle** est dans `resolve.ts`, pure et testable sans serveur ; ce module
 * n'est que la plomberie qui l'alimente. La séparation n'est pas décorative :
 * les priorités de l'ordre de résolution sont ce qui doit être éprouvé, et un
 * test qui doit monter une requête HTTP pour éprouver une priorité n'éprouve pas
 * la priorité.
 */

/**
 * La langue de la requête en cours.
 *
 * ## Pourquoi l'établissement n'est consulté qu'en dernier recours
 *
 * Lire `Tenant.defaultLocale` demande un appel à `GET /public/{slug}`. Il n'est
 * fait que si les trois signaux qui le précèdent sont muets — c'est-à-dire ni
 * choix explicite, ni compte, ni `Accept-Language` exploitable, ce qui est rare :
 * tout navigateur envoie un `Accept-Language`. Et quand il a lieu, il ne coûte
 * presque rien : les gabarits du salon appellent déjà `GET /public/{slug}` sur la
 * même requête, et Next mémoïse les `fetch` identiques le temps d'un rendu.
 *
 * Toute panne de cet appel — API éteinte, slug inconnu, réponse hors contrat —
 * se lit « l'établissement n'a rien dit » et laisse l'anglais trancher. Une page
 * qui refuserait de s'afficher parce qu'elle n'a pas pu deviner sa langue serait
 * une panne de plus, pas une garantie.
 */
export async function requestLocale(): Promise<Locale> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  const explicit = cookieStore.get(LOCALE_COOKIE)?.value ?? null;
  const account = cookieStore.get(ACCOUNT_LOCALE_COOKIE)?.value ?? null;
  const acceptLanguage = headerList.get('accept-language');

  // Le raccourci n'est pas une optimisation prématurée : c'est ce qui garde
  // l'appel réseau hors du chemin des requêtes qui n'en ont pas besoin.
  if (
    asLocale(explicit) !== null ||
    asLocale(account) !== null ||
    negotiateLocale(acceptLanguage) !== null
  ) {
    return resolveLocale({ explicit, account, acceptLanguage });
  }

  const tenant = await tenantDefaultLocale(headerList.get(TENANT_SLUG_HEADER));

  return resolveLocale({ explicit, account, acceptLanguage, tenant });
}

/**
 * La langue par défaut de l'établissement visité (#844), ou `null`.
 *
 * `null` couvre les quatre cas où il n'y a rien à lire : aucune page
 * d'établissement (l'accueil de la plateforme, l'inscription), un slug que l'API
 * ne connaît pas, une API injoignable, une réponse hors contrat. Aucun n'est une
 * erreur de la page en cours.
 */
async function tenantDefaultLocale(tenantSlug: string | null): Promise<string | null> {
  if (tenantSlug === null || tenantSlug === '') {
    return null;
  }

  try {
    return (await fetchPublicTenant(tenantSlug)).defaultLocale;
  } catch {
    // Un 404 est le cas ordinaire — le premier segment d'une URL n'est pas
    // toujours un salon. Les autres pannes ne valent pas mieux ici : dans les
    // deux cas, l'établissement n'a rien dit.
    return null;
  }
}
