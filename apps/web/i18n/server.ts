import type { Locale } from '@spa/shared';

import { fetchPublicTenant } from '@/lib/api-client';

import { asLocale, negotiateLocale, resolveLocale } from './resolve';
import { requestLocaleSignals, visitedAdminWorkspace, visitedTenantSlug } from './signals';

/**
 * L'**ordre complet** de résolution de la langue sur la requête en cours —
 * #845, l'établissement compris.
 *
 * Trois modules s'y partagent le travail, et aucune des deux coupures n'est
 * décorative :
 *
 * - `resolve.ts` porte la **règle**, pure et testable sans serveur — les
 *   priorités de l'ordre sont ce qui doit être éprouvé, et un test qui doit
 *   monter une requête HTTP pour éprouver une priorité n'éprouve pas la
 *   priorité ;
 * - `signals.ts` porte la **lecture** des signaux de la requête, sans jamais
 *   appeler l'API — c'est la feuille, celle que le client d'API peut employer
 *   sans reboucler sur la résolution qui l'appelle (#1286) ;
 * - ce module ajoute la seule étape que ni l'une ni l'autre ne peut porter :
 *   `Tenant.defaultLocale`, qui coûte un appel réseau.
 */

/**
 * La langue de la requête en cours.
 *
 * ## Pourquoi l'établissement n'est consulté qu'en dernier recours
 *
 * Lire `Tenant.defaultLocale` demande un appel à `GET /public/{slug}`. Sur le
 * parcours public, il n'est fait que si les trois signaux qui le précèdent sont
 * muets — c'est-à-dire ni choix explicite, ni compte, ni `Accept-Language`
 * exploitable, ce qui est rare : tout navigateur envoie un `Accept-Language`. Et
 * quand il a lieu, il ne coûte presque rien : les gabarits du salon appellent
 * déjà `GET /public/{slug}` sur la même requête, et Next mémoïse les `fetch`
 * identiques le temps d'un rendu.
 *
 * Toute panne de cet appel — API éteinte, slug inconnu, réponse hors contrat —
 * se lit « l'établissement n'a rien dit » et laisse le signal suivant trancher.
 * Une page qui refuserait de s'afficher parce qu'elle n'a pas pu deviner sa
 * langue serait une panne de plus, pas une garantie.
 *
 * ## Sur le back-office, il est consulté avant le navigateur — #1326
 *
 * L'ordre des deux dernières étapes s'échange là : l'établissement y passe avant
 * l'`Accept-Language`, parce que le back-office est **son** espace de travail et
 * non celui de son visiteur. Le raisonnement complet est écrit dans `resolve.ts`,
 * auprès de la règle qu'il justifie.
 *
 * Le raccourci ci-dessous en tient compte, et c'est tout ce qui change ici : sur
 * le back-office, un `Accept-Language` exploitable ne dispense plus de l'appel —
 * il ne tranche qu'à défaut de langue déclarée par le salon. L'appel a donc lieu
 * à chaque page du back-office ouverte par quelqu'un qui n'a **pas** de
 * préférence enregistrée ; c'est le prix de la promesse du bloc « Ma langue », et
 * il est d'un `GET` public en regard du `GET /auth/me` que la coquille fait déjà.
 * Les deux premières étapes, elles, coupent toujours avant : un membre qui a
 * réglé sa langue, ou qui a cliqué sur le sélecteur, n'occasionne aucun appel.
 *
 * La valeur vient de l'API et d'aucune constante, et elle est propre au salon du
 * chemin : le slug est celui que le middleware a posé — jamais celui qu'une
 * requête aurait pu prétendre —, et `GET /public/{slug}` ne rend que ce qui est
 * public de **ce** salon (tenant-isolation §4).
 */
export async function requestLocale(): Promise<Locale> {
  // Les mêmes signaux que lit `refusalLocale()` du client d'API, lus par le même
  // module : c'est ce qui garantit qu'un refus se dit dans la langue de la page
  // qui le reçoit (#1286).
  const signals = await requestLocaleSignals();

  // Le raccourci n'est pas une optimisation prématurée : c'est ce qui garde
  // l'appel réseau hors du chemin des requêtes qui n'en ont pas besoin.
  if (asLocale(signals.explicit) !== null || asLocale(signals.account) !== null) {
    return resolveLocale(signals);
  }

  const tenantFirst = await visitedAdminWorkspace();

  if (!tenantFirst && negotiateLocale(signals.acceptLanguage) !== null) {
    return resolveLocale(signals);
  }

  const tenant = await tenantDefaultLocale(await visitedTenantSlug());

  return resolveLocale({ ...signals, tenant, tenantFirst });
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
  if (tenantSlug === null) {
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
